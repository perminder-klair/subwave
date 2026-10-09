// Ordering guards for the Track Shortlist route inside pickViaSelectionRoute.
// The Leanings review itself is pinned on behaviour in leanings-pass.test.ts;
// what can only be checked here is WHERE it runs: after a Leanings-blind
// baseline, before the station guards, with provenance settled after enqueue.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAgenticLeaningsUsage } from '../src/broadcast/dj-agent/leanings-review.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(here, '../src/broadcast/dj-agent.ts'), 'utf8');
const debugSource = readFileSync(resolve(here, '../../web/components/admin/debug/LlmCalls.tsx'), 'utf8');
const pickStart = agentSource.indexOf('async function pickViaSelectionRoute');
const pickEnd = agentSource.indexOf('\nfunction speechClockContext', pickStart);
const picker = agentSource.slice(pickStart, pickEnd);

test('the slice under test is the whole selection-route function', () => {
  assert.ok(pickStart >= 0, 'pickViaSelectionRoute must exist');
  assert.ok(pickEnd > pickStart, 'the end marker must be found, or every check below reads the rest of the file');
});

test('Shortlist reviews Leanings after its baseline and before the guards, settling after enqueue', () => {
  const baselineAt = picker.indexOf('shortlistPreliminaryId = String(song.id)');
  const reviewAt = picker.indexOf('await runLeaningsReview(');
  const guardsAt = picker.indexOf('await runArtistGuard');
  const enqueueAt = picker.indexOf('const queued = await enqueuePick');
  const settleAt = picker.indexOf('shortlistPickResolution.usedMusicalLeanings = resolveAgenticLeaningsUsage');
  for (const [name, at] of Object.entries({ baselineAt, reviewAt, guardsAt, enqueueAt, settleAt })) {
    assert.ok(at >= 0, `${name} marker must exist`);
  }
  assert.ok(baselineAt < reviewAt, 'Shortlist establishes a Leanings-blind baseline before review');
  assert.ok(reviewAt < guardsAt, 'the reviewed choice reaches the artist guard before enqueue');
  assert.ok(enqueueAt < settleAt, 'Shortlist provenance settles only after enqueue');
});

test('Shortlist shares its resolution, context and Leanings-blind corrections', () => {
  assert.match(picker, /episodeSource \? \{ kind: 'kept' \} : await runArtistGuard/,
    'episode-source tracks skip artist repeat rescue while other paths retain the guard');
  assert.match(picker, /telemetry: \{ shortlistResolution: shortlistPickResolution \}/,
    'initial, review and corrective calls share the controller resolution object');
  assert.match(picker, /library\.bpmKeyFor\(pickAnchor\)/,
    'Shortlist resolves the predecessor audio facts used to judge transition effects');
  assert.match(picker, /queue\.recentTransitionChoices\(\)/,
    'Shortlist and its Leanings review receive the recent transition ledger');
  assert.match(agentSource, /pickSystem\(showAt, playlistResolved, true, \{ host: null, guest: null, promptValue: null \}\)/,
    'Shortlist corrective choices remain Leanings-blind');
  assert.doesNotMatch(debugSource, /JSON\.parse\(call\.response/,
    'Debug never revives a model self-report from the raw response');
});

test('the Leanings badge needs the exact reviewed replacement to survive and queue', () => {
  assert.equal(resolveAgenticLeaningsUsage({
    hasLeanings: true, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'reviewed', queued: true,
  }), true);
  for (const state of [
    { hasLeanings: true, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'guard-repick', queued: true },
    { hasLeanings: true, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'reviewed', queued: false },
    { hasLeanings: false, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'reviewed', queued: true },
  ]) {
    assert.equal(resolveAgenticLeaningsUsage(state), false);
  }
});
