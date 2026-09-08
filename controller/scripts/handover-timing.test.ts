// Pins show handover timing and ordering (#1576): settings.handover →
// broadcast/handover-policy.ts, with the outro window in broadcast/programme-pure.ts.
// The offset defaults to 5, so an upgrade is byte-identical; it must be a multiple
// of the talk row's stride, or the window is never sampled and the show stops
// signing off; and the release needs BOTH counters (a boundary alone releases at
// the start of the closing track, a declined opportunity alone releases inside
// the track the sign-off ducked).
// STATE_DIR is redirected before the first import, like talk-air.test.ts.
// broadcast/handover-policy.ts, with the outro window in

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
// COLD load: load() returns the in-process cache, so a missing field still passes.
const { setCache } = await import('../src/settings/store.js');


test('the offset defaults to 5, which is where the sign-off has always aired', async () => {
  await settings.load();
  assert.equal(handoverOffsetMinutes(), 5);
  assert.equal(beatWindow(55, handoverOffsetMinutes(), HANDOVER_OFFSET_STEP_MINUTES), 'outro', ':55 opens the outro, as it always did');
  assert.equal(beatWindow(59, handoverOffsetMinutes(), HANDOVER_OFFSET_STEP_MINUTES), 'outro');
  assert.equal(beatWindow(54, handoverOffsetMinutes(), HANDOVER_OFFSET_STEP_MINUTES), null);
  assert.equal(handoverStatus().offsetMinutes, 5);
});

test('the offset moves the outro window and is reversible', async () => {
  await settings.update({ handover: { offsetMinutes: 15 } } as never);
  assert.equal(handoverOffsetMinutes(), 15);
  assert.equal(beatWindow(45, 15, HANDOVER_OFFSET_STEP_MINUTES), 'outro', 'the sign-off now opens at :45');
  assert.equal(beatWindow(55, 15, HANDOVER_OFFSET_STEP_MINUTES), null, 'and :55 is quiet — the window MOVED, it did not widen');

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


test('the programme row samples every permitted offset exactly once, in every zone', () => {
  const row = talkSlot('programme', TALK_SLOTS);
  assert.equal(row.stride, HANDOVER_OFFSET_STEP_MINUTES,
    "the row's stride IS the setting's step — a second literal here is the bug");
  assert.equal(HANDOVER_OFFSET_BOUNDS.min % HANDOVER_OFFSET_STEP_MINUTES, 0);
  assert.equal(HANDOVER_OFFSET_BOUNDS.max % HANDOVER_OFFSET_STEP_MINUTES, 0);

  // Every accepted offset against every real IANA zone offset (multiples of 15
  // minutes). One sample inside the window, never zero.
  for (let off = HANDOVER_OFFSET_BOUNDS.min; off <= HANDOVER_OFFSET_BOUNDS.max; off += HANDOVER_OFFSET_STEP_MINUTES) {
    for (let zone = 0; zone < 60; zone += 15) {
      let hits = 0;
      for (let processMin = 0; processMin < 60; processMin += row.stride) {
        if (beatWindow((processMin + zone) % 60, off, HANDOVER_OFFSET_STEP_MINUTES) === 'outro') hits++;
      }
      assert.equal(hits, 1, `offset ${off}, zone +${zone}: exactly one tick lands in the outro window`);
    }
  }
});

test('the largest offset still leaves the feature beat alone', () => {
  for (let off = HANDOVER_OFFSET_BOUNDS.min; off <= HANDOVER_OFFSET_BOUNDS.max; off += HANDOVER_OFFSET_STEP_MINUTES) {
    for (let m = 35; m < 40; m++) {
      assert.equal(beatWindow(m, off, HANDOVER_OFFSET_STEP_MINUTES), 'feature', `offset ${off}: :${m} still belongs to the feature`);
    }
  }
});


test('no sign-off, no wait', () => {
  assert.equal(holdsForClosingTrack(null), false,
    'the common boundary — a mic-pass with no sign-off behind it — costs nothing');
});

// A stand-in for the queue's two counters. `ask()` is one handover OPPORTUNITY —
// a drain/boundary cycle that could itself have aired the incoming host's first
// words. `peek()` is the other kind of caller: the wall-clock :00 roll may HOLD
// on the answer but must not bank a decline.
function station() {
  let boundaries = 0;
  let held = 0;
  const peek = () =>
    holdsForClosingTrack({ boundariesSince: boundaries, heldOpportunities: held });
  return {
    trackStarts() { boundaries++; },
    peek,
    ask() {
      const hold = peek();
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

test('a wall-clock ask holds the intro without spending the closing track', () => {
  // The :00 session roll reaches the same standalone-intro path but is a cron
  // minute, not a handover moment: at the default offset the sign-off airs at :55
  // over track A and A is usually still playing at :00. Banking that answer
  // satisfies the opportunity half inside the very track the sign-off ducked.
  const s = station();
  assert.equal(s.peek(), true, ':00 — still inside track A, so the intro waits');
  assert.equal(s.peek(), true, 'and asking again changes nothing: peeking is free');
  s.trackStarts();                                   // closing track B begins
  assert.equal(s.ask(), true, 'B has only just started — the wall-clock ask bought nothing');
  s.trackStarts();                                   // B ends, C begins
  assert.equal(s.ask(), false, 'one WHOLE track later, exactly as with no cron ask at all');
});

test('the thresholds are the ones the rule is documented with', () => {
  assert.equal(HANDOVER_MIN_BOUNDARIES, 1);
  assert.equal(HANDOVER_MIN_HELD, 1);
  assert.deepEqual(handoverStatus().closingTrack, { boundaries: 1, held: 1 });
});


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
  q.noteHandoverOpportunityDeclined();
  assert.equal(q.closingTrackHolds(), false, 'and airs one track later');

  // A second sign-off restarts the wait rather than inheriting a satisfied one.
  q.noteHandoverSpeech('programme-outro');
  assert.equal(q.closingTrackHolds(), true);
  q._handover = null;
});


test('asking is free — only a declined OPPORTUNITY spends the closing track', async () => {
  const { queue: q } = await import('../src/broadcast/queue.js');
  q._handover = null;
  q.noteHandoverSpeech('programme-outro');

  // The wall-clock roll's shape: ask, hold, bank nothing. Repeated, because the
  // cron fires every hour and a station can sit through several with one show.
  for (let i = 0; i < 3; i++) {
    assert.equal(q.closingTrackHolds(), true, 'a cron ask inside the sign-off\'s track holds');
  }
  assert.equal(q._handover?.heldOpportunities, 0,
    'and banks nothing — closingTrackHolds() is a question, not a decision');

  q._trackStarts++;                                  // closing track begins
  assert.equal(q.closingTrackHolds(), true, 'the boundary alone must not release');
  q.noteHandoverOpportunityDeclined();               // the boundary path's own answer
  q._trackStarts++;
  assert.equal(q.closingTrackHolds(), false, 'released one whole track after the sign-off');
  q._handover = null;
});

test('a sign-off nobody ever answered does not defer a later mic-pass', async () => {
  // The leak: the two ask sites are a pending mic-pass and a programme intro, so an
  // hour that is neither answers at neither and the stamp sat there while boundaries
  // piled up. A changeover with no sign-off behind it must cost nothing.
  const { queue: q } = await import('../src/broadcast/queue.js');
  q._handover = null;
  q._lastSessionId = 'sess-a';

  q.noteHandoverSpeech('programme-outro');           // show A signs off at :55
  q.onSessionRolled('sess-b');                       // :00 — the roll it is owed to
  assert.equal(q.closingTrackHolds(), true, 'still owed across the roll it belongs to');

  q._trackStarts += 9;                               // an hour of music, nobody asks
  q.onSessionRolled('sess-c');                       // the NEXT hour rolls
  assert.equal(q._handover, null, 'the debt is owed to nobody and is dropped');
  assert.equal(q.closingTrackHolds(), false, "so show C's mic-pass is not deferred");
  assert.equal(q.handoverWait(), null, 'and /debug reads "missing", not "waiting"');
});

test('a repeated maybeRoll with no roll behind it does not age the wait', async () => {
  // maybeRoll returns the LIVE session when nothing rolled, so the no-op case must
  // be a no-op here too or a busy station ages the wait out.
  const { queue: q } = await import('../src/broadcast/queue.js');
  q._handover = null;
  q._lastSessionId = 'sess-a';

  q.noteHandoverSpeech('programme-outro');
  for (let i = 0; i < 5; i++) q.onSessionRolled('sess-a');
  assert.equal(q._handover?.rolledOnce, false, 'no roll happened, so nothing aged');
  assert.equal(q.closingTrackHolds(), true, 'and the wait still stands');
  q._handover = null;
});

test('the incoming host opening settles the debt', async () => {
  const { queue: q } = await import('../src/broadcast/queue.js');
  for (const opener of ['handoff', 'programme-intro']) {
    q._handover = null;
    q.noteHandoverSpeech('programme-outro');
    assert.notEqual(q.handoverWait(), null, 'a sign-off is outstanding');
    q.noteHandoverSpeech(opener);
    assert.equal(q._handover, null, `"${opener}" is the incoming host — the wait is over`);
  }
});

test('polling /debug never spends the wait', async () => {
  // handoverWait() is read by the admin /debug row, polled every couple of seconds,
  // so the question must be free: a side-effecting predicate would burn the one
  // required opportunity and release the incoming host a track early.
  const { queue: q } = await import('../src/broadcast/queue.js');
  q._handover = null;
  q.noteHandoverSpeech('programme-outro');

  for (let poll = 0; poll < 40; poll++) q.handoverWait();
  assert.equal(q._handover?.heldOpportunities, 0,
    '40 dashboard polls later the wait is exactly where the sign-off left it');
  assert.equal(q.closingTrackHolds(), true, 'and the incoming host still owes a closing track');
  q._handover = null;
});

test('/debug reads the live wait, not just the configured thresholds', async () => {
  const { queue: q } = await import('../src/broadcast/queue.js');
  q._handover = null;
  assert.equal(q.handoverWait(), null, 'no sign-off outstanding — an absent greeting is MISSING');

  q.noteHandoverSpeech('programme-outro');
  assert.deepEqual(q.handoverWait(), { boundariesSince: 0, heldOpportunities: 0, holding: true },
    'a sign-off outstanding — an absent greeting is WAITING, and for what');

  q._trackStarts++;
  q.noteHandoverOpportunityDeclined();
  assert.deepEqual(q.handoverWait(), { boundariesSince: 1, heldOpportunities: 1, holding: false },
    'both counters met — the next cycle opens the show');
  q._handover = null;
});


test('the largest permitted offset still clears the feature beat', () => {
  // HANDOVER_OFFSET_BOUNDS.max is justified by the feature window's literals in
  // programme-pure.ts, which cannot import the bound, so this test is the only
  // thing holding the two numbers together.
  // programme-pure.ts, but that file cannot import the bound (it stays
  for (let off = HANDOVER_OFFSET_BOUNDS.min; off <= HANDOVER_OFFSET_BOUNDS.max; off += HANDOVER_OFFSET_STEP_MINUTES) {
    for (let m = 0; m < 60; m++) {
      const w = beatWindow(m, off, HANDOVER_OFFSET_STEP_MINUTES);
      if (m >= 35 && m < 40) {
        assert.equal(w, 'feature', `offset ${off}: :${m} belongs to the feature, not the outro`);
      }
    }
  }
  // And the bound is the LARGEST such offset: one step further opens the outro on
  // the feature window, and the outro is tested first, so the beat silently stops.
  const tooFar = HANDOVER_OFFSET_BOUNDS.max + HANDOVER_OFFSET_STEP_MINUTES;
  assert.equal(60 - tooFar, 35, 'the next step up opens the outro exactly on the feature window');
  assert.equal(beatWindow(35, tooFar, HANDOVER_OFFSET_STEP_MINUTES), 'outro',
    'and the sign-off takes the minute, costing the show its feature');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
