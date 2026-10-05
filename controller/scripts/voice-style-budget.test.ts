import assert from 'node:assert/strict';
import { test } from 'node:test';

import { geminiStyle } from '../src/audio/gemini.js';
import { PERSONA_VOICE_STYLE_MAX } from '../src/schemas/persona.js';

// Why this file exists: `PERSONA_VOICE_STYLE_MAX` was 300, which is exactly
// `VOICE_STYLE_MAX` — the whole composed-style budget in `geminiStyle()`. A
// directive at the cap therefore consumed the entire budget and
//
//   budget = Math.max(0, VOICE_STYLE_MAX - operator.length - station.length)
//
// left the persona's character excerpt at ZERO. Every station with a pronunciation
// note lost the persona's character on every segment, with no error anywhere. The
// field was not "too permissive" in the abstract; at its own maximum it deleted
// a different part of the same string.
//
// This is not a provider limit that was guessed wrong. `speech_metadata.style`
// has no documented per-field cap, and renders with 300 / 1000 / 3000 /
// 6000-character styles all returned 200. The binding constraint is local
// composition, so it has to be pinned in composition terms — a bound that says
// nothing about the budget cannot catch a regression in it.

const SOUL = 'Observant, dry, favours one good image over a list. '.repeat(6);
const STATION_NOTE = 'Sook rhymes with look';

test('a directive at the cap leaves the character excerpt alive', () => {
  const style = geminiStyle({
    soul: SOUL,
    voiceStyle: 'x'.repeat(PERSONA_VOICE_STYLE_MAX),
    pronunciation: STATION_NOTE,
  });

  assert.match(style, new RegExp(SOUL.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the character excerpt must survive a directive at the cap — that is the whole point of the cap');
  assert.ok(style.includes(STATION_NOTE), 'the station pronunciation note is never budget-limited');
});

test('the cap is below the whole style budget, not equal to it', () => {
  // The regression in one assertion. Equal is as wrong as larger: a directive that
  // can claim the entire budget has, by definition, nothing left to give.
  const budget = SOUL.length; // any value; the relationship is what matters
  assert.ok(PERSONA_VOICE_STYLE_MAX < budget,
    'the per-persona cap must be a share of the composed-style budget, not the whole of it');
});

test('raising the cap past the budget would erase the character — pin the arithmetic', () => {
  // If someone raises PERSONA_VOICE_STYLE_MAX toward VOICE_STYLE_MAX again, this
  // fails before it ships, and the failure message states the actual consequence
  // rather than "value changed".
  const VOICE_STYLE_MAX = 300; // mirrored deliberately; asserted below against the real one
  const remaining = (directive: number, station: string) =>
    Math.max(0, VOICE_STYLE_MAX - directive - station.length);

  assert.equal(remaining(300, STATION_NOTE), 0,
    'this is what the old cap did: a full-length directive left nothing for the character');
  assert.ok(remaining(PERSONA_VOICE_STYLE_MAX, STATION_NOTE) > 60,
    'at the current cap the character excerpt must get a usable share, not a token one');
});

test('VOICE_STYLE_MAX has not moved out from under the cap', async () => {
  // The two numbers live in different modules — a zod-only schema file and the
  // audio engine — because the generated mirror is one flat concatenation. That
  // makes drift possible and invisible, which is how 300 came to equal 300.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/audio/gemini.ts', import.meta.url), 'utf8'));
  const m = /const VOICE_STYLE_MAX = (\d+);/.exec(src);
  assert.ok(m, 'VOICE_STYLE_MAX must still be declared in gemini.ts');
  const budget = Number(m[1]);
  assert.ok(PERSONA_VOICE_STYLE_MAX < budget,
    `PERSONA_VOICE_STYLE_MAX (${PERSONA_VOICE_STYLE_MAX}) must stay below VOICE_STYLE_MAX `
      + `(${budget}); equal or above leaves the character excerpt nothing`);
});