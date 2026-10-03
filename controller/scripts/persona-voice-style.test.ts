// Per-persona `voiceStyle` — the free-text delivery directive.
//
// WHY THIS EXISTS. A persona already has a `soul`, but that answers "who is
// this?", not "how should this be read?". An operator who wants a flat, tired
// delivery from a persona whose soul is a hundred words of backstory had no way
// to say so: the Gemini engine had a `voiceStyle` PARAMETER all along
// (geminiStyle) and nothing ever populated it, and cloud-speech's deliveryHint
// composed from the soul alone. The plumbing was dormant end to end.
//
// WHAT IS PINNED. That the directive reaches BOTH engines with a free-text
// channel — gemini's speech_metadata.style and openai's `instructions` — and
// that it reaches NEITHER of the three without one. A field that silently
// no-ops on four of six engines is the failure mode worth naming: it looks
// saved, it validates, it round-trips, and it changes nothing.
//
// The deliveryHint half is asserted against the exported function rather than a
// wire capture: `instructions` goes into a body the AI SDK builds closed, so
// there is nothing cheap to intercept on every run.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// STATE_DIR before anything config-derived is imported.
const stateRoot = mkdtempSync(join(tmpdir(), 'persona-voice-style-'));
process.env.STATE_DIR = stateRoot;

const { personaSchema, PERSONA_VOICE_STYLE_MAX } = await import('../src/schemas/persona.js');
const { geminiStyle } = await import('../src/audio/gemini.js');
const { deliveryHint } = await import('../src/llm/internal/speech/cloud-speech.js');

const DIRECTIVE = 'flat, tired, unhurried — barely awake';

// Minimal persona the schema accepts. `tts` is required, so it is supplied
// rather than omitted — the point of these cases is the directive, not the rest.
const basePersona = {
  id: 'p_x', name: 'X', soul: 'A persona.', frequency: 'moderate',
  scriptLength: 'concise', djMode: false, linkStyle: 'natural',
  humour: 5, localColour: 5, warmth: 5, language: '', avatar: '', skills: [], tags: [],
  tts: { engine: 'gemini', cloudProvider: 'openai', voice: 'Puck', gainDb: 0, speed: 1 },
} as const;

// --- the field itself -------------------------------------------------------

test('voiceStyle is optional, defaults to empty, and round-trips', () => {
  // Absent must not throw, and must read as "no directive" — an upgraded
  // persona has none, and that has to be a legal state rather than a 400 on
  // the next save.
  assert.equal(personaSchema.parse(basePersona).voiceStyle, '');
  assert.equal(personaSchema.parse({ ...basePersona, voiceStyle: null }).voiceStyle, '');
  assert.equal(personaSchema.parse({ ...basePersona, voiceStyle: DIRECTIVE }).voiceStyle, DIRECTIVE);
  assert.equal(personaSchema.parse({ ...basePersona, voiceStyle: '  padded  ' }).voiceStyle, 'padded');
});

test('an over-long directive is refused rather than silently truncated', () => {
  const tooLong = 'x'.repeat(PERSONA_VOICE_STYLE_MAX + 1);
  const res = personaSchema.safeParse({ ...basePersona, voiceStyle: tooLong });
  assert.equal(res.success, false, 'a directive past the cap must be refused');
  assert.ok(
    personaSchema.safeParse({ ...basePersona, voiceStyle: 'x'.repeat(PERSONA_VOICE_STYLE_MAX) }).success,
    'exactly at the cap is allowed',
  );
});

// --- Gemini: composed, and prioritised over the soul ------------------------

test('Gemini composes the directive with the soul, directive first', () => {
  const style = geminiStyle({ soul: 'An exhausted single dad.', voiceStyle: DIRECTIVE });
  assert.match(style, /flat, tired, unhurried/, 'the directive must reach speech_metadata.style');
  assert.match(style, /exhausted single dad/, 'and the soul still does');
  // Order matters: the operator's deliberate instruction is allocated the budget
  // FIRST (gemini.ts). A soul that ate it would silently drop the one field
  // someone bothered to type.
  assert.ok(
    style.indexOf('flat, tired') < style.indexOf('exhausted single dad'),
    'directive must precede the soul excerpt',
  );
});

test('a persona with no directive gets no invented one', () => {
  assert.equal(geminiStyle({ soul: 'An exhausted single dad.' }).includes('flat, tired'), false);
  // Soul alone still composes — absence of the directive is not absence of style.
  assert.match(geminiStyle({ soul: 'An exhausted single dad.' }), /exhausted single dad/);
});

// --- OpenAI: reaches instructions, and ONLY on a model that accepts them ----

test('OpenAI sends the directive in instructions on gpt-4o-tts', () => {
  const hinted = deliveryHint({ soul: 'An exhausted dad.', voiceStyle: DIRECTIVE }, 'openai', 'gpt-4o-mini-tts');
  assert.match(hinted.instructions || '', /flat, tired, unhurried/);
  assert.match(hinted.instructions || '', /exhausted dad/, 'the soul still rides alongside it');
  // The directive is passed through as an instruction in its own right, NOT
  // wrapped in the "Convey this character" phrasing used for the soul: it is
  // already about delivery, and re-framing it as description would blur the two.
  assert.doesNotMatch(hinted.instructions || '', /Convey this character[^.]*flat, tired/);
});

test('tts-1 refuses instructions, so it must not carry the directive either', () => {
  // A 400 here drops the line to an English local fallback — worse than no
  // hint at all — so the whole hint is withheld on those models.
  assert.deepEqual(deliveryHint({ voiceStyle: DIRECTIVE }, 'openai', 'tts-1'), {});
  assert.deepEqual(deliveryHint({ voiceStyle: DIRECTIVE }, 'openai', 'tts-1-hd'), {});
});

// --- the engines with no free-text channel ----------------------------------

test('elevenlabs, fish and openai-compatible never receive the directive', () => {
  // ElevenLabs takes only an ISO language code; fish has its own REST contract;
  // openai-compatible servers vary too much to hint at. Each would either drop
  // it or 400 — so the gate is here rather than at three call sites.
  const eleven = deliveryHint({ voiceStyle: DIRECTIVE }, 'elevenlabs', 'eleven_v3');
  assert.deepEqual(eleven, {}, 'no instructions key at all');
  assert.ok(!('instructions' in eleven));
  assert.deepEqual(deliveryHint({ voiceStyle: DIRECTIVE }, 'fish-audio', 's1'), {});
  assert.deepEqual(deliveryHint({ voiceStyle: DIRECTIVE }, 'openai-compatible', 'local'), {});
});

test('elevenlabs still gets the language code it does understand', () => {
  // The gate is on the free-text channel, not on the request as a whole.
  const hinted = deliveryHint({ language: 'Turkish', voiceStyle: DIRECTIVE }, 'elevenlabs', 'eleven_v3');
  assert.equal(hinted.language, 'tr');
  assert.ok(!('instructions' in hinted));
});

// --- the THREAD, which is where this was broken -----------------------------

test('the directive survives the journey from the persona to the engine', async () => {
  // The two cases above prove each ENGINE composes correctly. Neither proves the
  // directive gets there: tts.speak() reads `voiceStyle` off the persona and
  // forwards it in the opts bag, and that line is the one most likely to be
  // dropped in a refactor — with no failure anywhere else, because the engine
  // would still compose a style from the soul alone and the render would merely
  // sound unchanged.
  //
  // Asserted against the source rather than a rendered WAV: the composition is
  // pure and exported, so the honest boundary is "the opts bag handed to the
  // engine carries the directive", not "a file came out".
  const ttsSrc = readFileSync(join(process.cwd(), 'src/audio/tts.ts'), 'utf8');
  assert.match(
    ttsSrc,
    /const voiceStyle = typeof personaFor\(persona\)\?\.voiceStyle === 'string'/,
    'the persona directive must be read in tts.speak()',
  );
  // Forwarded on BOTH the primary and the fallback render. A directive that
  // applies on the happy path and vanishes when the engine fails over is worse
  // than one that never applied, because it sounds like a flaky setting.
  const forwards = ttsSrc.match(/speakWith\((?:primary|fallback)[^\n]*voiceStyle/g) || [];
  assert.equal(forwards.length, 2,
    `expected voiceStyle forwarded on primary AND fallback, saw ${forwards.length}`);
  for (const call of forwards) {
    assert.match(call, /soul/);
  }
});