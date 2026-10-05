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

/** `VOICE_STYLE_MAX` read from its declaration. It lives in a different module
 *  from the schema — a zod-only file and the audio engine — because the generated
 *  mirror is one flat concatenation, which is how 300 came to equal 300 unnoticed. */
async function voiceStyleBudget(): Promise<number> {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/audio/gemini.ts', import.meta.url), 'utf8'));
  const m = /const VOICE_STYLE_MAX = (\d+);/.exec(src);
  assert.ok(m, 'VOICE_STYLE_MAX must still be declared in gemini.ts');
  return Number(m[1]);
}

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

test('the cap is HALF the style budget — the derivation, not merely a smaller number', async () => {
  // The first version of this asserted only `cap < budget`. That is strictly
  // weaker than the contract it claims to pin: raising the cap to 200 while the
  // budget stayed 300 leaves every other assertion in this file green, even
  // though 200 is not the half the declaration and the PR both state. A test that
  // cannot distinguish the stated value from a wrong one is not testing the
  // statement, it is testing the original bug and calling it a rule.
  const budget = await voiceStyleBudget();
  assert.equal(PERSONA_VOICE_STYLE_MAX, budget / 2,
    `PERSONA_VOICE_STYLE_MAX is ${PERSONA_VOICE_STYLE_MAX} but the derivation is half of `
      + `VOICE_STYLE_MAX (${budget}) = ${budget / 2}. If the relationship itself is changing, `
      + 'change the declaration comment and this assertion together — do not drift one alone.');
  assert.ok(PERSONA_VOICE_STYLE_MAX < budget,
    'and half is still strictly below the whole budget, which is the original regression');
});

test('a directive claiming the whole budget erases the character', async () => {
  const budget = await voiceStyleBudget();
  const directive = 'x'.repeat(budget);
  const style = geminiStyle({ soul: SOUL, voiceStyle: directive, pronunciation: STATION_NOTE });
  assert.equal(style, `${directive}. ${STATION_NOTE}`,
    'a full-budget directive leaves nothing for the character, while the station note survives');
});

test('VOICE_STYLE_MAX is even, so half of it is a whole number', async () => {
  // Half of an odd budget is a fraction, and a character cap cannot be. Silently
  // rounding it would put the constant and its own stated derivation out of
  // agreement with nothing to catch it — the exact failure the assertion above
  // exists to prevent, one step removed.
  const budget = await voiceStyleBudget();
  assert.equal(budget % 2, 0,
    `VOICE_STYLE_MAX is ${budget}; PERSONA_VOICE_STYLE_MAX is derived as half of it, so an `
      + 'odd budget makes the derivation unrepresentable. Fix the budget or the derivation '
      + 'deliberately, not by rounding.');
});
