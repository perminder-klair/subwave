// Pins show handover timing and ordering (settings.handover →
// broadcast/handover-policy.ts, with the outro window in
// broadcast/programme-pure.ts), #1576.
//
// Four things are worth pinning, and the middle two are the ones that fail
// silently in production:
//
//  - THE UPGRADE IS BYTE-IDENTICAL. The offset defaults to 5, which puts the
//    outro window exactly where the hardcoded :55 put it, and every way of NOT
//    having the key — a settings.json written before it existed, a hand-edited
//    value — has to resolve to 5 as well.
//  - THE OFFSET AND THE TALK ROW'S STRIDE ARE THE SAME NUMBER. The outro is a
//    station-clock window that the talk table's programme row samples ONCE from
//    a fixed process minute. A window the stride cannot land inside is a show
//    that stops signing off, with nothing logged because nothing was due — so
//    the bound, the step and the row's `stride` are checked against each other
//    here, and every permitted offset is replayed against every real IANA zone
//    offset.
//  - THE ORDERING RULE NEEDS BOTH COUNTERS. A boundary alone releases at the
//    START of the closing track (eager drains); a declined opportunity alone
//    can release inside the track the sign-off ducked (pair-aware drains, which
//    ask ~120s before that track ends). Both drain modes are walked below.
//  - A SIGN-OFF IS WHAT THE LISTENER HEARD. The trigger is the aired kind, not
//    a scheduler fire.
//
// STATE_DIR is redirected before the first import, like talk-air.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-handover-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  handoverOffsetMinutes, handoverStatus, holdsForClosingTrack,
  HANDOVER_MIN_BOUNDARIES, HANDOVER_MIN_HELD,
} = await import('../src/broadcast/handover-policy.js');
const { beatWindow } = await import('../src/broadcast/programme-pure.js');
const { TALK_SLOTS, talkSlot } = await import('../src/broadcast/talk-scheduler.js');
const { HANDOVER_OFFSET_BOUNDS, HANDOVER_OFFSET_STEP_MINUTES } =
  await import('../src/schemas/settings.js');
// COLD load, not load(): load() returns the in-process cache untouched, so a
// field missing from its composition passes an in-process assertion and only
// vanishes on the next container start.
const { setCache } = await import('../src/settings/store.js');

// ---------------------------------------------------------------------------
// THE DIAL
// ---------------------------------------------------------------------------

test('the offset defaults to 5, which is where the sign-off has always aired', async () => {
  await settings.load();
  assert.equal(handoverOffsetMinutes(), 5);
  assert.equal(beatWindow(55, handoverOffsetMinutes()), 'outro', ':55 opens the outro, as it always did');
  assert.equal(beatWindow(59, handoverOffsetMinutes()), 'outro');
  assert.equal(beatWindow(54, handoverOffsetMinutes()), null);
  assert.equal(handoverStatus().offsetMinutes, 5);
});

test('the offset moves the outro window and is reversible', async () => {
  await settings.update({ handover: { offsetMinutes: 15 } } as never);
  assert.equal(handoverOffsetMinutes(), 15);
  assert.equal(beatWindow(45, 15), 'outro', 'the sign-off now opens at :45');
  assert.equal(beatWindow(55, 15), null, 'and :55 is quiet — the window MOVED, it did not widen');

  await settings.update({ handover: { offsetMinutes: 5 } } as never);
  assert.equal(handoverOffsetMinutes(), 5);
});

test('the save path refuses an offset the talk row could never sample', async () => {
  await settings.update({ handover: { offsetMinutes: 10 } } as never);

  // Off the stride: the window would open at :53 and close at :58, and a */5
  // process tick lands on neither :53 nor :57 in a zero-offset zone.
  await assert.rejects(
    () => settings.update({ handover: { offsetMinutes: 7 } } as never),
    /multiple of 5/,
  );
  // Below the floor: a window narrower than the stride can be stepped over
  // entirely, however it is aligned.
  await assert.rejects(
    () => settings.update({ handover: { offsetMinutes: 0 } } as never),
    /handover\.offsetMinutes must be int in \[5, 20\]/,
  );
  // Past the ceiling: :35 is the feature beat's own window.
  await assert.rejects(
    () => settings.update({ handover: { offsetMinutes: 25 } } as never),
    /handover\.offsetMinutes must be int in \[5, 20\]/,
  );
  assert.equal(handoverOffsetMinutes(), 10, 'every rejected write changed nothing');

  await settings.update({ handover: { offsetMinutes: 5 } } as never);
});

test('a settings.json without the key, or with junk in it, reads as the default', async () => {
  const path = join(root, 'settings.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));

  delete stored.handover;
  writeFileSync(path, JSON.stringify(stored));
  setCache(null);
  await settings.load();
  assert.equal(handoverOffsetMinutes(), 5, 'a pre-upgrade settings.json signs off at :55');

  // Repaired, not refused: load()'s input is a file an operator may have edited,
  // and each of these is an outro that would never air.
  for (const junk of [7, 0, 45, '10', null, NaN]) {
    stored.handover = { offsetMinutes: junk };
    writeFileSync(path, JSON.stringify(stored));
    setCache(null);
    await settings.load();
    assert.equal(handoverOffsetMinutes(), 5, `a stored ${String(junk)} coerces back to the default`);
  }
});

// ---------------------------------------------------------------------------
// THE DIAL AND THE TALK ROW ARE ONE NUMBER
// ---------------------------------------------------------------------------

test('the programme row samples every permitted offset exactly once, in every zone', () => {
  const row = talkSlot('programme', TALK_SLOTS);
  assert.equal(row.stride, HANDOVER_OFFSET_STEP_MINUTES,
    "the row's stride IS the setting's step — a second literal here is the bug");
  assert.equal(HANDOVER_OFFSET_BOUNDS.min % HANDOVER_OFFSET_STEP_MINUTES, 0);
  assert.equal(HANDOVER_OFFSET_BOUNDS.max % HANDOVER_OFFSET_STEP_MINUTES, 0);

  // Every offset the save path will accept, against every real IANA zone
  // offset (all multiples of 15 minutes). One sample inside the window, never
  // zero — zero is the silent failure this bound exists to prevent.
  for (let off = HANDOVER_OFFSET_BOUNDS.min; off <= HANDOVER_OFFSET_BOUNDS.max; off += HANDOVER_OFFSET_STEP_MINUTES) {
    for (let zone = 0; zone < 60; zone += 15) {
      let hits = 0;
      for (let processMin = 0; processMin < 60; processMin += row.stride) {
        if (beatWindow((processMin + zone) % 60, off) === 'outro') hits++;
      }
      assert.equal(hits, 1, `offset ${off}, zone +${zone}: exactly one tick lands in the outro window`);
    }
  }
});

test('the largest offset still leaves the feature beat alone', () => {
  for (let off = HANDOVER_OFFSET_BOUNDS.min; off <= HANDOVER_OFFSET_BOUNDS.max; off += HANDOVER_OFFSET_STEP_MINUTES) {
    for (let m = 35; m < 40; m++) {
      assert.equal(beatWindow(m, off), 'feature', `offset ${off}: :${m} still belongs to the feature`);
    }
  }
});

// ---------------------------------------------------------------------------
// THE ORDERING RULE
// ---------------------------------------------------------------------------

test('no sign-off, no wait', () => {
  assert.equal(holdsForClosingTrack(null), false,
    'the common boundary — a mic-pass with no sign-off behind it — costs nothing');
});

// A tiny stand-in for the queue's two counters, so the rule can be walked
// without a station. `ask()` is one handover opportunity: the mic-pass at a
// pick cycle, or the standalone programme intro at a session-settled hook.
function station() {
  let boundaries = 0;
  let held = 0;
  return {
    trackStarts() { boundaries++; },
    ask() {
      const hold = holdsForClosingTrack({ boundariesSince: boundaries, heldOpportunities: held });
      if (hold) held++;
      return hold;
    },
  };
}

test('eager drains: the intro waits past the START of the closing track', () => {
  // The sign-off airs over track A. The next boundary is where the CLOSING
  // track begins — airing there is the two-voices-back-to-back bug, so the ask
  // at that boundary must hold.
  const s = station();
  s.trackStarts();                                   // closing track B begins
  assert.equal(s.ask(), true, 'B has only just started — the listener has heard no music yet');
  s.trackStarts();                                   // B ends, C begins
  assert.equal(s.ask(), false, 'one whole track later, the incoming host opens');
});

test('pair-aware drains: the intro waits past the track the sign-off ducked', () => {
  // The deadline routine asks ~120s before the on-air track ends, which right
  // after a sign-off is still track A itself. No boundary has passed, so a
  // count of declined opportunities alone would be satisfied here and release
  // with no music between the voices at all.
  const s = station();
  assert.equal(s.ask(), true, 'still inside the track the sign-off aired over');
  s.trackStarts();                                   // closing track B begins
  assert.equal(s.ask(), false, "asked again near B's end — one whole track has played");
});

test('a repeated ask inside the sign-off\'s own track never releases early', () => {
  // A deadline retry (a failed pick re-entering the cycle) asks twice inside
  // track A. The declined-opportunity counter alone would be satisfied; the
  // boundary counter is what refuses.
  const s = station();
  assert.equal(s.ask(), true);
  assert.equal(s.ask(), true, 'a second ask in the same track is still the same track');
  s.trackStarts();
  assert.equal(s.ask(), false);
});

test('once released, the rule stays released', () => {
  const s = station();
  s.trackStarts();
  assert.equal(s.ask(), true);
  s.trackStarts();
  assert.equal(s.ask(), false);
  s.trackStarts();
  assert.equal(s.ask(), false, 'the hold is a one-track spacer, not a recurring gate');
});

test('the thresholds are the ones the rule is documented with', () => {
  assert.equal(HANDOVER_MIN_BOUNDARIES, 1);
  assert.equal(HANDOVER_MIN_HELD, 1);
  assert.deepEqual(handoverStatus().closingTrack, { boundaries: 1, held: 1 });
});

// ---------------------------------------------------------------------------
// THE TRIGGER IS WHAT AIRED
// ---------------------------------------------------------------------------

test('only a sign-off that reached the stream starts the wait', async () => {
  // The singleton, since the class is not exported — these two methods only
  // ever read and write their own two counters.
  const { queue: q } = await import('../src/broadcast/queue.js');

  assert.equal(q.closingTrackHolds(), false, 'a fresh station holds nothing');

  // Every other spoken kind passes through the same post-air hook.
  for (const kind of ['station-id', 'link', 'handoff', 'programme-intro', 'programme-feature']) {
    q.noteHandoverSpeech(kind);
    assert.equal(q.closingTrackHolds(), false, `"${kind}" is not a sign-off`);
  }

  q.noteHandoverSpeech('programme-outro');
  assert.equal(q.closingTrackHolds(), true, 'the sign-off aired — the incoming host owes a closing track');
  q._trackStarts++;
  assert.equal(q.closingTrackHolds(), false, 'and airs one track later');

  // A second sign-off restarts the wait rather than inheriting a satisfied one.
  q.noteHandoverSpeech('programme-outro');
  assert.equal(q.closingTrackHolds(), true);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
