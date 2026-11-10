// Pins skillCronAllowed() (broadcast/scheduler.ts) — the gate a per-skill cron
// timer checks before calling runCapability() directly.
//
// The bug: a cron-registered skill bypassed every station-wide autonomous-talk
// gate skillsTick applies (voice off, mid-programme, no listeners, over the
// daily token budget) — CLAUDE.md's carve-out for "manual /dj/segment command
// routes" is explicitly for an EXPLICIT OPERATOR ACTION, and a scheduled timer
// firing on its own is not one. Left ungated, a cron skill would still speak
// and spend tokens with `tts.enabled: false` set, past the daily LLM hard cap,
// with zero listeners, and mid-episode.
//
// skillCronAllowed() takes its four inputs as an explicit object rather than
// reading autoVoiceAllowed()/programme.onAir()/djCallsAllowed()/
// optionalSegmentsAllowed() itself, so the rule can be pinned here without
// needing to fake real settings/listener/budget/programme state — the same
// split as budgetMode({used, cap, softPct}) in dj-budget.ts.
//
// The same split pins the boundary claim added with #2259: with every segment
// placed between tracks, a cron fire has no slot-table row and therefore no
// pending-clip hold, so it must stand down before generating rather than
// displace a segment already waiting for the boundary.
//
// Run: `npm test -- skill-cron-gates`.

import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time — scheduler.ts
// pulls in modules (settings, queue, …) that derive paths from it at module scope.
process.env.STATE_DIR = createTempDir(join(tmpdir(), 'skill-cron-gates-'));

const { skillCronAllowed, skillCronStandDownReason, skillCronEligibility, skillCronTalkStandDownReason } =
  await import('../src/broadcast/scheduler.js');
const { PENDING_VOICE_MAX_AGE_MS } = await import('../src/broadcast/queue/kinds.js');

const ALL_OPEN = {
  voiceAllowed: true,
  programmeOnAir: false,
  djCallsAllowed: true,
  optionalSegmentsAllowed: true,
};

assert.equal(skillCronAllowed(ALL_OPEN), true, 'every gate open → cron is allowed to fire');

// Any single closed gate blocks the cron and names the operator's lever.
assert.equal(skillCronStandDownReason(ALL_OPEN), null, 'all gates open means no reason');
const gates: Array<[keyof typeof ALL_OPEN, string]> = [
  ['voiceAllowed', 'tts.enabled: false must stand the cron down'],
  ['programmeOnAir', 'a programme episode owns its talk moments'],
  ['djCallsAllowed', 'zero listeners must stand the cron down'],
  ['optionalSegmentsAllowed', 'the daily LLM hard cap must stand the cron down'],
];
const reasons = gates.map(([key, message]) => {
  const closed = { ...ALL_OPEN, [key]: key === 'programmeOnAir' };
  assert.equal(skillCronAllowed(closed), false, message);
  const reason = skillCronStandDownReason(closed);
  assert.ok(reason && reason.length > 8, `the reason for ${key} must be readable`);
  return reason;
});
assert.equal(new Set(reasons).size, reasons.length, 'each gate needs its own message');

const cohosted = { seeded: true, skill: 'case-discussion', cohosts: true };
const host = { skills: ['case-discussion'] };
assert.deepEqual(
  skillCronEligibility(cohosted, {}, host, [{}]),
  { allowed: true },
  'a co-hosted cron is eligible with a host-owned skill and an active guest',
);
assert.equal(
  skillCronEligibility(cohosted, {}, host, []).reason,
  'requires a co-hosted show',
  'a co-hosted cron stands down clearly on a solo show',
);
assert.deepEqual(
  skillCronEligibility({ ...cohosted, cohosts: false }, {}, host, []),
  { allowed: true },
  'ordinary skill crons keep working on solo shows',
);

// Between-tracks placement (#2259 review): a cron fire has no row, so the
// queue would otherwise drop the clip already waiting.
const now = 1_000_000_000;
const waiting = { kind: 'station-id', queuedAt: now - 1_000 };
assert.equal(
  skillCronTalkStandDownReason('news', 'immediate', null, waiting, now), null,
  'with the switch off, cron keeps its old immediate path — the pending slot is not involved',
);
assert.equal(
  skillCronTalkStandDownReason('news', 'next-track', null, null, now), null,
  'an empty boundary belongs to the fire',
);
assert.match(
  skillCronTalkStandDownReason('news', 'next-track', 'weather', null, now) ?? '',
  /weather/,
  'a second fire stands down while another skill generates',
);
assert.match(
  skillCronTalkStandDownReason('news', 'next-track', null, waiting, now) ?? '',
  /station-id/,
  'a waiting ident is not displaced by a skill',
);
assert.equal(
  skillCronTalkStandDownReason('handoff', 'next-track', null, waiting, now), null,
  'a handoff still takes the boundary by design',
);
assert.equal(
  skillCronTalkStandDownReason(
    'news', 'next-track', null, { ...waiting, queuedAt: now - PENDING_VOICE_MAX_AGE_MS - 1 }, now,
  ),
  null,
  'a clip past its age limit no longer holds the boundary',
);

console.log('skill-cron-gates.test.ts — all assertions passed');
