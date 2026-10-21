// The OS lock screen's "DJ on the mic" avatar swap (useMediaSession). The
// window opens when the listener HEARS a line — its live-edge stamp plus their
// buffer (#1114/#1382) — and lasts the clip's length. Counted from the stamp
// alone for 15s, it closed before a word was heard under the default 22s
// buffer. Mirrors app/scripts/voice-turn.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVoiceTurn, lineMs, speechMs, talkingState } from './sessionFeed';
import type { SessionTurn } from './types';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const LEAD = 22_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
// Ten words → round(10 / 2.6 * 1000) + 1200 = 5046ms.
const TEN_WORDS = 'one two three four five six seven eight nine ten';
const TEN_WORDS_MS = 5_046;

const line = (airedOffsetMs: number, text = TEN_WORDS, extra: Partial<SessionTurn> = {}): SessionTurn => ({
  t: iso(airedOffsetMs + 200),
  role: 'segment',
  kind: 'link',
  text,
  meta: { airedAt: iso(airedOffsetMs) },
  ...extra,
});

test('speechMs estimates broadcast pace and clamps to 3–45s', () => {
  assert.equal(speechMs(TEN_WORDS), TEN_WORDS_MS);
  assert.equal(speechMs(''), 3_000);
  assert.equal(speechMs(Array(500).fill('word').join(' ')), 45_000);
});

test('lineMs prefers the measured clip length, else the estimate', () => {
  assert.equal(lineMs(line(0, TEN_WORDS, { meta: { durationMs: 12_345 } })), 12_345);
  for (const bad of [0, -1, Number.NaN, '9000', 16 * 60_000, null]) {
    assert.equal(lineMs(line(0, TEN_WORDS, { meta: { durationMs: bad } })), TEN_WORDS_MS, String(bad));
  }
});

test('voice turns are recognised by kind or role', () => {
  assert.equal(isVoiceTurn({ role: 'segment', kind: 'handoff' }), true);
  assert.equal(isVoiceTurn({ role: 'event', kind: 'station-id' }), true);
  assert.equal(isVoiceTurn({ role: 'track', kind: 'track' }), false);
  assert.equal(isVoiceTurn({ role: 'event', kind: 'show-boundary' }), false);
  assert.equal(isVoiceTurn(undefined), false);
});

test('a line inside the buffer is not talking yet, and schedules its start', () => {
  assert.deepEqual(talkingState([line(-5_000)], LEAD, NOW), { talking: false, nextChangeMs: NOW - 5_000 + LEAD });
});

test('the window runs from airedAt + lead for the clip', () => {
  const measured = line(-LEAD, TEN_WORDS, { meta: { airedAt: iso(-LEAD), durationMs: 20_000 } });
  assert.deepEqual(talkingState([measured], LEAD, NOW), { talking: true, nextChangeMs: NOW + 20_000 });
  assert.equal(talkingState([measured], LEAD, NOW + 19_999).talking, true);
  assert.equal(talkingState([measured], LEAD, NOW + 20_000).talking, false);
  assert.deepEqual(talkingState([line(-LEAD)], LEAD, NOW), { talking: true, nextChangeMs: NOW + TEN_WORDS_MS });
});

test('the old 15s-from-the-stamp window would have closed before the voice was heard', () => {
  const state = talkingState([line(-16_000)], LEAD, NOW);
  assert.deepEqual(state, { talking: false, nextChangeMs: NOW + 6_000 });
  assert.equal(talkingState([line(-16_000)], LEAD, NOW + 6_000).talking, true);
});

test('an unstamped turn falls back to `t`, still shifted by the lead', () => {
  const unstamped: SessionTurn = { t: iso(-LEAD), role: 'segment', kind: 'link', text: TEN_WORDS };
  assert.equal(talkingState([unstamped], LEAD, NOW).talking, true);
  assert.equal(talkingState([{ ...unstamped, t: 'garbage' }], LEAD, NOW).talking, false);
});

test('a later buffered line does not hide the one being heard', () => {
  const heard: SessionTurn = { t: iso(-LEAD - 1_000), role: 'segment', kind: 'link', text: TEN_WORDS };
  const next: SessionTurn = { t: iso(-LEAD + 3_000), role: 'segment', kind: 'link', text: TEN_WORDS };
  assert.deepEqual(talkingState([heard, next], LEAD, NOW), { talking: true, nextChangeMs: NOW + 3_000 });
});

test('a finished line with a pending one behind it is not talking', () => {
  assert.deepEqual(talkingState([line(-LEAD - 10_000), line(-5_000)], LEAD, NOW), {
    talking: false,
    nextChangeMs: NOW - 5_000 + LEAD,
  });
});

test('carried turns, skewed stamps and empty feeds are idle', () => {
  const carried = line(-LEAD, TEN_WORDS, { meta: { airedAt: iso(-LEAD), carried: true } });
  assert.deepEqual(talkingState([carried], LEAD, NOW), { talking: false, nextChangeMs: null });
  assert.deepEqual(talkingState([line(200_000)], LEAD, NOW), { talking: false, nextChangeMs: null });
  assert.deepEqual(talkingState(undefined, LEAD, NOW), { talking: false, nextChangeMs: null });
});
