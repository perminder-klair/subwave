// The lock screen / Live Activity "DJ on the mic" window. It opens when the
// listener HEARS a line (live-edge stamp + their buffer, #1114/#1382), not
// when the controller logged it, and lasts about as long as the line.

import assert from 'node:assert/strict';
import test from 'node:test';
import { isVoiceTurn, lineMs, speechMs, talkingState } from '../src/lib/voice-turn.ts';
import type { SessionTurn } from '../src/lib/types.ts';

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
  assert.equal(speechMs('Hi.'), 3_000);
  assert.equal(speechMs(Array(500).fill('word').join(' ')), 45_000);
});

test('lineMs prefers the controller’s measured clip length, else the estimate', () => {
  assert.equal(lineMs(line(0, TEN_WORDS, { meta: { durationMs: 12_345 } })), 12_345);
  for (const bad of [0, -1, Number.NaN, '9000', 16 * 60_000, null]) {
    assert.equal(lineMs(line(0, TEN_WORDS, { meta: { durationMs: bad } })), TEN_WORDS_MS, String(bad));
  }
  assert.equal(lineMs({ role: 'segment', text: TEN_WORDS }), TEN_WORDS_MS);
});

test('voice turns are recognised by kind or role', () => {
  assert.equal(isVoiceTurn({ role: 'segment', kind: 'handoff' }), true);
  assert.equal(isVoiceTurn({ role: 'event', kind: 'station-id' }), true);
  assert.equal(isVoiceTurn({ role: 'track', kind: 'track' }), false);
  assert.equal(isVoiceTurn({ role: 'event', kind: 'show-boundary' }), false);
  assert.equal(isVoiceTurn(undefined), false);
});

test('a line inside the buffer is not talking yet, and schedules its start', () => {
  // Aired 5s ago at the live edge; the listener hears it 17s from now.
  assert.deepEqual(talkingState([line(-5_000)], LEAD, NOW), {
    talking: false,
    nextChangeMs: NOW - 5_000 + LEAD,
  });
});

test('talking runs from airedAt + lead for the line’s estimated length', () => {
  const feed = [line(-LEAD)];
  assert.deepEqual(talkingState(feed, LEAD, NOW), { talking: true, nextChangeMs: NOW + TEN_WORDS_MS });
  assert.deepEqual(talkingState(feed, LEAD, NOW + TEN_WORDS_MS - 1), {
    talking: true,
    nextChangeMs: NOW + TEN_WORDS_MS,
  });
  assert.deepEqual(talkingState(feed, LEAD, NOW + TEN_WORDS_MS), { talking: false, nextChangeMs: null });
});

test('a measured clip length sets the end of the window', () => {
  const measured = line(-LEAD, TEN_WORDS, { meta: { airedAt: iso(-LEAD), durationMs: 20_000 } });
  assert.deepEqual(talkingState([measured], LEAD, NOW), { talking: true, nextChangeMs: NOW + 20_000 });
  assert.equal(talkingState([measured], LEAD, NOW + 19_999).talking, true);
  assert.equal(talkingState([measured], LEAD, NOW + 20_000).talking, false);
});

test('the old 15s-from-the-stamp window would have closed before the voice was heard', () => {
  // Stamp 16s ago: the old rule called this expired. The listener hears it in 6s.
  const state = talkingState([line(-16_000)], LEAD, NOW);
  assert.equal(state.talking, false);
  assert.equal(state.nextChangeMs, NOW + 6_000);
  assert.equal(talkingState([line(-16_000)], LEAD, NOW + 6_000).talking, true);
});

test('an unstamped turn falls back to `t`, still shifted by the lead', () => {
  const unstamped: SessionTurn = { t: iso(-LEAD), role: 'segment', kind: 'link', text: TEN_WORDS };
  assert.equal(talkingState([unstamped], LEAD, NOW).talking, true);
  assert.equal(talkingState([{ ...unstamped, t: NOW - LEAD }], LEAD, NOW).talking, true, 'numeric t');
  assert.equal(talkingState([{ ...unstamped, t: 'garbage' }], LEAD, NOW).talking, false);
});

test('a later line still in the buffer does not hide the one being heard', () => {
  // Older controller: no airedAt, so both turns are shown as soon as they land.
  const heard: SessionTurn = { t: iso(-LEAD - 1_000), role: 'segment', kind: 'link', text: TEN_WORDS };
  const next: SessionTurn = { t: iso(-LEAD + 3_000), role: 'segment', kind: 'link', text: TEN_WORDS };
  assert.deepEqual(talkingState([heard, next], LEAD, NOW), { talking: true, nextChangeMs: NOW + 3_000 });
  assert.deepEqual(talkingState([heard, next], LEAD, NOW + 3_000), {
    talking: true,
    nextChangeMs: NOW + 3_000 + TEN_WORDS_MS,
  });
});

test('a finished line is not talking, even with a pending one queued behind it', () => {
  const done = line(-LEAD - 10_000);
  const pending = line(-5_000);
  assert.deepEqual(talkingState([done, pending], LEAD, NOW), {
    talking: false,
    nextChangeMs: NOW - 5_000 + LEAD,
  });
});

test('track and event turns after a line do not end the window', () => {
  const feed: SessionTurn[] = [
    line(-LEAD),
    { t: iso(0), role: 'track', kind: 'track', text: '▶ Song' },
    { t: iso(0), role: 'event', kind: 'pick', text: 'Picking next.' },
  ];
  assert.equal(talkingState(feed, LEAD, NOW).talking, true);
});

test('the previous show’s carried tail never counts as talking', () => {
  const carried = line(-LEAD, TEN_WORDS, { meta: { airedAt: iso(-LEAD), carried: true, personaName: 'Bob' } });
  assert.deepEqual(talkingState([carried], LEAD, NOW), { talking: false, nextChangeMs: null });
});

test('an implausibly future stamp is ignored rather than holding the window', () => {
  assert.deepEqual(talkingState([line(200_000)], LEAD, NOW), { talking: false, nextChangeMs: null });
});

test('an empty feed is idle', () => {
  assert.deepEqual(talkingState(undefined, LEAD, NOW), { talking: false, nextChangeMs: null });
  assert.deepEqual(talkingState([], LEAD, NOW), { talking: false, nextChangeMs: null });
});
