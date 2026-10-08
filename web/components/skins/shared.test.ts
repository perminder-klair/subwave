// Issue #1690: the skins' booth panes (TTY, Subamp, Unit, Drift, Platter) read
// GET /session through these derivations. After a hard roll the feed leads
// with the outgoing show's tail (meta.carried) and a show-boundary separator.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boothLines,
  foldBpm,
  isPowered,
  lastVoiceLine,
  listenPhase,
  speechMs,
  tuningStatus,
  voiceOnAirMs,
} from './shared';
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

test('a spoken line is timed from its word count, inside a link-sized clamp', () => {
  assert.equal(speechMs(''), 3_000);
  assert.equal(speechMs('Stay with me.'), 3_000);
  // 26 words at 2.6 words a second, plus the breath.
  assert.equal(speechMs(Array.from({ length: 26 }, () => 'word').join(' ')), 11_200);
  assert.equal(speechMs(Array.from({ length: 400 }, () => 'word').join(' ')), 45_000);
});

test('the latest line counts as on air only until it is history', () => {
  const now = Date.parse('2026-10-07T20:05:00.000Z');
  const text = 'That was Ostra, drifting in off the coast road. Here is something slower.';
  assert.equal(voiceOnAirMs(null, now), 0);
  // Fresh at the live edge, and still fresh with the listener a buffer behind it.
  assert.equal(voiceOnAirMs({ text, t: '2026-10-07T20:04:58.000Z' }, now), speechMs(text));
  assert.equal(voiceOnAirMs({ text, t: now - 50_000 }, now), speechMs(text));
  // Past the 60s buffer ceiling plus the line's own length: already heard.
  assert.equal(voiceOnAirMs({ text, t: now - 60_000 - speechMs(text) - 1 }, now), 0);
  // An unparseable stamp fails towards "on air" rather than hiding a live line.
  assert.equal(voiceOnAirMs({ text, t: 'not a date' }, now), speechMs(text));
});

test('the listen phase: off air beats everything, then the gate, then the lock', () => {
  assert.equal(listenPhase({ offline: true, tunedIn: true, status: 'playing' }), 'offline');
  assert.equal(listenPhase({ offline: false, tunedIn: false, status: 'playing' }), 'standby');
  assert.equal(listenPhase({ offline: false, tunedIn: true, status: 'connecting' }), 'connecting');
  assert.equal(listenPhase({ offline: false, tunedIn: true, status: 'playing' }), 'live');
  assert.deepEqual(
    (['offline', 'standby', 'connecting', 'live'] as const).map(isPowered),
    [false, false, true, true],
  );
  assert.equal(tuningStatus('live', false), 'tuned · locked');
  assert.equal(tuningStatus('live', true), 'tuned · muted');
  assert.equal(tuningStatus('connecting', true), 'tuning…');
});

test('a tempo folds by octaves into its band, never onto the edge', () => {
  assert.equal(foldBpm(120, 70, 150), 120);
  assert.equal(foldBpm(170, 70, 150), 85);
  assert.equal(foldBpm(50, 60, 150), 100);
  assert.equal(foldBpm(150, 60, 150), 150);
  assert.equal(foldBpm(null, 70, 150), 92);
  assert.equal(foldBpm(Infinity, 70, 150), 92);
  assert.equal(foldBpm(-4, 70, 150), 92);
});
