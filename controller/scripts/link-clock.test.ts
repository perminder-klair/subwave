// Regression tests for the pick-attached link's spoken clock (#1314).
// Run: `npm test -- link-clock`.
//
// A link is written when the pick is MADE but airs when the pick STARTS, so the
// time it may speak is a forecast: `linkAirDate(showAt)` = now + whatever is
// left of the on-air track. #864 introduced the forecast (before it, links
// spoke generation time and aired a track late), #1282 removed a fixed +120s
// show-attribution padding that made every forecast run two minutes fast.
//
// What neither fixed: the forecast only holds if the pick reaches Liquidsoap
// before the on-air track ends. When the round outruns that, dj_queue is empty
// at the seam, auto.m3u fills the slot, and the pick airs at the END of the
// filler — with a link still naming the moment the filler STARTED. The old
// +120s overshoot had been masking that undershoot on average, which is why
// removing it surfaced as "the clock now runs minutes BEHIND air".
//
// Two pure guards close it, pinned here:
//
//  - linkClockAt      — refuses to hand out a clock at all when too little of
//                       the on-air track is left for the forecast to be worth
//                       anything. This is the prevention: measured over 788
//                       pick rounds, 27.7% ran longer than 45s of runway but
//                       only 0.3% longer than 120s, and the exposed population
//                       (maybeDeadlinePick's empty-queue backstop) always fires
//                       inside that window.
//  - linkClockDrifted — drops the line at air time when the seam landed too far
//                       from the forecast anyway. This is the backstop for the
//                       0.3% tail; the audio is already cut, so silence on one
//                       hand-off beats a wrong time, exactly the trade
//                       shouldDropStaleLink already makes for a wrong name.
//

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINK_CLOCK_DRIFT_TOLERANCE_SEC,
  LINK_CLOCK_MIN_RUNWAY_SEC,
  PICK_SHOW_LOOKAHEAD_SEC,
  boundaryCarriesTrackVoice,
  linkAirDate,
  linkClockAt,
  linkClockDrifted,
  linkClockStampFor,
} from '../src/broadcast/queue/pure.js';
import { DRAIN_DEADLINE_SEC, HARD_DEADLINE_SEC } from '../src/broadcast/drain-policy.js';

// The showAt a pick cycle builds for a given lead: `now + leadSec + padding`.
function showAtFor(nowMs: number, leadSec: number) {
  return new Date(nowMs + (leadSec + PICK_SHOW_LOOKAHEAD_SEC) * 1000);
}

const NOW = Date.parse('2026-08-04T17:38:00.000Z');

test('no look-ahead → no clock, unchanged from #864', () => {
  assert.equal(linkClockAt(null, NOW), null);
  assert.equal(linkClockAt(undefined, NOW), null);
});

test('a full track of runway keeps its clock, and it is the AIR moment', () => {
  const lead = 240;
  const at = linkClockAt(showAtFor(NOW, lead), NOW);
  assert.ok(at, 'expected a clock with 4 minutes of runway');
  // Exactly linkAirDate's answer — the padding is inverted, not re-added.
  assert.equal(at!.getTime(), NOW + lead * 1000);
  assert.equal(at!.getTime(), linkAirDate(showAtFor(NOW, lead)).getTime());
});

test('the floor is the drain deadline — the endgame window never speaks', () => {
  assert.equal(LINK_CLOCK_MIN_RUNWAY_SEC, DRAIN_DEADLINE_SEC);
  // maybeDeadlinePick fires across [HARD_DEADLINE_SEC, DRAIN_DEADLINE_SEC).
  // Every lead in that window must come back clockless — that is the whole
  // population the issue was reported from.
  for (let lead = HARD_DEADLINE_SEC; lead < DRAIN_DEADLINE_SEC; lead += 5) {
    assert.equal(linkClockAt(showAtFor(NOW, lead), NOW), null, `lead=${lead}s`);
  }
});

test('exactly at the floor speaks; one second under does not', () => {
  assert.ok(linkClockAt(showAtFor(NOW, LINK_CLOCK_MIN_RUNWAY_SEC), NOW));
  assert.equal(linkClockAt(showAtFor(NOW, LINK_CLOCK_MIN_RUNWAY_SEC - 1), NOW), null);
});

test('runway is measured LIVE, so a slow pick call can spend it', () => {
  const showAt = showAtFor(NOW, 240);
  // Same showAt, asked 2.5 minutes later (the pool path writes its link after
  // the pick call has returned): only 90s of runway is left, so no clock.
  assert.ok(linkClockAt(showAt, NOW), 'fresh');
  assert.equal(linkClockAt(showAt, NOW + 150_000), null, 'after a 150s round');
});

test('a forecast already in the past never speaks', () => {
  assert.equal(linkClockAt(showAtFor(NOW, 0), NOW + 60_000), null);
});

test('no stamp → never dropped (the link named no time)', () => {
  for (const bad of [null, undefined, NaN, Infinity, '123'] as any[]) {
    assert.equal(linkClockDrifted(bad, NOW), false, `stamp=${String(bad)}`);
  }
});

test('airing on schedule is not drift', () => {
  assert.equal(linkClockDrifted(NOW, NOW), false);
  assert.equal(linkClockDrifted(NOW, NOW + LINK_CLOCK_DRIFT_TOLERANCE_SEC * 1000), false);
});

test('structural slack stays inside tolerance', () => {
  // Crossfade start (12s early) + a jingle (15s late) + the listener buffer
  // (22s) is the worst honest case; it must not cost a link.
  assert.equal(linkClockDrifted(NOW, NOW - 12_000), false, 'seam fired early');
  assert.equal(linkClockDrifted(NOW, NOW + 37_000), false, 'jingle + buffer');
});

test('a missed slot filled by an auto track is dropped', () => {
  // The reported case: forecast 18:38, aired 18:41:47.
  const aired = NOW + (3 * 60 + 47) * 1000;
  assert.equal(linkClockDrifted(NOW, aired), true);
});

test('drift is absolute — an early seam is just as wrong', () => {
  assert.equal(linkClockDrifted(NOW, NOW - 4 * 60_000), true);
});

// The stamp is the only thing standing between "a link written under a clock
// ban" and the drift guard above, which cannot tell the difference — it sees a
// number or it sees nothing. Both pick paths reach one enqueuePick from code
// 170 lines apart, so this is where they are made to agree.
const AIR = new Date(NOW + 4 * 60_000);

test('a clock the model was offered is stamped', () => {
  assert.equal(linkClockStampFor(AIR, true), AIR);
});

test('a forecastable air moment the model was NOT offered is not stamped', () => {
  // The station clock switch (djSpeakClock: false) and, on the agent path, a
  // context carrying no clock at all. The link named no time, so it must not
  // be droppable for naming the wrong one.
  assert.equal(linkClockStampFor(AIR, false), null);
});

test('no forecast is never stamped, offered or not', () => {
  for (const airAt of [null, undefined] as const) {
    assert.equal(linkClockStampFor(airAt, true), null, `airAt=${String(airAt)}, offered`);
    assert.equal(linkClockStampFor(airAt, false), null, `airAt=${String(airAt)}, banned`);
  }
});

test('a withheld stamp survives the drift guard at any distance', () => {
  // The property the two halves exist to produce, asserted end to end rather
  // than as two independent facts: a banned clock cannot cost the link.
  const banned = linkClockStampFor(AIR, false);
  for (const aired of [NOW, NOW + 4 * 60_000, NOW + 40 * 60_000, NOW - 40 * 60_000]) {
    assert.equal(linkClockDrifted(banned?.getTime() ?? null, aired), false, `aired=${aired}`);
  }
  // ...while the same seam DOES drop the link when a clock really was offered,
  // so the case above can't pass by the guard being toothless.
  const offered = linkClockStampFor(AIR, true);
  assert.equal(linkClockDrifted(offered?.getTime() ?? null, NOW + 40 * 60_000), true);
});

const PREV = { id: 't-prev', title: 'Previous Track' };

test('a good link still owns the boundary, so the ident waits', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: "here's something new", introKind: 'link', linkClockAt: NOW },
      PREV,
      { nowMs: NOW + 10_000 },
    ),
    true,
  );
});

test('a link about to be dropped for drift frees the boundary for the ident', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: "here's something new", introKind: 'link', linkClockAt: NOW },
      PREV,
      { nowMs: NOW + 4 * 60_000 },
    ),
    false,
  );
});

test('without nowMs the rule assumes the clock is good (existing callers)', () => {
  assert.equal(
    boundaryCarriesTrackVoice(
      { introScript: "here's something new", introKind: 'link', linkClockAt: NOW },
      PREV,
    ),
    true,
  );
});
