// Issue #1690: mirrors web/lib/sessionFeed.test.ts for the app's copy of the
// helpers. GET /session leads with the previous show's tail (meta.carried)
// and a `kind: 'show-boundary'` separator for a while after a hard roll.
// The listener-time hold (#1382) is pinned at the bottom.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_HOLD_MS,
  airedAtMs,
  isCarriedTurn,
  isShowBoundary,
  selectThinkingTurn,
  showBoundaryLabel,
  splitAudibleTurns,
  turnClass,
} from '../src/lib/sessionFeed.ts';
import type { SessionTurn } from '../src/lib/types.ts';

const boundary: SessionTurn = {
  t: '2026-10-07T20:00:00.000Z',
  role: 'event',
  kind: 'show-boundary',
  text: '22:00 · Midnight Bob’s Minor Incidents',
  meta: {
    boundary: {
      at: '2026-10-07T20:00:00.000Z',
      show: 'Midnight Bob’s Minor Incidents',
      persona: 'Mae',
      fromShow: 'Bob After Dark',
      fromSessionId: 'sess_prev',
    },
  },
};

const carriedVoice: SessionTurn = {
  t: '2026-10-07T19:58:00.000Z', role: 'segment', kind: 'link', text: 'Goodnight from Bob.',
  meta: { carried: true, carriedFrom: 'sess_prev', personaName: 'Bob' },
};

test('the show-boundary separator and carried turns are recognised', () => {
  assert.equal(isShowBoundary(boundary), true);
  assert.equal(isShowBoundary({ role: 'event', kind: 'scenario', text: 'Show begins.' }), false);
  assert.equal(isShowBoundary({ role: 'segment', kind: 'show-boundary', text: 'spoofed' }), false);
  assert.equal(isShowBoundary(null), false);

  assert.equal(isCarriedTurn(carriedVoice), true);
  assert.equal(isCarriedTurn({ ...carriedVoice, meta: { carried: 'yes' } }), false);
  assert.equal(isCarriedTurn({ role: 'segment', text: 'live' }), false);
  assert.equal(turnClass(boundary), 'system');
});

test('the separator label uses the client clock for the boundary, else the server text', () => {
  const clock = (at: string) => (at === '2026-10-07T20:00:00.000Z' ? '10:00 pm' : 'wrong');
  assert.equal(showBoundaryLabel(boundary, clock), '10:00 pm · Midnight Bob’s Minor Incidents');
  assert.equal(
    showBoundaryLabel({ ...boundary, meta: { boundary: { at: '2026-10-07T20:00:00.000Z', show: null, persona: 'Mae' } } }, clock),
    '10:00 pm · Mae',
  );
  assert.equal(showBoundaryLabel({ ...boundary, meta: {} }, clock), '22:00 · Midnight Bob’s Minor Incidents');
  assert.equal(showBoundaryLabel({ ...boundary, meta: { boundary: { at: 'garbage' } } }, clock),
    '22:00 · Midnight Bob’s Minor Incidents');
});

test('the thinking line never falls back to the outgoing show', () => {
  const feed: SessionTurn[] = [
    carriedVoice,
    { ...carriedVoice, role: 'dj', kind: 'pick', text: 'Bob picked this.', meta: { carried: true, trackId: 'tr_1' } },
    boundary,
    { t: '2026-10-07T20:00:01.000Z', role: 'event', kind: 'scenario', text: 'Show begins.' },
  ];
  assert.equal(selectThinkingTurn(feed, 'tr_1'), null);

  const live: SessionTurn = { t: '2026-10-07T20:01:00.000Z', role: 'segment', kind: 'link', text: 'Welcome in.' };
  assert.equal(selectThinkingTurn([...feed, live], 'tr_1'), live);
});

// #1382: a spoken turn stamped with meta.airedAt is held until the listener,
// sitting leadMs behind the live edge, can hear it.
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const aired = (offsetMs: number, text: string): SessionTurn => ({
  t: new Date(NOW + offsetMs).toISOString(),
  role: 'segment',
  kind: 'link',
  text,
  meta: { airedAt: new Date(NOW + offsetMs).toISOString() },
});

test('airedAtMs reads only a parseable string stamp', () => {
  assert.equal(airedAtMs(aired(0, 'x')), NOW);
  assert.equal(airedAtMs({ meta: { airedAt: NOW } }), null);
  assert.equal(airedAtMs({ meta: { airedAt: 'garbage' } }), null);
  assert.equal(airedAtMs({ role: 'segment' }), null);
  assert.equal(airedAtMs(null), null);
});

test('a stamped line is held until airedAt + lead, then shown', () => {
  const heard = aired(-30_000, 'Already heard.');
  const held = aired(-10_000, 'Still inside the buffer.');
  const unstamped: SessionTurn = { t: new Date(NOW).toISOString(), role: 'track', text: '▶ Song' };
  const feed = [heard, held, unstamped];

  const before = splitAudibleTurns(feed, 22_000, NOW);
  assert.deepEqual(before.visible, [heard, unstamped], 'unstamped turns are never held');
  assert.equal(before.nextChangeMs, NOW + 12_000);

  const after = splitAudibleTurns(feed, 22_000, NOW + 12_000);
  assert.deepEqual(after.visible, feed, 'shown at exactly airedAt + lead');
  assert.equal(after.nextChangeMs, null);
});

test('with no lead every line shows at once, and order is preserved', () => {
  const feed = [aired(-5_000, 'a'), aired(-1_000, 'b')];
  assert.deepEqual(splitAudibleTurns(feed, 0, NOW), { visible: feed, nextChangeMs: null });
  assert.deepEqual(splitAudibleTurns(feed, -5_000, NOW).visible, feed, 'a negative lead counts as 0');
});

test('the earliest pending line sets the next change', () => {
  const feed = [aired(-2_000, 'first'), aired(-8_000, 'out of order')];
  assert.equal(splitAudibleTurns(feed, 22_000, NOW).nextChangeMs, NOW + 14_000);
});

test('an implausibly future stamp fails towards shown, never hidden', () => {
  const skewed = aired(MAX_HOLD_MS + 1, 'clock skew');
  assert.deepEqual(splitAudibleTurns([skewed], 0, NOW), { visible: [skewed], nextChangeMs: null });
  const limit = aired(MAX_HOLD_MS, 'right at the bound');
  assert.deepEqual(splitAudibleTurns([limit], 0, NOW), { visible: [], nextChangeMs: NOW + MAX_HOLD_MS });
  assert.deepEqual(splitAudibleTurns(null, 22_000, NOW), { visible: [], nextChangeMs: null });
});
