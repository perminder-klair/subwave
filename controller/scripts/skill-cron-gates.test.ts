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
// Run: `tsx scripts/skill-cron-gates.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time — scheduler.ts
// pulls in modules (settings, queue, …) that derive paths from it at module scope.
process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'skill-cron-gates-'));

const { skillCronAllowed, skillCronStandDownReason, skillCronEligibility } = await import('../src/broadcast/scheduler.js');

const ALL_OPEN = {
  voiceAllowed: true,
  programmeOnAir: false,
  djCallsAllowed: true,
  optionalSegmentsAllowed: true,
};

assert.equal(skillCronAllowed(ALL_OPEN), true, 'every gate open → cron is allowed to fire');

assert.equal(
  skillCronAllowed({ ...ALL_OPEN, voiceAllowed: false }),
  false,
  'tts.enabled: false ("music only") must stand the cron down',
);
assert.equal(
  skillCronAllowed({ ...ALL_OPEN, programmeOnAir: true }),
  false,
  'a programme episode owns its talk moments — the cron must stand down mid-episode',
);
assert.equal(
  skillCronAllowed({ ...ALL_OPEN, djCallsAllowed: false }),
  false,
  'zero listeners must stand the cron down, same as every other autonomous tick',
);
assert.equal(
  skillCronAllowed({ ...ALL_OPEN, optionalSegmentsAllowed: false }),
  false,
  'over the daily LLM token budget must stand the cron down — no model call past the hard cap',
);

// Any single closed gate is enough — this is a strict AND, not a majority vote.
for (const key of Object.keys(ALL_OPEN) as Array<keyof typeof ALL_OPEN>) {
  const closed = { ...ALL_OPEN, [key]: key === 'programmeOnAir' };
  assert.equal(skillCronAllowed(closed), false, `closing "${key}" alone must block the cron`);
}

// Every closed gate names itself for the booth log. A registered cron that
// stands down silently is undiagnosable — verifying this PR, one sat mute for
// four ticks and the only way to learn why was to read listeners.ts.
assert.equal(skillCronStandDownReason(ALL_OPEN), null, 'all gates open → no reason');
for (const key of Object.keys(ALL_OPEN) as Array<keyof typeof ALL_OPEN>) {
  const closed = { ...ALL_OPEN, [key]: key === 'programmeOnAir' };
  const reason = skillCronStandDownReason(closed);
  assert.ok(reason, `closing "${key}" must produce a reason`);
  assert.ok(reason.length > 8, `the reason for "${key}" must be readable, got ${reason}`);
}

// The two stay in lockstep — allowed is defined as "no reason", so a gate added
// to one can never be forgotten in the other.
for (const key of Object.keys(ALL_OPEN) as Array<keyof typeof ALL_OPEN>) {
  const closed = { ...ALL_OPEN, [key]: key === 'programmeOnAir' };
  assert.equal(skillCronAllowed(closed), skillCronStandDownReason(closed) === null);
}

// Reasons are distinct, so the log tells the operator WHICH lever to move.
const reasons = (Object.keys(ALL_OPEN) as Array<keyof typeof ALL_OPEN>)
  .map((key) => skillCronStandDownReason({ ...ALL_OPEN, [key]: key === 'programmeOnAir' }));
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

console.log('skill-cron-gates.test.ts — all assertions passed');
