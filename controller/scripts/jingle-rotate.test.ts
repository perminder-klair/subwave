// The automatic jingle rotate, moved out of Liquidsoap and into the controller
// (#1619).
//
// Three things are being pinned here, and they are different KINDS of claim.
//
//   1. THE UPGRADE. `an upgraded station must not lose its jingles or get them
//      twice` is the issue's hard rule, and with the controller and broadcast
//      images upgrading independently the only shape that satisfies it in both
//      skew directions is the opt-in setting (broadcast/jingle-rotate.ts states
//      the argument). So: absent the key, the mixer handoff file is written
//      exactly what it was written before and the controller's row never fires.
//      Asserted over a COLD LOAD, because a key missing from load()'s
//      composition still works for the rest of the process and then silently
//      vanishes — the failure controller/CLAUDE.md says has already bitten
//      twice.
//   2. THE COUNT. Every N track boundaries, one jingle, with the offer SPENT
//      whether or not a clip could be drawn — which is what radio.liq's own
//      `source.available` gate did ("skipping a jingle is the cheaper miss").
//   3. THE ROW. The rotate is a fill row in the talk table, so one talker per
//      minute now covers it: the segment director cannot speak on the minute a
//      jingle takes, the jingle stands down for a scheduled segment, and a
//      clip already rendered and waiting for a boundary holds it.
//
// Run: npx tsx scripts/jingle-rotate.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TalkKind, TalkPlan } from '../src/broadcast/talk-scheduler.js';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-jingle-rotate-'));

const {
  jingleRotateOwner,
  mixerJingleRatioFile,
  rotateJingleDue,
  pickRotateJingle,
  jingleRotateStatus,
} = await import('../src/broadcast/jingle-rotate.js');
const { jingleRotateSchema } = await import('../src/schemas/settings.js');
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { LIQ_JINGLE_RATIO_PATH, writeLiquidsoapSettings } =
  await import('../src/settings/liquidsoap.js');
const { TALK_SLOTS, talkSlot, talkTickPlan } =
  await import('../src/broadcast/talk-scheduler.js');

// ---------------------------------------------------------------------------
// 1. THE UPGRADE — absent or malformed is the pre-existing station
// ---------------------------------------------------------------------------

test('an absent key reads as the mixer, so an upgrade changes nothing', () => {
  assert.equal(jingleRotateOwner({}), 'mixer');
  assert.equal(jingleRotateOwner(null), 'mixer');
  assert.equal(jingleRotateOwner(undefined), 'mixer');
  // The handoff file the mixer reads is the operator's ratio, byte for byte.
  assert.equal(mixerJingleRatioFile({ jingleRatio: 30 }), '30');
  // And the controller's own row is not merely quiet, it is never due.
  assert.equal(rotateJingleDue({ owner: 'mixer', ratio: 30, tracksSinceJingle: 900 }), false);
});

test('a hand-edited settings.json cannot half-enable the rotate', () => {
  // The dangerous direction is a value that is neither owner: read as
  // 'controller' it would write the mixer's ratio 0 AND leave the row gated on
  // a resolver that disagrees — the two rotates cannot be allowed to disagree
  // about who is counting, so anything unrecognised is the mixer.
  for (const bad of ['Controller', 'liquidsoap', '', 0, 1, true, null, {}, []]) {
    assert.equal(jingleRotateOwner({ jingleRotate: bad }), 'mixer', `accepted ${String(bad)}`);
  }
  // A PATCH is refused rather than repaired — the strict posture the two
  // switches beside it carry.
  assert.equal(jingleRotateSchema.safeParse('Controller').success, false);
  assert.equal(jingleRotateSchema.safeParse('mixer').success, true);
  assert.equal(jingleRotateSchema.safeParse('controller').success, true);
});

test('the key survives a COLD LOAD in both directions', async () => {
  // The three-edits rule (controller/CLAUDE.md): a field missing from load()'s
  // composition validates, saves and works until the next restart, then
  // silently reverts. An in-process assertion passes on that broken code, so
  // this drops the cache and reads settings.json back off disk.
  const fresh = await (async () => { setCache(null); return settings.load(); })();
  assert.equal(fresh.jingleRotate, 'mixer', 'the default is the pre-existing station');

  await settings.update({ jingleRotate: 'controller' });
  setCache(null);
  assert.equal((await settings.load()).jingleRotate, 'controller');

  await settings.update({ jingleRotate: 'mixer' });
  setCache(null);
  assert.equal((await settings.load()).jingleRotate, 'mixer');
});

test('handing the rotate over writes the mixer a 0, and leaves the ratio alone', async () => {
  await settings.update({ jingleRatio: 30, jingleRotate: 'mixer' });
  await writeLiquidsoapSettings(await settings.load());
  assert.equal(readFileSync(LIQ_JINGLE_RATIO_PATH, 'utf8'), '30');

  const saved = (await settings.update({ jingleRotate: 'controller' })).saved;
  await writeLiquidsoapSettings(await settings.load());
  // 0 is #997's own "jingles off" value, which is why radio.liq needs no change.
  assert.equal(readFileSync(LIQ_JINGLE_RATIO_PATH, 'utf8'), '0');
  // The operator's "1 every N tracks" figure is untouched — it is exactly what
  // the controller's counter now reads, so the two sides cannot drift.
  assert.equal(saved.jingleRatio, 30);
  assert.equal(mixerJingleRatioFile({ jingleRatio: 30, jingleRotate: 'controller' }), '0');
});

test('the mixer branch writes what it has always written, malformed included', () => {
  // load() cannot produce these, but the handoff file is the mixer's only
  // input and the degrade path matters: an unparseable value makes radio.liq
  // keep its own default, where a numeric coercion to 0 would silence the
  // jingles outright. So the mixer branch stays a verbatim String().
  for (const ratio of [30, 0, 1000]) {
    assert.equal(mixerJingleRatioFile({ jingleRatio: ratio }), String(ratio));
  }
  assert.equal(mixerJingleRatioFile({}), 'undefined');
  assert.equal(mixerJingleRatioFile({ jingleRatio: 'oops' }), 'oops');
  // …and the controller branch is 0 whatever the ratio says, because the ratio
  // is now the CONTROLLER's count.
  assert.equal(mixerJingleRatioFile({ jingleRatio: 'oops', jingleRotate: 'controller' }), '0');
});

test('changing who counts is a restart, like changing the count itself', async () => {
  await settings.update({ jingleRotate: 'mixer' });
  const r = await settings.update({ jingleRotate: 'controller' });
  assert.equal(r.requiresRestart, true, 'the ratio file is read once at mixer startup');
  // Re-saving the same owner moves nothing, so a save of something else in the
  // same panel cannot drag the mixer down with it.
  assert.equal((await settings.update({ jingleRotate: 'controller' })).requiresRestart, false);
});

// ---------------------------------------------------------------------------
// 2. THE COUNT
// ---------------------------------------------------------------------------

test('one jingle every N track boundaries, and 0 still means off', () => {
  const due = (tracksSinceJingle: number, ratio = 4) =>
    rotateJingleDue({ owner: 'controller', ratio, tracksSinceJingle });
  assert.equal(due(0), false);
  assert.equal(due(3), false);
  assert.equal(due(4), true);
  // Overshoot: a due rotate that yielded the minute keeps counting boundaries
  // while it waits, so the test is `>=` and not `===` — otherwise a single
  // contested minute would silence the rotate until the counter wrapped.
  assert.equal(due(9), true);
  // ratio 0 is jingles OFF whichever side is counting (#997).
  assert.equal(rotateJingleDue({ owner: 'controller', ratio: 0, tracksSinceJingle: 999 }), false);
});

test('the draw is random but never the same stinger twice running', () => {
  const lib = ['a.wav', 'b.wav', 'c.wav'];
  // Every draw excludes the last one aired while the library has an
  // alternative — the one thing playlist(mode="randomize") gave for free.
  for (const r of [0, 0.34, 0.67, 0.99]) {
    assert.notEqual(pickRotateJingle(lib, 'b.wav', () => r), 'b.wav');
  }
  // A one-jingle library still draws it: no-repeat is a preference, and a
  // station with one ident must still get that ident.
  assert.equal(pickRotateJingle(['only.wav'], 'only.wav', () => 0.5), 'only.wav');
  // An empty library draws nothing — the caller logs and spends the offer.
  assert.equal(pickRotateJingle([], null), null);
  // The top of the range must not fall off the end.
  assert.equal(pickRotateJingle(lib, null, () => 0.999999), 'c.wav');
});

test('the debug row reports the mixer ratio it intended AND the one on disk', () => {
  assert.deepEqual(jingleRotateStatus({ jingleRatio: 30, jingleRotate: 'mixer' }, 7, '30'), {
    owner: 'mixer',
    ratio: 30,
    mixerRatioIntended: '30',
    mixerRatioOnDisk: '30',
    mixerRatioMatches: true,
    tracksSinceJingle: null,
  });
  assert.deepEqual(jingleRotateStatus({ jingleRatio: 30, jingleRotate: 'controller' }, 7, '0'), {
    owner: 'controller',
    ratio: 30,
    mixerRatioIntended: '0',
    mixerRatioOnDisk: '0',
    mixerRatioMatches: true,
    tracksSinceJingle: 7,
  });
});

// The state the single-figure row could not see, and the reason it is two
// figures now: ensureLiquidsoapSettingsFile() only writes a handoff file that is
// MISSING, so hand-editing `jingleRotate: 'controller'` into settings.json and
// restarting the controller leaves the mixer booting on the old ratio. Both
// sides then count, and a row that computed its own answer from settings would
// report the 0 it wished for.
test('a handoff file that never got the 0 is visible, not asserted away', () => {
  const row = jingleRotateStatus({ jingleRatio: 30, jingleRotate: 'controller' }, 7, '30');
  assert.equal(row.mixerRatioIntended, '0');
  assert.equal(row.mixerRatioOnDisk, '30', 'the verbatim bytes, not a recomputation');
  assert.equal(row.mixerRatioMatches, false, 'this is the "why am I hearing two" answer');
});

test('an unreadable handoff file reports null, never a guess', () => {
  const row = jingleRotateStatus({ jingleRatio: 30, jingleRotate: 'controller' }, 7, null);
  assert.equal(row.mixerRatioOnDisk, null);
  // null rather than false: "we could not check" and "we checked and it
  // disagrees" are different operator instructions, and the file is legitimately
  // absent on a station that has never saved settings.
  assert.equal(row.mixerRatioMatches, null);
  // Omitting the argument entirely is the same claim.
  assert.equal(jingleRotateStatus({ jingleRatio: 30 }, 0).mixerRatioMatches, null);
});

// ---------------------------------------------------------------------------
// 3. THE ROW — one talker per minute now covers the jingle
// ---------------------------------------------------------------------------

const HOUR = 9;
const at = (minute: number) => new Date(2026, 7, 19, HOUR, minute, 0);

// The planner, driven the way scheduler.talkTick drives it.
function plan(p: {
  minute: number;
  eligible: (k: TalkKind) => boolean;
  lastTalkBreakAt?: number;
  pendingTalk?: { kind: string; queuedAt: number } | null;
  betweenTracksOnly?: boolean;
}): TalkPlan[] {
  return talkTickPlan({
    now: at(p.minute),
    lastTalkBreakAt: p.lastTalkBreakAt ?? 0,
    pendingTalk: p.pendingTalk ?? null,
    betweenTracksOnly: p.betweenTracksOnly ?? false,
    eligible: p.eligible,
    externalSlot: () => null,
    fired: {},
    logged: {},
  });
}
const firing = (plans: TalkPlan[]) => plans.filter(p => p.act === 'fire').map(p => p.kind);

test('the rotate is a FILL row, and the table says why', () => {
  const row = talkSlot('jingle');
  // Not a slot: its due-ness is a COUNT that keeps counting while it waits, so
  // it has no scheduled chance to lose. A slot row here would suppress the
  // segment director on every minute the jingle merely waited, and would log
  // `missed` about a chance that was never lost.
  assert.equal(row.role, 'fill');
  assert.equal(row.opens, 'any');
  assert.equal(row.stride, 1);
  // Last by the table's own principle: among rows that can retry, fewer
  // remaining chances outranks more. The director is offered twelve minutes an
  // hour, this row sixty.
  assert.ok(row.priority > talkSlot('segment').priority);
  assert.equal(row.priority, Math.max(...TALK_SLOTS.map(r => r.priority)));
  // It airs the HANDOFF immediately; Liquidsoap's jingle_now_queue places the
  // clip at the next safe boundary, which is not the controller deferring.
  assert.equal(row.air, 'immediate');
});

test('a jingle takes the minute, and the segment director stands down for it', () => {
  // Both fill rows want :10 (a minute no slot row's window reaches).
  const plans = plan({ minute: 10, eligible: k => k === 'segment' || k === 'jingle' });
  assert.deepEqual(firing(plans), ['segment'], 'the director outranks the rotate');
  const held = plans.find(p => p.kind === 'jingle');
  assert.equal(held?.act, 'wait');
  assert.equal(held?.act === 'wait' && held.reason.held, 'yield');
  // Standing down is silent for a fill row: a jingle a minute late is not an
  // event, where a scheduled segment quietly not happening is.
  assert.equal(held?.act === 'wait' && held.log, null);

  // With the director not asking, the rotate takes the same minute — and it is
  // the only talker on it, which is the whole point of the move.
  const alone = plan({ minute: 10, eligible: k => k === 'jingle' });
  assert.deepEqual(firing(alone), ['jingle']);
});

test('a scheduled segment takes the seam from the rotate, not the other way round', () => {
  // :15 is the ident's chance. A slot row wanting the minute means the fill
  // rows are never even asked — gate before generation, applied to arbitration.
  const asked: TalkKind[] = [];
  const plans = plan({ minute: 15, eligible: k => { asked.push(k); return true; } });
  assert.deepEqual(firing(plans), ['station-id']);
  assert.ok(!asked.includes('jingle'), 'a contested minute never reaches the rotate');
  // And it is not lost: the counter has not moved, so the next free minute is
  // the rotate's. :10 is the nearest one no slot window reaches.
  assert.deepEqual(firing(plan({ minute: 10, eligible: k => k === 'jingle' })), ['jingle']);
});

test('the rotate waits three minutes behind a break that has just aired', () => {
  const nowMs = at(10).getTime();
  const eligible = (k: TalkKind) => k === 'jingle';
  // A stinger on the back of a segment that has just finished is #310 in its
  // other clothes, so the row carries the short segments' quiet gap.
  assert.equal(talkSlot('jingle').minGapMs, 3 * 60_000);
  const held = plan({ minute: 10, eligible, lastTalkBreakAt: nowMs - 60_000 })[0];
  assert.equal(held.act, 'wait');
  assert.equal(held.act === 'wait' && held.reason.held, 'gap');
  assert.deepEqual(
    firing(plan({ minute: 10, eligible, lastTalkBreakAt: nowMs - 4 * 60_000 })),
    ['jingle'],
  );
});

test('a rendered clip waiting for a boundary holds the rotate, unbounded', () => {
  const nowMs = at(10).getTime();
  const eligible = (k: TalkKind) => k === 'jingle';
  const pendingTalk = { kind: 'station-id', queuedAt: nowMs - 30_000 };
  // This is the collision the issue is actually about: an ident rendered and
  // queued for the next track boundary is talk getLastTalkBreakAt() cannot
  // see, and it is heading for the very seam the stinger would take.
  const held = plan({ minute: 10, eligible, pendingTalk })[0];
  assert.equal(held.act, 'wait');
  assert.equal(held.act === 'wait' && held.reason.held, 'pending');
  // The hold is UNBOUNDED for this row, where #1539 bounds it for a row with a
  // finite window. A jingle held all minute loses nothing — the next tick is
  // another chance — and the bounded form would read as "never held at all",
  // since every minute is its own one-minute window.
  for (const minute of [11, 12, 25]) {
    assert.equal(plan({ minute, eligible, pendingTalk })[0].act, 'wait', `:${minute}`);
  }
  // Unbounded by the ROW, not by the clip: the queue's own stale life
  // (PENDING_VOICE_MAX_AGE_MS) still ends the hold, which is what stops a clip
  // that will never air holding the rotate forever.
  assert.deepEqual(firing(plan({ minute: 45, eligible, pendingTalk })), ['jingle']);
  // And once the clip has aired, the seam is free again.
  assert.deepEqual(firing(plan({ minute: 11, eligible })), ['jingle']);
});

test('the pending hold reaches the rotate without moving any other row', () => {
  // The generalisation that lets a jingle be held is guarded on `minGapMs > 0`,
  // so the ONE other 'any' row — the segment director, which has opted out of
  // quiet questions entirely — keeps its pre-existing behaviour.
  const nowMs = at(10).getTime();
  const pendingTalk = { kind: 'station-id', queuedAt: nowMs - 30_000 };
  assert.equal(talkSlot('segment').minGapMs, 0);
  assert.deepEqual(
    firing(plan({ minute: 10, eligible: k => k === 'segment', pendingTalk })),
    ['segment'],
    'the director still ignores a pending clip',
  );
});

test('djTalkOnlyBetweenTracks holds the rotate too', () => {
  // With the switch on, a waiting clip is a RESOURCE rather than a courtesy —
  // and a stinger handed over now would land on the boundary that clip is
  // waiting for. The row defers with everything else.
  const nowMs = at(10).getTime();
  const plans = plan({
    minute: 10,
    eligible: k => k === 'jingle',
    pendingTalk: { kind: 'segment', queuedAt: nowMs - 30_000 },
    betweenTracksOnly: true,
  });
  assert.equal(plans[0].act, 'wait');
  assert.equal(plans[0].act === 'wait' && plans[0].reason.held, 'pending');
});
