// Every tag we put on the wire is pinned to Google's documented vocabulary.
//
// WHY THIS IS A TEST AND NOT A COMMENT
// ------------------------------------
// Google's guidance is "test and verify new tags" — a station cannot audition
// two thousand of them, so the curated list IS the verification, and a
// contributor adding a tag by hand should have to decide that consciously
// rather than by editing a map.
//
// WHAT THIS IS NOT
// ----------------
// An earlier draft of this file claimed an undocumented tag would be spoken
// aloud, because Gemini 3.8 reads `text` verbatim. That was inferred, not
// measured, and it is wrong for angle-bracket tags: rendering
// `I am fine. <panting> I am fine.` and transcribing the result with Gemini's
// own audio understanding gives "I am fine. I am fine." — no "panting". Same
// for `<tsk>`, `<argh>` and `<throat-clearing>`. Google's own tag guide allows
// for custom tags and says only that they require testing.
//
// The hazard that IS real is the square-bracket Mode 3 adjectives — `[scared]`,
// `[curious]`, `[bored]` — which are spoken as words. Those are kept out of the
// wire by the free-text→style rule in splitCues, asserted below.
//
// The list is transcribed from Google's tag guide rather than derived from our
// source. Deriving it would make the assertion vacuous: it would pass against
// any map, including a broken one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitCues } from '../src/audio/gemini.js';

/** Google's documented <...> vocabulary, from the 3.8 speech-generation
 *  prompting guide's "vocal tag list". */
const DOCUMENTED = [
  'argh', 'breath', 'heavy breath', 'exhales', 'cackle', 'cheer', 'chuckle',
  'chuckles', 'cough', 'cry', 'gasp', 'giggle', 'groan', 'growl', 'grunt',
  'hiss', 'laugh', 'laughter', 'moan', 'pant', 'pff', 'phew', 'scream',
  'shout', 'shriek', 'sigh', 'sneeze', 'snicker', 'snort', 'sob',
  'throat-clearing', 'tsk', 'whimper', 'whispers', 'whispering', 'yawn',
  'short pause', 'long pause',
];

/** Not in Google's list, but MEASURED to pause rather than speak, on both
 *  models in MODELS including the one a station with no explicit model pick
 *  actually sends first. How MUCH it pauses is not established — single samples
 *  could not separate short from medium. Listed explicitly so a future
 *  contributor cannot "fix" it away as undocumented, and so this is visibly the
 *  one place an undocumented tag is permitted. */
const VERIFIED_UNDOCUMENTED = ['medium pause'];

// Spellings the DJ actually writes. The third-person `-s` forms matter: the
// station's own system prompt suggests `[laughs]` and `[sighs]`.
const DJ_SPELLINGS = [
  ...DOCUMENTED,
  ...['laughs', 'sighs', 'chuckles', 'grunts', 'growls', 'hisses', 'panting',
    'panting heavily', 'exhale', 'yells', 'screams', 'whispers', 'uhm', 'um'],
];

function tagsFor(spelling: string): string[] {
  const { text } = splitCues(`Hello there. [${spelling}] Goodbye.`);
  return [...text.matchAll(/<([^>]+)>/g)].map(m => m[1] as string);
}

test('every tag we emit is on the verified list', () => {
  const emitted = new Set<string>();
  for (const s of DJ_SPELLINGS) for (const t of tagsFor(s)) emitted.add(t);
  const allowed = new Set([...DOCUMENTED, ...VERIFIED_UNDOCUMENTED]);
  const unverified = [...emitted].filter(t => !allowed.has(t));
  assert.deepEqual(unverified, [],
    `these tags are neither documented nor individually verified: ${unverified.join(', ')}`);
});

test('`pant` emits the documented `<pant>`, not `<panting>`', () => {
  // The specific regression. `<panting>` is not a tag; `<pant>` is.
  // Both spellings the DJ might write resolve to the DOCUMENTED tag. Measured:
  // `<panting>` would also have been performed rather than spoken, so this is
  // about pinning to the verified spelling, not about preventing an error.
  assert.deepEqual(tagsFor('pant'), ['pant']);
  assert.deepEqual(tagsFor('panting'), ['pant']);
  // A MULTI-WORD cue is not a tag lookup at all — `[panting heavily]` is a
  // free-text modifier and belongs in the style field, like any other
  // sustained direction. Asserting it as two tags was the test being wrong.
  assert.deepEqual(tagsFor('panting heavily'), []);
  assert.deepEqual(splitCues('Hi. [panting heavily] There.').styles, ['panting heavily']);
});

test('the whole documented vocabulary is reachable from a bracket cue', () => {
  // Coverage, not just safety: a documented tag the DJ cannot reach is a
  // control that does not exist. `[tsk]` used to fall through to the free-text
  // rule and become the style string "tsk", which is not a sound effect.
  const unreachable: string[] = [];
  for (const tag of DOCUMENTED) {
    const spelling = tag === 'whispering' ? 'whispers' : tag;
    if (tagsFor(spelling).length === 0) unreachable.push(tag);
  }
  assert.deepEqual(unreachable, [],
    `documented tags the DJ cannot reach: ${unreachable.join(', ')}`);
});

test('a one-shot breath cue is a sound, and a sustained one is a style', () => {
  // Google classes `[whispering]` as a modifier of the FOLLOWING speech, not a
  // one-shot noise — so it belongs in speech_metadata.style. `[whispers]` is the
  // third-person form the prompt suggests and is the sound. The asymmetry is
  // deliberate; both are asserted so a "simplification" cannot collapse it.
  const sound = splitCues('Hi. [whispers] There.');
  assert.match(sound.text, /<whispers?ing>/);
  assert.deepEqual(sound.styles, []);

  const sustained = splitCues('Hi. [whispering] There.');
  assert.doesNotMatch(sustained.text, /</);
  assert.deepEqual(sustained.styles, ['whispered']);
});

test('Google Mode 3 — the vocalized adjectives — never become tags', () => {
  // Mode 3 is the trap: "the tag itself is spoken as a word, while also
  // influencing the tone". Google's own guidance is to prefer the style prompt.
  // `[scared]`, `[curious]`, `[bored]` must therefore go to the STYLE string,
  // never into the transcript as text and never as a tag.
  for (const adj of ['scared', 'curious', 'bored']) {
    const r = splitCues(`I think someone is in the house. [${adj}] Is it safe?`);
    assert.deepEqual(r.styles, [adj], `${adj} must ride the style field`);
    assert.doesNotMatch(r.text, new RegExp(`<${adj}>`), `${adj} must not become a tag`);
  }
});

test('a proper-noun bracket still survives into the transcript', () => {
  // The complement of Mode 3: `[Blue Monday]` is a TITLE, not a direction, and
  // Gemini reads the text verbatim — so it has to reach the wire untouched.
  const r = splitCues('Now playing [Blue Monday] by The Smiths.');
  assert.match(r.text, /\[Blue Monday\]/);
  assert.deepEqual(r.styles, []);
  const digits = splitCues('That was Track [2] on the album.');
  assert.match(digits.text, /\[2\]/);
});