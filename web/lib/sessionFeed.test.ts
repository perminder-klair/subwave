// Issue #1690: GET /session leads with the outgoing show's tail (meta.carried)
// and a `kind: 'show-boundary'` separator for a while after a hard roll. The
// listener-facing selectors must recognise both, and must not surface the
// outgoing host's words as the incoming host's "thinking" line.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isCarriedTurn,
  isShowBoundary,
  selectThinkingTurn,
  showBoundaryLabel,
  turnClass,
} from './sessionFeed';
import type { SessionTurn } from './types';

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
  // Still a system turn by class: callers opt in to drawing it.
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
