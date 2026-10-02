// Pins for the native `gemini` TTS engine (direct Google, no sidecar) and the
// voiceStyle delivery directive.
//
// Contracts:
//   • `gemini` is a first-class engine id in the persona + skill vocabularies
//     (restated lists stay equal — same posture as the tag regexes).
//   • splitCues: vocal bursts become <...> tags (inflected forms included, or
//     Gemini 3.8 reads "laughs" aloud — its `text` is a verbatim transcript),
//     delivery modifiers and free-text cues join speech_metadata.style, and
//     capitalised track-title brackets survive.
//   • fallbackTextFor strips brackets for gemini rescues (it speaks literally).
//   • Gemini is presented as a CLOUD PROVIDER, not a peer engine card, while
//     keeping its own engine id end to end (see the fold block at the bottom).
//
// Run: `npm test -- gemini-tts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TTS_ENGINES } from '../src/schemas/persona.js';
import { splitCues } from '../src/audio/gemini.js';
import { fallbackTextFor } from '../src/audio/tts-fallback.js';

test('gemini is a first-class engine id', () => {
  assert.ok((TTS_ENGINES as readonly string[]).includes('gemini'));
});

test('persona schema accepts a gemini slot', async () => {
  const persona = await import('../src/schemas/persona.js');
  const slot = { engine: 'gemini', voice: 'Despina', cloudProvider: 'openai', gainDb: 0, speed: 1 };
  const parsed = persona.personaSchema.parse({
    name: 'G', soul: 's', tagline: '', frequency: 'moderate', scriptLength: 'concise',
    djMode: false, linkStyle: 'natural', humour: 5, localColour: 5, warmth: 5,
    language: '', avatar: '', tts: slot, skills: null, tags: [],
  });
  const out = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.equal(out.tts.engine, 'gemini');
  assert.equal(out.tts.voice, 'Despina');
});

test('speakMulti picks the request shape from the DISTINCT voice count', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/audio/gemini.ts', import.meta.url), 'utf8');
  // Measured against the engine: the multi-speaker object form 400s on one voice
  // ("speaker_voice_configs must equal 2"), and the array form 400s on two. Both
  // branches are load-bearing; neither is a stylistic preference.
  assert.match(src, /const oneVoice = seen\.size === 1;/,
    'the shape must be chosen from the resolved voice count, not assumed');
  assert.match(src, /\? \{ speech_config: \[\{ voice: speakers\[0\]\.voice \}\] \}/,
    'one voice must use the single-speaker array form');
  assert.match(src, /\{ speech_config: \{ mode: 'conversational', speakers \} \}/,
    'two voices must use the conversational speakers form');
  // `speaker` is required per-turn on the multi-speaker shape and forbidden on
  // the single-speaker one, so it cannot just be left on unconditionally.
  assert.match(src, /\.\.\.\(oneVoice \? \{\} : \{ speaker: speakerOf\(t\.alias\) \}\)/);
});

test('splitCues: bursts become angle tags, delivery joins style, titles survive', () => {
  assert.deepEqual(
    splitCues('Hello [sigh] mate, that was [sarcasm] brilliant [short pause] news'),
    { text: 'Hello <sigh> mate, that was brilliant <short pause> news', styles: ['sarcastic'] },
  );
  assert.deepEqual(
    splitCues('Live from [Track 2] tonight'),
    { text: 'Live from [Track 2] tonight', styles: [] },
  );
  assert.deepEqual(splitCues('No cues'), { text: 'No cues', styles: [] });
});

test('splitCues: punctuation inside the bracket still resolves the cue', () => {
  // The DJ writes punctuation inside the bracket naturally. Unstripped, `[sigh.]`
  // missed the map and fell through to the free-text rule, becoming a SPOKEN
  // "sigh." instead of an actual sigh — the exact failure the free-text rule was
  // added to stop, reintroduced through the back door.
  assert.deepEqual(
    splitCues('Well [sigh.] anyway. [ Sigh ] Really. [chuckle!]'),
    { text: 'Well <sigh> anyway. <sigh> Really. <chuckle>', styles: [] },
  );
});

test('splitCues: the prompt’s own cue spellings never reach the transcript', () => {
  // llm/internal/prompts/system.ts tells the DJ to write `[laughs]`,
  // `[sighs]`, `[whispers]`, `[excited]` and `[soft and warm]`. Gemini 3.8
  // treats `text` as a verbatim transcript, so an unrecognised bracket is
  // RECITED — the cue becomes an audible artefact instead of a performance.
  assert.deepEqual(
    splitCues('Honestly? [laughs] I told you so. [sighs] Anyway.'),
    { text: 'Honestly? <laugh> I told you so. <sigh> Anyway.', styles: [] },
  );
  assert.deepEqual(
    splitCues('A [excited] little number'),
    { text: 'A little number', styles: ['excited, upbeat'] },
  );
  // Free-text performance cues are sustained delivery, so they ride the style
  // field rather than the transcript.
  assert.deepEqual(
    splitCues('You may hear [soft and warm] in this one'),
    { text: 'You may hear in this one', styles: ['soft and warm'] },
  );
});

test('the station pronunciation note rides last and survives a full budget', async () => {
  const { geminiStyle } = await import('../src/audio/gemini.js');
  // The operator's regional note ("Sook rhymes with look") is station-wide and
  // must reach the model on every render.
  const withNote = geminiStyle({ soul: 'a sparky', voiceStyle: 'dry', pronunciation: 'Sook rhymes with look' });
  assert.match(withNote, /Sook rhymes with look/);
  // Order in the final string: persona delivery, then character, then the note
  // as a closing correction.
  assert.ok(
    withNote.indexOf('dry') < withNote.indexOf('sparky')
    && withNote.indexOf('sparky') < withNote.indexOf('Sook'),
    `unexpected order: ${withNote}`);
  // The soul yields before the note. A dropped note is a place name said wrong
  // in EVERY segment; a shortened soul excerpt still reads as character.
  const greedySoul = 'y'.repeat(600);
  const tight = geminiStyle({ soul: greedySoul, voiceStyle: 'v', pronunciation: 'p'.repeat(200) });
  assert.match(tight, /p{200}/, 'the note must survive even when the soul cannot fit');
  assert.ok(tight.length <= 300 + 200 + 2,
    `style grew past its budget: ${tight.length}`);
  // Absent note → the composed style is byte-identical to before the field.
  assert.equal(
    geminiStyle({ soul: 'a sparky', voiceStyle: 'dry', pronunciation: '' }),
    geminiStyle({ soul: 'a sparky', voiceStyle: 'dry' }),
  );
});

test('a persona soul reaches Gemini, the way it reaches OpenAI', async () => {
  // OpenAI composes `instructions` from soulBrief(soul) + voiceStyle
  // (deliveryHint). Gemini had a first-class style field but received ONLY
  // voiceStyle, so a persona's entire character — backstory, job, running jokes —
  // never reached the model. That is why the retired sidecar hardcoded a style
  // per persona to compensate.
  const { geminiStyle } = await import('../src/audio/gemini.js');
  const soul = 'An exhausted dad who has been up since 5am because of his kids. '
    + 'He runs on instant coffee and complains about Lego in his feet.';
  const style = geminiStyle({ soul, voiceStyle: 'tired Australian dad, warm, casual' });
  assert.match(style, /tired Australian dad, warm, casual/,
    'the operator\'s voiceStyle must survive');
  assert.match(style, /exhausted dad/,
    'the persona soul must now reach Gemini too');
  // Ordering matters: the operator's deliberate directive gets the budget first.
  // Gemini\'s prompting guide warns that long character blocks are the main
  // cause of voice drift, so a long soul must never be able to crowd the
  // voiceStyle out — which is the opposite of OpenAI\'s character-first order.
  assert.ok(style.indexOf('tired Australian') < style.indexOf('exhausted dad'));
  // OpenAI allows a 4096-char instructions string; Gemini is capped far lower
  // for exactly the drift reason above.
  assert.ok(style.length <= 300, `style must stay within VOICE_STYLE_MAX, got ${style.length}`);
  // No soul, no style → nothing invented. The engine sends an empty style rather
  // than a fabricated default.
  assert.equal(geminiStyle({}), '');
  // Cues still append after both.
  assert.match(geminiStyle({ soul: 'a sparky', voiceStyle: 'dry' }, ['sarcastic']),
    /dry.*sarcastic/s);
});

test('an unusable voice name degrades instead of 400-ing the segment', async () => {
  const { usableVoice } = await import('../src/audio/gemini.js');
  // Verified against the engine: 'Charon', 'charon' and 'CHARON' all work, so
  // case is not a reason to reject — and the retired sidecar's title-case
  // normalisation was therefore fixing nothing worth porting.
  assert.equal(usableVoice('charon'), 'Charon');
  assert.equal(usableVoice('  PUCK '), 'Puck');
  // Voice Design / Replication ids are opaque per-project handles and must pass
  // through — rejecting them would break custom voices.
  assert.equal(usableVoice('voice_abc123'), 'voice_abc123');
  assert.equal(usableVoice('voicekey_abc123'), 'voicekey_abc123');
  // A stale alias 400s ("No matching speaker voice found for name"), which would
  // throw every segment that persona voices into the fallback chain.
  assert.equal(usableVoice('jax'), undefined);
  assert.equal(usableVoice(''), undefined);
  assert.equal(usableVoice(undefined), undefined);
});

test('splitCues: a capitalised bracket is a title, never a direction', () => {
  // The shape that must survive. Losing a title to the style field would make
  // the DJ announce “Blue Monday” in a voice described as its own name.
  for (const text of [
    'Live from [Track 2] tonight',
    'Now playing [Blue Monday]',
    'the set kicks off at [7pm] sharp',
  ]) {
    assert.deepEqual(splitCues(text), { text, styles: [] }, text);
  }
});

test('fallbackTextFor strips brackets for gemini rescues', () => {
  assert.equal(fallbackTextFor('gemini', null, 'Well [sigh] hello'), 'Well hello');
  assert.equal(fallbackTextFor('piper', null, 'Well [sigh] hello'), 'Well [sigh] hello');
});


// --- the fold: Gemini as a Cloud provider, still its own engine id ----------
//
// The product call: Gemini reaches Google with the same API key as the LLM
// section, so an operator picking a voice should find it beside OpenAI /
// ElevenLabs / Fish rather than as a card of its own. Two Google-backed choices
// in two different menus is a question nobody can answer from the screen.
//
// The fold is PRESENTATION ONLY. The dispatcher still resolves `gemini` as its
// own engine, `TTS_ENGINES` still lists it, and every stored persona keeps its
// value — so this asserts the pairing holds in both directions, which is the
// invariant that would break if one selector were changed without the other.

test('gemini is offered as a Cloud provider, not as a peer engine card', async () => {
  const { ENGINES } = await import('../../web/components/admin/tts/engineMeta.js');
  const { CLOUD_PROVIDERS } = await import('../../web/components/admin/tts/cloudProviderMeta.js');

  assert.ok(!ENGINES.some(e => e.id === 'gemini'),
    'gemini must not be its own top-level engine card');
  assert.ok(CLOUD_PROVIDERS.some(p => p.id === 'gemini'),
    'gemini must appear in the Cloud provider grid');
  // Cloud's blurb is what the operator reads on the card they now pick instead.
  const cloud = ENGINES.find(e => e.id === 'cloud');
  assert.match(cloud!.blurb, /Gemini/,
    'the Cloud card must name Gemini now that Gemini is one of its providers');
});

test('the engine <-> provider mapping is exact in both directions', async () => {
  const { engineCategory, engineForCloudProvider, GEMINI_CLOUD_PROVIDER }
    = await import('../../web/components/admin/tts/engineMeta.js');

  assert.equal(GEMINI_CLOUD_PROVIDER, 'gemini');
  // Which card lights up at the top.
  assert.equal(engineCategory('gemini'), 'cloud');
  assert.equal(engineCategory('cloud'), 'cloud');
  assert.equal(engineCategory('piper'), 'piper');
  // What choosing a provider writes. Gemini keeps its own id; the rest share cloud.
  assert.equal(engineForCloudProvider('gemini'), 'gemini');
  for (const p of ['openai', 'elevenlabs', 'fish-audio', 'openai-compatible']) {
    assert.equal(engineForCloudProvider(p), 'cloud', `${p} must resolve to the cloud engine`);
  }
});

test("gemini's badge reads the engine flag, not cloudByProvider", async () => {
  const { cloudProviderStatus } = await import('../../web/components/admin/tts/cloudProviderMeta.js');

  // Gemini is an engine, so it never appears in cloudByProvider. Reading that
  // map would report "no key" on a station whose engine can speak perfectly.
  assert.deepEqual(
    cloudProviderStatus('gemini', { gemini: true, cloudByProvider: {} }),
    { label: 'key set', tone: 'ok', state: 'ready' });
  assert.equal(cloudProviderStatus('gemini', { gemini: false }).state, 'off');
  assert.equal(cloudProviderStatus('gemini', { gemini: false }).label, 'no key');
  // Unasked is not the same as absent — the badge must not cry wolf.
  assert.equal(cloudProviderStatus('gemini', {}).state, 'unknown');
  assert.equal(cloudProviderStatus('gemini', { cloudByProvider: { gemini: false } }).state, 'unknown',
    'cloudByProvider must not decide the gemini badge');
});

test('Gemini is offered as a provider card, not as its own engine card', async () => {
  const fs = await import('node:fs');
  const meta = fs.readFileSync(
    new URL('../../web/components/admin/tts/engineMeta.ts', import.meta.url), 'utf8');
  const providers = fs.readFileSync(
    new URL('../../web/components/admin/tts/cloudProviderMeta.ts', import.meta.url), 'utf8');
  // Gemini is a managed Google service reached with the same key as the LLM
  // section, so it belongs beside OpenAI / ElevenLabs / Fish in the PROVIDER
  // grid. Two Google-backed choices in two different menus is a question nobody
  // can answer from the screen.
  assert.doesNotMatch(meta, /\{ id: 'gemini',\s+label:/,
    'gemini must not have its own entry in the ENGINE grid');
  assert.match(providers, /\{ id: 'gemini', label: 'Gemini'/,
    'it must appear in the provider grid instead');
  // And the badge reads the ENGINE flag, not a cloudByProvider entry the
  // controller never sends for it.
  assert.match(providers, /if \(id === 'gemini'\) \{/);
  assert.match(providers, /if \(a\.gemini === undefined\)/);
});

test('the Gemini model and voice vocabularies are the verified lists', async () => {
  const { GEMINI_TTS_MODELS, GEMINI_TTS_VOICES } = await import('../src/schemas/persona.js');

  // Every id here was verified against the live API: each model returned audio
  // from generateContent with responseModalities ['AUDIO'], and each voice was
  // accepted in speechConfig.prebuiltVoiceConfig.voiceName.
  // Only the models that survive the engine's OWN request shape belong here:
  // `/interactions` with a speech_metadata annotation and a speech_config voice.
  // Verified through exactly that body — the plain generateContent endpoint
  // answers for all five and so proves nothing.
  assert.deepEqual([...GEMINI_TTS_MODELS], [
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts',
  ]);
  // The three that DO synthesise audio, but only through generateContent. Listed
  // here as excluded-on-purpose: the engine always sends a speech annotation
  // (per-persona voiceStyle is a feature) and all three reject it outright, so
  // offering them would be three dead dropdown entries that 400 every render.
  for (const m of [
    'gemini-3.1-flash-tts-preview',
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-pro-preview-tts',
  ]) {
    assert.ok(!(GEMINI_TTS_MODELS as readonly string[]).includes(m),
      `${m} rejects speech annotations and must not be selectable`);
  }
  // The conversational-audio family is not a TTS model at all.
  for (const m of GEMINI_TTS_MODELS) {
    assert.doesNotMatch(m, /native-audio/, `${m} does not accept single-speaker TTS config`);
    assert.match(m, /tts/, `${m} is not a TTS model`);
  }
  assert.equal(GEMINI_TTS_VOICES.length, 30);
  assert.equal(new Set(GEMINI_TTS_VOICES).size, 30, 'voice list must not repeat an id');
  assert.ok(GEMINI_TTS_VOICES.includes('Puck'), 'Puck is the engine default');
  // GET /v1beta/voices is NOT this list — it is the Live/native-audio catalogue
  // and omits Puck, Zephyr and Kore. Hard-wiring it here would delete voices the
  // API accepts.
  assert.ok(GEMINI_TTS_VOICES.includes('Zephyr') && GEMINI_TTS_VOICES.includes('Kore'));
});

test('a chosen Gemini model leads the chain instead of replacing it', async () => {
  const fs = await import('node:fs');
  const gemini = fs.readFileSync(new URL('../src/audio/gemini.ts', import.meta.url), 'utf8');
  // Pinning a model must not be able to leave the station mute: if the chosen
  // model 404s or is retired, the loop still has the rest of the chain behind it.
  assert.match(gemini, /function modelChain\(chosen\?: string\)/,
    'the chain must be built around the operator\'s pick');
  assert.match(gemini, /\[pick, \.\.\.MODELS\.filter\(\(m\) => m !== pick\)\]/,
    'the chosen model leads, and the rest of the chain still stands behind it');
  assert.match(gemini, /if \(!pick \|\| pick === MODELS\[0\]\) return MODELS;/,
    'an unpinned station keeps the chain unchanged');
});

test('the gemini branch threads the resolved voice, model and style', async () => {
  const fs = await import('node:fs');
  const tts = fs.readFileSync(new URL('../src/audio/tts.ts', import.meta.url), 'utf8');
  // Precedence itself is asserted behaviourally in gemini-tts-settings.test.ts
  // (stationGeminiPick); what matters HERE is that the single-speaker branch
  // actually SPREADS the resolved pick into the call. A branch that resolved
  // voice and model and then dropped one would keep every precedence test green.
  assert.match(tts, /gemini\.speak\(text, \{ \.\.\.opts, voice, style, model \}\)/,
    'the resolved voice, style and model must all reach gemini.speak');
});

test('a persona on Gemini gets ONE voice field, shaped like the cloud one', async () => {
  const fs = await import('node:fs');
  const f = fs.readFileSync(
    new URL('../../web/components/admin/tts/EngineVoiceFields.tsx', import.meta.url), 'utf8');
  // The Gemini fold made Gemini a provider card, and the shared voice block
  // already rendered for it — but a second standalone "Gemini voice" field
  // rendered too. Two inputs, both writing `voice`: the second showed blank for
  // any value the picker considered a preset, and whichever was typed into last
  // silently won.
  assert.doesNotMatch(f, /<Label>Gemini voice<\/Label>/,
    'there must be no separate Gemini voice field beside the shared one');
  assert.doesNotMatch(f, /Custom Gemini voice id[\s\S]{0,200}className="mt-2"/,
    'the custom box must be the shared gated one, not an always-on extra input');
  // ONE field whose contents follow the selected provider card.
  assert.match(f, /const voiceGroups = geminiSelected\s*\n\s*\? buildGeminiVoiceGroups\(\)/,
    'the picker contents must follow the selected provider');
  assert.match(f, /const isPreset = geminiSelected\s*\n\s*\? isKnownGeminiVoice\(voice\)/,
    'preset-vs-custom must be decided the same way for both');
  // The free-text box stays hidden until "Custom voice id…" is chosen — the
  // cloud providers' behaviour, which is what the operator asked Gemini to match.
  assert.match(f, /!isPreset && \(\s*\n\s*<Input/, 'the custom box must be gated on !isPreset');
  // And the sample button still has to audition with the Gemini engine, not cloud.
  assert.match(f, /preview=\{geminiSelected\s*\n\s*\?\s*\{ engine: 'gemini'/,
    'the sample button must audition with the Gemini engine, not cloud');
  assert.match(f, /:\s*\{ engine: 'cloud', cloudProvider/,
    'the cloud branch of the same preview must be left intact');
});

test('a Gemini persona is never labelled piper', async () => {
  const fs = await import('node:fs');
  const helpers = fs.readFileSync(
    new URL('../../web/components/admin/personas/helpers.ts', import.meta.url), 'utf8');
  // engineLabel had no gemini branch, so a persona on Gemini fell through to the
  // piper fallback and the personas hero reported "piper / Despina" — naming a
  // local engine that never rendered it, and sending the operator to look for a
  // piper voice they never set. The same class of wrong-engine mislabelling the
  // duplicate voice fields caused.
  assert.match(helpers, /engine === 'gemini'\) return `gemini \//,
    'a Gemini persona must report its own engine');
  // And it must come BEFORE the piper fallback, or the branch is unreachable.
  const geminiAt = helpers.indexOf("engine === 'gemini'");
  const piperFallback = helpers.indexOf("return `piper /");
  assert.ok(geminiAt > -1 && geminiAt < piperFallback,
    'the gemini branch has to precede the piper fallback to be reachable');
  // A blank Gemini voice is the STATION floor, not piper's "built-in".
  const geminiLine = /engine === 'gemini'\) return ([^\n]+)/.exec(helpers)?.[1] || '';
  assert.match(geminiLine, /station default/,
    'a blank Gemini voice must name the station floor, not a built-in default');
  assert.doesNotMatch(geminiLine, /built-in/,
    'the piper "built-in" claim must not leak into the Gemini label');
});

test('the Gemini voice list lives beside the cloud ones, once', async () => {
  const fs = await import('node:fs');
  const groups = fs.readFileSync(
    new URL('../../web/lib/cloudVoiceGroups.ts', import.meta.url), 'utf8');
  const editor = fs.readFileSync(
    new URL('../../web/components/admin/tts/EngineVoiceFields.tsx', import.meta.url), 'utf8');
  // It used to be declared in the persona editor next to its JSX — the exact
  // place a second copy lands the moment another screen wants the same labels.
  assert.doesNotMatch(editor, /GEMINI_PREBUILT_VOICES/,
    'the curated list must not be duplicated in the editor');
  assert.match(groups, /export function buildGeminiVoiceGroups/);
  // Every provider branch must end with the custom row, or a designed /
  // replicated `voice_…` id has no home in the picker.
  assert.match(groups, /buildGeminiVoiceGroups[\s\S]*?\{ voices: \[CUSTOM_ROW\] \}/,
    'the Gemini picker must offer Custom voice id… like every cloud provider');
  // Case-insensitive: the engine accepts any case, so a lowercase stored value
  // is that voice rather than a custom one.
  assert.match(groups, /isKnownGeminiVoice[\s\S]*?toLowerCase\(\)/);
  // Choosing the Gemini card must land on a voice, not on an empty custom box.
  assert.match(editor, /onChange\(\{ engine: GEMINI_CLOUD_PROVIDER, voice: defaultGeminiVoice\(\) \}\)/,
    'the Gemini card must seed a prebuilt voice, like the cloud cards do');
});

test('the station Voice panel offers model, voice and pronunciation', async () => {
  const fs = await import('node:fs');
  const panel = fs.readFileSync(
    new URL('../../web/components/admin/settings/TtsSection.tsx', import.meta.url), 'utf8');
  // Model list sourced from the generated mirror, so the dropdown and the
  // server's validation cannot drift into offering something save rejects.
  assert.match(panel, /import \{ GEMINI_TTS_MODELS \} from '\.\.\/\.\.\/\.\.\/lib\/schemas\.generated'/);
  assert.match(panel, /GEMINI_TTS_MODELS\.map\(/);
  // '' is the "walk the fallback chain" choice and must survive the round trip.
  assert.match(panel, /<SelectItem value="">Automatic \(fallback chain\)<\/SelectItem>/);
  assert.match(panel, /model: form\.tts\.gemini\?\.model \?\? ''/, 'the payload must send the model');
  assert.match(panel, /voice: form\.tts\.gemini\?\.voice \?\? 'Puck'/, 'the payload must send the voice');
  assert.match(panel, /pronunciation: form\.tts\.gemini\?\.pronunciation \?\? ''/,
    'a blank pronunciation note is a real choice and must survive the round trip');
  // The station pronunciation note is one free-text field, capped at the
  // engine's own bound.
  assert.match(panel, /<Label>Pronunciation notes<\/Label>/);
  assert.match(panel, /maxLength=\{GEMINI_PRONUNCIATION_MAX\}/);
});


test('the cloud-only panel content is gated on the selection, not removed', async () => {
  const fs = await import('node:fs');
  const panel = fs.readFileSync(
    new URL('../../web/components/admin/settings/TtsSection.tsx', import.meta.url), 'utf8');
  // Gemini reaches Google directly with its own key field, so the OpenAI
  // connection form, model and tuning knobs must not render under a Gemini
  // selection — the operator never chose them. Gated, not deleted: the same
  // block still serves every other provider.
  assert.match(panel, /\{isCloudEngine && !geminiSelected && \(\(\) => \{/,
    'the cloud block must be gated on !geminiSelected');
});

test('both panels derive the Gemini selection from the one stored engine id', async () => {
  const fs = await import('node:fs');
  const panel = fs.readFileSync(
    new URL('../../web/components/admin/settings/TtsSection.tsx', import.meta.url), 'utf8');
  const meta = fs.readFileSync(
    new URL('../../web/components/admin/tts/engineMeta.ts', import.meta.url), 'utf8');
  // One stored field decides both panels. If the engine grid highlighted by the
  // raw id while the provider grid selected by the same id, they could disagree.
  assert.match(panel, /const geminiSelected = form\.tts\.defaultEngine === GEMINI_CLOUD_PROVIDER;/);
  assert.match(panel, /engineCategory\(form\.tts\.defaultEngine\)/,
    'the engine grid must highlight through engineCategory');
  // The two helpers are always written together and never read apart.
  assert.match(meta, /export function engineCategory\(engine: string\): string \{\s*return engine === GEMINI_CLOUD_PROVIDER \? 'cloud' : engine;/);
  assert.match(meta, /export function engineForCloudProvider\(provider: string\): string \{\s*return provider === GEMINI_CLOUD_PROVIDER \? GEMINI_CLOUD_PROVIDER : 'cloud';/);
});

test('gemini still reads the standard key, never the pool', async () => {
  const fs = await import('node:fs');
  const gemini = fs.readFileSync(new URL('../src/audio/gemini.ts', import.meta.url), 'utf8');
  // The pool is a separate feature with its own PR. Reading it here would make
  // the voice engine depend on an LLM setting and silently change which key
  // speaks once a pool exists.
  assert.doesNotMatch(gemini, /google-key-pool|currentKey/,
    'the Gemini voice engine must read GOOGLE_GENERATIVE_AI_API_KEY only');
  assert.match(gemini, /process\.env\.GOOGLE_GENERATIVE_AI_API_KEY/);
});
