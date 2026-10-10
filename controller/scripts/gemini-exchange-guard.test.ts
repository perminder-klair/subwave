// The multi-speaker banter path is a GEMINI-ONLY optimisation. Every other
// engine renders per-line, because the batching is built on Gemini's request
// shape — one `/interactions` call carrying several text items with a
// `speech_config.speakers` array. No other provider accepts that, so routing one
// down this path would either 400 or be silently reshaped by an API that has no
// such concept.
//
// This drives the REAL dispatcher rather than asserting on source text: a copy
// of the guard is exactly the bug. Each roster below is one a station can
// actually have, because `inherit` is resolved before speakExchange sees it —
// so a persona pointing at whatever the station default is arrives as that
// concrete engine id.
//
// Run: `npm test -- gemini-exchange-guard`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speakExchange } from '../src/audio/tts.js';

const persona = (engine: string, voice = '') => ({
  name: 'P',
  soul: 'a persona',
  voiceStyle: 'dry',
  tts: { engine, voice, cloudProvider: 'openai', gainDb: 0, speed: 1 },
});

test('speakExchange refuses any roster that is not ALL gemini', async () => {
  const rosters: [string, any[]][] = [
    ['all piper', [persona('piper'), persona('piper')]],
    ['all kokoro', [persona('kokoro', 'bf_isabella'), persona('kokoro', 'am_michael')]],
    ['all chatterbox', [persona('chatterbox'), persona('chatterbox')]],
    ['all pocket-tts', [persona('pocket-tts', 'alba'), persona('pocket-tts', 'anna')]],
    ['all cloud', [persona('cloud', 'alloy'), persona('cloud', 'nova')]],
    ['all remote', [persona('remote', 'x'), persona('remote', 'y')]],
    // The mixed cases matter most: "ANY line is gemini" would be a wrong guard,
    // because a batched render has to be built from ONE engine's request shape.
    ['gemini + piper', [persona('gemini', 'Puck'), persona('piper')]],
    ['piper + gemini', [persona('piper'), persona('gemini', 'Puck')]],
    ['gemini + cloud', [persona('gemini', 'Puck'), persona('cloud', 'alloy')]],
    ['gemini + remote', [persona('gemini', 'Puck'), persona('remote', 'x')]],
    ['gemini + kokoro', [persona('gemini', 'Puck'), persona('kokoro', 'bf_isabella')]],
  ];

  for (const [label, lines] of rosters) {
    assert.equal(lines.every(l => l.tts.engine === 'gemini'), false, `${label} fixture sanity`);
    await assert.rejects(
      () => speakExchange(lines, { kind: 'banter' }),
      /only supports an all-gemini exchange/,
      `a ${label} roster must never reach the multi-speaker path`,
    );
  }
});

test('a single non-gemini line is enough to refuse the whole exchange', async () => {
  // One voice short of the cap, and only one of the two is gemini.
  await assert.rejects(
    () => speakExchange([
      { persona: persona('gemini', 'Puck'), text: 'First line.' },
      { persona: persona('cloud', 'alloy'), text: 'Second line.' },
    ], { kind: 'banter' }),
    /only supports an all-gemini exchange/,
  );
});

test('an empty exchange is refused too, not treated as a pass', async () => {
  await assert.rejects(
    () => speakExchange([], { kind: 'banter' }),
    /only supports an all-gemini exchange/,
  );
});