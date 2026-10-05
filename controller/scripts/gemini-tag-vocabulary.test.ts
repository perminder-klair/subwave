// Pin request vocabulary independently of the implementation table, including
// the station's explicit medium-pause extension. This verifies emitted text
// and style channels, not the acoustic performance of documented or custom
// tags. Author-provided transcription samples cannot prove that a nonverbal
// sound was performed or establish pause durations.
//
// The documented list is transcribed from Google's guide rather than derived
// from our source; deriving it would also accept a broken implementation.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitCues } from '../src/audio/gemini.js';

/** Google's documented <...> vocabulary, transcribed from the "Vocal bursts and
 *  non-speech sounds" list in the speech-generation guide:
 *    https://ai.google.dev/gemini-api/docs/speech-generation
 *
 *  Transcribed as printed, including the pairs the guide offers as
 *  alternatives (`<chuckle> / <chuckles>`, `<laugh> / <laughter>`,
 *  `<pff> / <phew>`, `<sigh> / <sighs>`, `<whispers> / <whispering>`). `grr` and
 *  `sighs` were both absent from this list while being present in the guide's,
 *  which is how `[grr]` ended up rendering as the style string "grr" instead of
 *  a sound. */
const DOCUMENTED = [
  'argh', 'breath', 'heavy breath', 'exhales', 'cackle', 'cheer', 'chuckle',
  'chuckles', 'cough', 'cry', 'gasp', 'giggle', 'groan', 'growl', 'grunt',
  'grr', 'hiss', 'laugh', 'laughter', 'moan', 'pant', 'pff', 'phew', 'scream',
  'shout', 'shriek', 'sigh', 'sighs', 'sneeze', 'snicker', 'snort', 'sob',
  'throat-clearing', 'tsk', 'whimper', 'whispers', 'whispering', 'yawn',
  'short pause', 'long pause',
];

// Explicit station extension, not a documented tag or independently verified
// acoustic contract. Author-provided renders motivated retaining the spelling;
// these tests establish only its request mapping, not a pause or its duration.
const STATION_EXTENSIONS = ['medium pause'];

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

test('every tag we emit is documented or an explicit station extension', () => {
  const emitted = new Set<string>();
  for (const s of DJ_SPELLINGS) for (const t of tagsFor(s)) emitted.add(t);
  const allowed = new Set([...DOCUMENTED, ...STATION_EXTENSIONS]);
  const unverified = [...emitted].filter(t => !allowed.has(t));
  assert.deepEqual(unverified, [],
    `these tags are neither documented nor explicit station extensions: ${unverified.join(', ')}`);
});

test('`pant` emits the documented `<pant>`, not `<panting>`', () => {
  // The specific regression. `<panting>` is not a tag; `<pant>` is.
  // Both DJ spellings resolve to the documented tag. This tests vocabulary,
  // not acoustic behavior of the documented or undocumented spelling.
  assert.deepEqual(tagsFor('pant'), ['pant']);
  assert.deepEqual(tagsFor('panting'), ['pant']);
  // A MULTI-WORD cue is not a tag lookup at all — `[panting heavily]` is a
  // free-text modifier and belongs in the style field, like any other
  // sustained direction. Asserting it as two tags was the test being wrong.
  assert.deepEqual(tagsFor('panting heavily'), []);
  assert.deepEqual(splitCues('Hi. [panting heavily] There.').styles, ['panting heavily']);
});

test('every documented tag is emitted as ITSELF, not as some other tag', () => {
  // Coverage, not just safety: a documented tag the DJ cannot reach is a control
  // that does not exist. `[tsk]` used to fall through to the free-text rule and
  // become the style string "tsk", which is not a sound effect.
  //
  // The assertion is an EXACT IDENTITY, and that is the whole point. This loop
  // used to ask only whether the bracket produced "some" tag, so `[whispers]`
  // counted as coverage for `<whispers>` while emitting `<whispering>` — a
  // missing mapping read as a green suite. It also carried a hand-written
  // `tag === 'whispering' ? 'whispers' : tag` remap, which is the workaround
  // that hid the gap in the first place: no mapping emitted `<whispers>` at all,
  // and the remap is what made that invisible.
  //
  // `whispering` is the one documented tag with no bracket of its own, because
  // it is deliberately routed to speech_metadata.style instead. That is a
  // STATION CHOICE, not something the guide requires — it lists `<whispers> /
  // <whispering>` as a pair of alternatives. So it is asserted as a style in
  // `whispering is the one spelling routed to the style field` below, and
  // excluded here with a reason rather than quietly skipped.
  const STYLE_ROUTED = new Set(['whispering']);
  const unreachable: string[] = [];
  const wrongIdentity: string[] = [];
  for (const tag of DOCUMENTED) {
    if (STYLE_ROUTED.has(tag)) continue;
    const emitted = tagsFor(tag);
    if (emitted.length === 0) unreachable.push(tag);
    else if (emitted.length !== 1 || emitted[0] !== tag) {
      wrongIdentity.push(`[${tag}] -> <${emitted.join('>, <')}>`);
    }
  }
  assert.deepEqual(unreachable, [],
    `documented tags the DJ cannot reach: ${unreachable.join(', ')}`);
  assert.deepEqual(wrongIdentity, [],
    `these brackets emit a tag other than the one asked for: ${wrongIdentity.join('; ')}`);
});

test('`[grr]` and `[sighs]` are sounds, not style strings', () => {
  // The two documented tags that were missing outright. `[grr]` fell through to
  // the free-text rule and became the style string "grr" — a growl rendered as
  // prose, which is the same lost-sound failure this file exists to catch.
  for (const spelling of ['grr', 'sighs']) {
    const r = splitCues(`Hi. [${spelling}] There.`);
    assert.deepEqual(tagsFor(spelling), [spelling],
      `[${spelling}] is in the guide's list and must emit <${spelling}>`);
    assert.deepEqual(r.styles, [], `[${spelling}] must not also become a style`);
  }
  // `<sigh> / <sighs>` is a pair the guide spells out, so both spellings are
  // named in the mapping rather than one relying on the inflection stripper.
  assert.deepEqual(tagsFor('sigh'), ['sigh']);
  assert.deepEqual(tagsFor('sighs'), ['sighs']);
});

test('[medium pause] emits its tag and adds no style', () => {
  // The station extension must be exercised as an input cue, not merely
  // accepted in an output allowlist. No acoustic claim follows from this test.
  const r = splitCues('Wait... <medium pause> ...did you hear that?');
  assert.match(r.text, /<medium pause>/);
  assert.deepEqual(r.styles, [], 'a pause tag must not also add a style');
  assert.match(tagsFor('medium pause').join(','), /medium pause/);
});

test('`whispers` is a sound, and `whispering` is a style', () => {
  // The guide lists `<whispers> / <whispering>` as a PAIR OF ALTERNATIVES. An
  // earlier version of this test asserted they differ because "Google classes
  // [whispering] as a modifier of the FOLLOWING speech" — that was our reading,
  // presented as though it were sourced. Google says no such thing; it lists
  // both, and its scope table uses "whispers" among the STYLE examples too.
  // What is actually asserted here is the station's routing decision, and it is
  // labelled as one.
  //
  // The old assertion was `/<whispers?ing>/`, which never matched `<whispers>`:
  // `s?` makes two branches that spell the SAME word, so it accepted only
  // `<whispering>` while claiming to allow either. The exact-identity assertion
  // below is what it should have said.
  const sound = splitCues('Hi. [whispers] There.');
  assert.deepEqual(tagsFor('whispers'), ['whispers'],
    '`[whispers]` emits its own documented tag, not <whispering>');
  assert.deepEqual(sound.styles, []);

  // `[whisper]` is the spelling that exercises `<whispering>`, so that documented
  // tag stays reachable even though the gerund routes to the style field.
  assert.deepEqual(tagsFor('whisper'), ['whispering']);

  // The style routing itself, asserted exactly rather than by "no angle bracket".
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

test('the DJ inflection hisses emits hiss rather than a style', () => {
  assert.deepEqual(splitCues('Hi. [hisses] There.'), {
    text: 'Hi. <hiss> There.', styles: [],
  });
});
