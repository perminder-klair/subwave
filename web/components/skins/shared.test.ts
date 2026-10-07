// Issue #1690: the skins' booth panes (TTY, Subamp, Unit, Drift, Platter) read
// GET /session through these derivations. After a hard roll the feed leads
// with the outgoing show's tail (meta.carried) and a show-boundary separator.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boothLines, lastVoiceLine } from './shared';
import type { SessionTurn } from '@/lib/types';

const feed: SessionTurn[] = [
  {
    t: '2026-10-07T19:57:00.000Z', role: 'segment', kind: 'link', text: 'Goodnight from Bob.',
    meta: { carried: true, carriedFrom: 'sess_prev', personaName: 'Bob' },
  },
  {
    t: '2026-10-07T19:58:00.000Z', role: 'dj', kind: 'pick', text: 'Something to close on.',
    meta: { carried: true, carriedFrom: 'sess_prev', personaName: 'Bob' },
  },
  {
    t: '2026-10-07T19:59:00.000Z', role: 'track', kind: 'play', text: '▶ Last Song',
    meta: { carried: true, carriedFrom: 'sess_prev' },
  },
  {
    t: '2026-10-07T20:00:00.000Z', role: 'event', kind: 'show-boundary',
    text: '22:00 · Midnight Bob’s Minor Incidents',
    meta: { boundary: { at: '2026-10-07T20:00:00.000Z', show: 'Midnight Bob’s Minor Incidents' } },
  },
  { t: '2026-10-07T20:00:01.000Z', role: 'event', kind: 'scenario', text: 'Show begins.', meta: {} },
];

test('booth lines flag carried turns with their speaker and keep the boundary as a marked line', () => {
  assert.deepEqual(boothLines(feed, 24), [
    { text: 'Goodnight from Bob.', t: '2026-10-07T19:57:00.000Z', kind: 'voice', carried: true, speaker: 'Bob' },
    { text: 'Something to close on.', t: '2026-10-07T19:58:00.000Z', kind: 'dj', carried: true, speaker: 'Bob' },
    { text: '22:00 · Midnight Bob’s Minor Incidents', t: '2026-10-07T20:00:00.000Z', kind: 'system', boundary: true },
    { text: 'Show begins.', t: '2026-10-07T20:00:01.000Z', kind: 'system' },
  ]);
});

test('live lines carry no carry flags, so the old line shape is unchanged', () => {
  const live: SessionTurn[] = [
    { t: '1', role: 'segment', kind: 'link', text: 'Welcome in.', meta: { personaName: 'Mae' } },
  ];
  assert.deepEqual(boothLines(live, 24), [{ text: 'Welcome in.', t: '1', kind: 'voice' }]);
});

test("the last spoken line is the live show's, never the outgoing host's", () => {
  assert.equal(lastVoiceLine(feed), null);
  const live: SessionTurn = { t: '2026-10-07T20:02:00.000Z', role: 'segment', kind: 'link', text: 'Welcome in.' };
  assert.deepEqual(lastVoiceLine([...feed, live]), { text: 'Welcome in.', t: live.t, kind: 'voice' });
});
