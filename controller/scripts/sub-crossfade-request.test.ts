// A listener request the MIXER eats whole (#1594).
//
// `cross(duration=d)` buffers d seconds of the outgoing track before it can
// hand over, so a source item whose entire playable span is under d never
// reaches the output — it leaves dj_queue without airing and without an error.
// Measured while testing #1582 with an 18s crossfade and a 15s stinger, and
// written up in liquidsoap/CLAUDE.md beside the crossfade rule.
//
// The controller cannot observe that happening. proto_subhttp's outcome is a
// curl verdict at RESOLUTION time — a 15s file downloads fine and is stamped
// `ready` — so queue.verifyPushResolved marks the handoff healthy and the
// outcome channel has nothing to say; the reconcile sweep later logs an
// unattributed "dropped N stale queue item(s)". The listener therefore gets a
// silent no with nothing in the booth log naming their request, which is the
// only thing this change fixes: it logs, it does not decline.
//
// Three things regress here, and each one fails silently in production:
//
//  - The SPAN IS THE TRIMMED SPAN. A 20s clip carrying 8s of dead air is 12.5s
//    on air, and the tagged duration reads it as safely over an 18s crossfade.
//    Measuring the tag is the whole bug in miniature — it clears every track
//    the buffer actually eats.
//  - The DISCRIMINATOR IS `requestedBy`. An autonomous pick is not this bug:
//    the controller owns length rules there, and a warning on every short
//    library track is noise the operator learns to ignore.
//  - NOTHING IS DECLINED. Requests are exempt from maxTrackSeconds and from
//    picker.minTrackLengthSeconds because an explicit ask is not a pick. A
//    warning that started refusing would be a change to what the station
//    promises a listener, made in a log line's clothing. That includes
//    FAILING: resolving the span is the first sqlite read on the request
//    critical path, and a throw there would turn a listener request into a 500.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-sub-crossfade-'));
process.env.STATE_DIR = stateRoot;

// An 18s crossfade — the figure the failure was measured at. minGapMs is well
// under the gaps below, so the trim is live for every track here.
writeFileSync(
  path.join(stateRoot, 'settings.json'),
  JSON.stringify({ crossfadeDuration: 18, silenceTrim: { enabled: true, minGapMs: 1_500 } }),
);

const settings = await import('../src/settings.js');
await settings.load();

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { playableSpanSec, resolveSilenceTrim } = await import('../src/music/silence-trim.js');
const { swallowedByCrossfade } = await import('../src/util/request-guard.js');
const { queue } = await import('../src/broadcast/queue.js');

await library.load();

// Neutralise push()'s real side effects, exactly as scripts/request-dedup.test.ts
// does: persist() debounces a JSON write and drainToLiquidsoap() renders TTS and
// writes the handoff file Liquidsoap polls. Neither is part of this contract and
// both would touch disk or block on a poll timeout in a bare test process.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

// A 20-second stinger with 4s of digital silence at each end. The tagged
// duration (20) clears an 18s crossfade; the PLAYABLE span does not.
//   lead: 4000ms - 250ms margin      = 3.75s  cue_in
//   tail: measured end 20s - 3.75s   = 16.25s cue_out
//   span: 16.25 - 3.75               = 12.5s
const STINGER = {
  id: 'stinger', title: 'Station Sting', artist: 'Imaging',
  duration: 20, leadSilenceMs: 4_000, tailSilenceMs: 4_000, tailStartMs: 16_000,
};

// A full record, comfortably clear of the buffer at both readings.
const RECORD = {
  id: 'record', title: 'Long Record', artist: 'A Band',
  duration: 240, leadSilenceMs: 4_000, tailSilenceMs: 4_000, tailStartMs: 236_000,
};

function reset() {
  queue.upcoming = [];
  queue.current = null;
  queue.djLog = [];
}

// The booth-log lines this change writes, newest first.
function crossfadeLines(): string[] {
  return queue.djLog.filter((e: any) => e.kind === 'crossfade').map((e: any) => e.message);
}

test('the predicate answers the buffer question, and only that', () => {
  assert.equal(swallowedByCrossfade(15, 18), true, 'the measured failure: 15s under an 18s buffer');
  assert.equal(swallowedByCrossfade(20, 18), false);

  // EQUAL is not swallowed. A span of exactly d is entirely crossfade material,
  // which is a different claim from silence, and the boundary is the one case
  // nobody has measured — so it is not asserted as a failure.
  assert.equal(swallowedByCrossfade(18, 18), false, 'exactly the buffer must not be claimed as silent');

  // Both unknowns answer false. This drives an operator warning; one fired on a
  // missing duration is a warning nobody can act on.
  assert.equal(swallowedByCrossfade(null, 18), false);
  assert.equal(swallowedByCrossfade(undefined, 18), false);
  assert.equal(swallowedByCrossfade(NaN, 18), false);
  assert.equal(swallowedByCrossfade(0, 18), false);
  assert.equal(swallowedByCrossfade(15, null), false);

  // A crossfade of 0 — the setting's own floor — is no buffer at all, so
  // nothing is eaten however short the track.
  assert.equal(swallowedByCrossfade(2, 0), false, 'no crossfade, nothing to swallow');
});

test('the playable span is the TRIMMED span, not the tagged duration', () => {
  assert.equal(playableSpanSec(STINGER), 12.5);
  // The reading this replaces. If these two ever agree, the trim has stopped
  // being consulted and every dead-air-padded clip reads as safe.
  assert.notEqual(playableSpanSec(STINGER), STINGER.duration);
  assert.equal(playableSpanSec(RECORD), 232.5);
});

test('the span reads the same end the cue_out was derived from', () => {
  // A tail gap UNDER the operator's min-gap dial (1.5s here) earns no cue_out,
  // so the span falls back to the end reference — and that reference is the
  // analyzer's decoded end, not the container tag, exactly as the cue_out
  // arithmetic prefers it. Two answers for "how long is this track" is how the
  // module drifts against itself.
  //
  // Decoded end = 30.8s (tailStart 30_000 + tail 800). Tag says 34s, which is
  // the disagreement being pinned. cue_in = 4000 - 250 margin = 3.75s.
  const tagLies = {
    id: 'tag-lies', title: 'Tag Lies', artist: 'X',
    duration: 34, leadSilenceMs: 4_000, tailSilenceMs: 800, tailStartMs: 30_000,
  };
  assert.equal(resolveSilenceTrim(tagLies).cueOutSec, null, 'the sub-dial tail earns no cue_out');
  assert.equal(playableSpanSec(tagLies), 27.05, 'the decoded end, not the 34s tag');
});

test('an untrimmed track spans its whole tagged duration', () => {
  // No measurements and no library row → nothing to trim, so the file plays
  // whole. Absent input must coerce to today's behaviour, not to zero.
  assert.equal(playableSpanSec({ id: 'unmeasured', title: 'X', artist: 'Y', duration: 45 }), 45);
});

test('an unknown length yields null, never zero', () => {
  // Null is "no answer" and the predicate refuses to act on it. A zero here
  // would read as a 0-second track and warn on every unanalysed request.
  assert.equal(playableSpanSec({ id: 'nothing', title: 'X', artist: 'Y' }), null);
  assert.equal(playableSpanSec(null), null);
});

test('the span resolves through library.get for the shape real callers pass', () => {
  // The projection IS the feature (see scripts/silence-trim-library.test.ts): a
  // Subsonic song carries a duration and no measurements at all, so a column
  // missing from library.get()'s field list would silently disable this — the
  // span would read as the untrimmed 20s and clear the buffer.
  db.upsertTrackMeta('db-stinger', {
    title: 'DB Sting', artist: 'Imaging', album: 'Imaging', duration: 20,
  } as never);
  db.upsertTrackAnalysis('db-stinger', {
    bpm: 120, key: 'C', introMs: 0, confidence: 1,
    leadSilenceMs: 4_000, tailSilenceMs: 4_000, tailStartMs: 16_000,
  });
  assert.equal(playableSpanSec({ id: 'db-stinger', duration: 20 }), 12.5);
});

test('a sub-crossfade REQUEST gets a booth-log line naming the requester', async () => {
  reset();
  const pos = await queue.push({ track: { ...STINGER }, requestedBy: 'ada' });

  const lines = crossfadeLines();
  assert.equal(lines.length, 1, 'the operator learns nothing otherwise — the mixer drop is invisible');
  assert.match(lines[0], /Station Sting/);
  assert.match(lines[0], /ada/, 'the line must name the request, or it cannot be matched to one');
  assert.match(lines[0], /13s|12s/, 'the line must quote the playable span, not the tagged 20s');
  assert.match(lines[0], /18s crossfade/);

  // NOTHING IS DECLINED. The listener's ask is still queued exactly as before.
  assert.equal(pos, 1, 'the request must still queue — this is a log line, not a gate');
  assert.equal(queue.upcoming.length, 1);
  assert.equal(queue.upcoming[0].track.id, 'stinger');
});

test('an AUTONOMOUS pick of the same track is not warned about', async () => {
  reset();
  await queue.push({ track: { ...STINGER }, aiPicked: true });
  assert.deepEqual(crossfadeLines(), [], 'requestedBy is the discriminator, not track length');
});

test('a full-length request is not warned about', async () => {
  reset();
  await queue.push({ track: { ...RECORD }, requestedBy: 'ada' });
  assert.deepEqual(crossfadeLines(), []);
});

test('a request whose length is unknown is not warned about', async () => {
  reset();
  await queue.push({ track: { id: 'mystery', title: 'Mystery', artist: 'Nobody' }, requestedBy: 'ada' });
  assert.deepEqual(crossfadeLines(), [], 'an unmeasured request must fail toward silence, not toward a false alarm');
});

test('a THROW while resolving the span still queues the request', async () => {
  reset();
  // The span resolves through library.get → db.getTrack, which is the first
  // sqlite read push() makes — everything before it (the blocklist hit, the
  // dedup scan) is in-memory, and library.get guards `!loaded` but not a DB
  // error. Raising from the track's own duration getter puts the throw inside
  // that same resolution without reaching into a frozen module namespace.
  const cursed: any = { id: 'cursed', title: 'Cursed', artist: 'X' };
  Object.defineProperty(cursed, 'duration', {
    enumerable: true,
    get() { throw new Error('library.db is unreadable'); },
  });

  const pos = await queue.push({ track: cursed, requestedBy: 'ada' });
  assert.equal(pos, 1, 'an informational warning may never decide the request\'s fate');
  assert.equal(queue.upcoming.length, 1);
  assert.deepEqual(crossfadeLines(), [], 'and it stays silent rather than half-warning');
});

test('no crossfade configured → no warning, however short the request', async () => {
  reset();
  await settings.update({ crossfadeDuration: 0 });
  try {
    await queue.push({ track: { ...STINGER }, requestedBy: 'ada' });
    assert.deepEqual(crossfadeLines(), [], 'a zero buffer eats nothing');
  } finally {
    await settings.update({ crossfadeDuration: 18 });
  }
});
