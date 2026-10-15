// Tests for music/analyze-capability.ts — whether an analysis pass widens its
// scope to backfill an optional dimension, and what it says when it doesn't.
// Tracks missing only an audio vector take embedding-only work; baseline,
// vocal and stem scopes retain full analysis.
//
// This is the decision behind the loudest half of #1300 bug 3. The reported
// symptom was "audio backfill: +90 already-analysed tracks missing an audio
// vector", the same 90 tracks every run forever, on a heavy analyzer whose CLAP
// weights could not be downloaded. Two separate defects met there:
//
//   1. The backend reported `capable: true` no matter what, because the probe
//      behind it is find_spec — "is torch installed" — evaluated at ready,
//      before any model has been asked to load. Fixed at the source (the worker
//      reports the loss, the sidecar remembers it across the idle respawn that
//      was resetting it), and what arrives here is the corrected answer.
//   2. When the answer IS false, the message assumed exactly one cause and told
//      the operator to switch to the heavy image — advice to do the thing they
//      had already done. That is what this module fixes, and why the messages
//      are asserted rather than just the booleans: the string is the entire
//      user-facing product of a broken analyzer.
// Run: `tsx scripts/analyze-capability.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisModeForTrack,
  backfillDecision,
  failureCountsAgainstTrack,
  SYSTEMIC_FAILURE_RUN,
} from '../src/music/analyze-capability.js';

test('a dimension the operator has not enabled says nothing at all', () => {
  const d = backfillDecision({ dimension: 'audio', wanted: false, capable: true, error: null });
  assert.equal(d.widen, false);
  assert.equal(d.notice, null);
  // Even when the backend is broken — an operator who hasn't asked for
  // sounds-like doesn't need a warning about it in their tagging log.
  const off = backfillDecision({
    dimension: 'audio', wanted: false, capable: false, error: 'no weights',
  });
  assert.equal(off.notice, null);
});

test('a capable backend widens silently', () => {
  const d = backfillDecision({ dimension: 'audio', wanted: true, capable: true, error: null });
  assert.equal(d.widen, true);
  assert.equal(d.notice, null);
});

test('an UNKNOWN capability still widens — null is not a no', () => {
  // A local venv that hasn't been probed, or a sidecar too old to advertise.
  // Treating null as "can't" would silently stop backfilling on every older
  // deployment; the pass simply produces no vector and the track stays in scope.
  const d = backfillDecision({ dimension: 'vocal', wanted: true, capable: null, error: null });
  assert.equal(d.widen, true);
  assert.equal(d.notice, null);
});

test('a lean image is told to get the heavy one', () => {
  const d = backfillDecision({ dimension: 'audio', wanted: true, capable: false, error: null });
  assert.equal(d.widen, false);
  assert.match(d.notice!, /built without CLAP/);
  assert.match(d.notice!, /ANALYZER_HEAVY=1/);
});

test('a FAILED LOAD is told the truth instead, and never told to switch image', () => {
  const d = backfillDecision({
    dimension: 'audio',
    wanted: true,
    capable: false,
    error: 'model weights could not be downloaded: [Errno 111] Connection refused',
  });
  assert.equal(d.widen, false, 'a broken model must not widen — that is the churn');
  // The reason reaches the operator verbatim. Without it the two false cases
  // are indistinguishable from outside the container.
  assert.match(d.notice!, /Connection refused/);
  assert.match(d.notice!, /failed to load/);
  // The load-failure branch must NOT carry the lean-image advice: everyone
  // hitting it is already on the heavy image, and sending them to switch is
  // what turned a diagnosable fault into an unexplained loop.
  assert.ok(!/ANALYZER_HEAVY/.test(d.notice!), 'load failure repeats the lean-image advice');
  assert.ok(!/built without/.test(d.notice!));
  // And it says how to retry, because the latch is deliberately sticky.
  assert.match(d.notice!, /restart the analyzer/);
});

test('the vocal dimension names Demucs, not CLAP', () => {
  const lean = backfillDecision({ dimension: 'vocal', wanted: true, capable: false, error: null });
  assert.match(lean.notice!, /built without Demucs/);
  const broken = backfillDecision({
    dimension: 'vocal', wanted: true, capable: false, error: 'checkpoint is corrupt',
  });
  assert.match(broken.notice!, /Demucs is installed but failed to load/);
  assert.match(broken.notice!, /checkpoint is corrupt/);
});

test('the stem dimension gets the same split, not the old dead-end advice', () => {
  // The stem cache rides Demucs, so a failed Demucs load reaches it on the same
  // `capable: false` a lean image does. It was the one widening still hard-coded
  // to "use the heavy analyzer image" — advice to do the thing already done, in
  // the widening the rest of this module exists to stop doing that in.
  const lean = backfillDecision({ dimension: 'stem', wanted: true, capable: false, error: null });
  assert.match(lean.notice!, /^stem backfill skipped/);
  assert.match(lean.notice!, /built without Demucs/);
  const broken = backfillDecision({
    dimension: 'stem', wanted: true, capable: false, error: 'checkpoint is corrupt',
  });
  assert.match(broken.notice!, /Demucs is installed but failed to load/);
  assert.match(broken.notice!, /checkpoint is corrupt/);
  assert.ok(!/ANALYZER_HEAVY/.test(broken.notice!), 'stem load failure repeats the lean-image advice');
});

test('the retry names a process that exists on THIS deployment', () => {
  // The latch is sticky on purpose, so the retry sentence is the whole exit
  // route — and it is not the same process everywhere. A sidecar remembers the
  // failure in the analyzer container. A local/AIO install has no analyzer
  // container at all: the worker is a child of the controller and the latch is
  // controller module state, so `docker compose restart analyzer` is a no-op or
  // an error there. Sending an AIO operator to it is the same dead end as
  // sending a heavy-image operator to the heavy image.
  const args = { dimension: 'audio', wanted: true, capable: false, error: 'no weights' } as const;
  const sidecar = backfillDecision({ ...args, backend: 'sidecar' });
  assert.match(sidecar.notice!, /docker compose restart analyzer/);

  const local = backfillDecision({ ...args, backend: 'local' });
  assert.match(local.notice!, /restart the controller/);
  assert.ok(
    !/docker compose restart analyzer/.test(local.notice!),
    'local backend told to restart a container it does not have',
  );

  // Unknown backend gets wording that covers both rather than guessing.
  const unknown = backfillDecision(args);
  assert.match(unknown.notice!, /restart the analyzer/);
  assert.match(unknown.notice!, /controller/);
});

test('a scattered bad file is counted on its first failure', () => {
  // The whole point of the per-track stamp: one throw on a corrupt file, with
  // healthy tracks either side, is evidence about that file.
  assert.equal(failureCountsAgainstTrack(1), true);
  assert.equal(failureCountsAgainstTrack(SYSTEMIC_FAILURE_RUN), true);
});

test('a run of failures stops counting — that is the pass, not the files', () => {
  // Navidrome gone, or the sidecar dying at track 400 of 500. isAvailable()
  // gates the pass on the ANALYZER being up and on nothing else, so every
  // remaining track throws; counted naively, three such passes sentence a whole
  // batch to the exclusion list with only a manual "Retry all" to undo it.
  assert.equal(failureCountsAgainstTrack(SYSTEMIC_FAILURE_RUN + 1), false);
  assert.equal(failureCountsAgainstTrack(500), false);
});

test('an already-current track missing only its sounds-like vector uses embedding-only work', () => {
  assert.equal(analysisModeForTrack('audio-only', new Set(['stale', 'vocal', 'stems']), true), 'embedding-only');
});

test('baseline, vocal, and stem scopes retain full acoustic analysis', () => {
  const full = new Set(['stale', 'vocal', 'stems']);
  for (const id of full) assert.equal(analysisModeForTrack(id, full, true), 'full', id);
  assert.equal(analysisModeForTrack('ordinary', full, false), 'full');
});
