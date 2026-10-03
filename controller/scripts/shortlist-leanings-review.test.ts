import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgenticLeaningsUsage } from '../src/broadcast/dj-agent/leanings-review.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(here, '../src/broadcast/dj-agent.ts'), 'utf8');
const debugSource = readFileSync(resolve(here, '../../web/components/admin/debug/LlmCalls.tsx'), 'utf8');
const pickStart = agentSource.indexOf('async function pickViaAgent');
const pickEnd = agentSource.indexOf('\nfunction speechClockContext', pickStart);
const picker = agentSource.slice(pickStart, pickEnd);

assert.ok(pickStart >= 0 && pickEnd > pickStart);
const baselineAt = picker.indexOf('shortlistPickResolution.preliminary =');
const reviewAt = picker.indexOf("kind: 'djShortlistLeaningsReview'");
const guardsAt = picker.indexOf('const guarded = await runArtistGuard');
const enqueueAt = picker.indexOf('const queued = await enqueuePick');
const settleAt = picker.indexOf('shortlistPickResolution.usedMusicalLeanings = resolveAgenticLeaningsUsage');
assert.ok(baselineAt >= 0 && baselineAt < reviewAt, 'Shortlist establishes a Leanings-blind baseline before review');
assert.ok(reviewAt < guardsAt, 'the reviewed choice must still pass the artist and album guards');
assert.ok(enqueueAt < settleAt, 'Shortlist provenance settles only after enqueue');
assert.match(picker, /telemetry: \{ shortlistResolution: shortlistPickResolution \}/,
  'initial, review and corrective calls share the controller resolution object');
assert.match(picker, /context: \{ \.\.\.shortlistContext, djName: reviewDjName, hostLeaningsOptions, guestLeaningsOptions \}/,
  'the compact review preserves host and weaker guest option provenance');
assert.match(picker, /library\.bpmKeyFor\(pickAnchor\)/,
  'Shortlist resolves the predecessor audio facts used to judge transition effects');
assert.match(picker, /queue\.recentTransitionChoices\(\)/,
  'Shortlist and its Leanings review receive the recent transition ledger');
assert.match(agentSource, /pickSystem\(showAt, playlistResolved, true, \{ host: null, guest: null, promptValue: null \}\)/,
  'Shortlist corrective choices remain Leanings-blind');
assert.doesNotMatch(debugSource, /JSON\.parse\(call\.response/,
  'Debug never revives a model self-report from the raw response');

assert.equal(resolveAgenticLeaningsUsage({
  hasLeanings: true, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'reviewed', queued: true,
}), true);
for (const state of [
  { hasLeanings: true, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'guard-repick', queued: true },
  { hasLeanings: true, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'reviewed', queued: false },
  { hasLeanings: false, preliminaryId: 'baseline', replacementId: 'reviewed', finalId: 'reviewed', queued: true },
]) {
  assert.equal(resolveAgenticLeaningsUsage(state), false, 'badge requires the exact reviewed replacement to survive and queue');
}

console.log('shortlist leanings review: final-result provenance verified');
