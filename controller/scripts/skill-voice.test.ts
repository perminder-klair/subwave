// Pins for the per-skill TTS voice override (SKILL.md
// voiceEngine/voiceId/voiceProvider → cap.voice → the speaker's tts slot).
//
// Three contracts:
//   • the skill engine/provider vocabularies stay identical to the persona
//     originals (restated, not imported — schemas/* may import only zod).
//   • the disk read is lenient (bad engine or path-like voice id → no
//     override, skill still loads) while the form schema refuses loudly.
//     Path-like ids are refused because chatterbox/pocket-tts resolve them
//     as reference files — skill metadata must never smuggle a filesystem
//     read past the admin form.
//   • skillVoiceFor applies the slot at air time, including speaker-less
//     Run now calls; co-hosted exchanges keep roster voices.
//
// Run: `npm test -- skill-voice`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// STATE_DIR must be set before anything config-derived is imported —
// skills/_agent.ts pulls the settings/queue chain (and its STATE_DIR) at
// module scope, so even the helper import waits for the dynamic block below.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.STATE_DIR ??= mkdtempSync(join(tmpdir(), 'skill-voice-test-'));

import {
  SKILL_VOICE_ENGINES,
  SKILL_VOICE_PROVIDERS,
  builtinSkillFileSchema,
  normalizeSkillVoice,
  skillFieldsFrom,
} from '../src/schemas/skill.js';

const { skillVoiceFor } = await import('../src/skills/_agent.js');

test('skill voice vocabularies match the persona originals', async () => {
  const persona = await import('../src/schemas/persona.js');
  // The message names the fix, because this pin is the ONLY thing that catches
  // a new TTS_ENGINES entry arriving without its restated copy here — and a
  // bare deepEqual diff reads as "these two lists drifted" with no next step.
  const missing = [...persona.TTS_ENGINES].filter(e => !(SKILL_VOICE_ENGINES as readonly string[]).includes(e));
  const extra = [...SKILL_VOICE_ENGINES].filter(e => !(persona.TTS_ENGINES as readonly string[]).includes(e));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    missing.length
      ? `SKILL_VOICE_ENGINES is missing ${missing.join(', ')} — add it to `
        + `schemas/skill.ts (a restated copy of persona TTS_ENGINES, which may `
        + `not import across here). This is expected when landing the gemini-TTS PR.`
      : `SKILL_VOICE_ENGINES has ${extra.join(', ')} but persona TTS_ENGINES does `
        + `not — remove it, or the engines the two surfaces accept have diverged.`,
  );
  assert.deepEqual([...SKILL_VOICE_PROVIDERS], [...persona.TTS_CLOUD_PROVIDERS]);
});

test('normalizeSkillVoice: absent engine reads as no override', () => {
  assert.equal(normalizeSkillVoice({}), null);
  assert.equal(normalizeSkillVoice({ voiceId: 'Tyrone' }), null);
  assert.equal(normalizeSkillVoice(null), null);
});

test('normalizeSkillVoice: bad engine reads as no override, skill still loads', () => {
  assert.equal(normalizeSkillVoice({ voiceEngine: 'elevenlabs-direct' }), null);
});

test('normalizeSkillVoice: path-like voice ids read as no override', () => {
  assert.equal(normalizeSkillVoice({ voiceEngine: 'chatterbox', voiceId: '/etc/passwd' }), null);
  assert.equal(normalizeSkillVoice({ voiceEngine: 'pocket-tts', voiceId: '../../x.wav' }), null);
  assert.equal(normalizeSkillVoice({ voiceEngine: 'remote', voiceId: 'C:\\voices\\a.wav' }), null);
});

test('normalizeSkillVoice: ordinary shapes survive', () => {
  assert.deepEqual(
    normalizeSkillVoice({ voiceEngine: 'remote', voiceId: 'Tyrone', voiceProvider: 'openai' }),
    { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' },
  );
  assert.deepEqual(
    normalizeSkillVoice({ voiceEngine: 'chatterbox', voiceId: 'news.wav' }),
    { engine: 'chatterbox', voice: 'news.wav', cloudProvider: 'openai' },
  );
});

test('strict schema: null reads as no override; paths are refused', () => {
  const out = builtinSkillFileSchema.safeParse({ brief: 'Say things.', voice: null });
  assert.equal(out.success, true);
  assert.equal(out.success && out.data.voice, undefined);
  const bad = builtinSkillFileSchema.safeParse({
    brief: 'Say things.',
    voice: { engine: 'chatterbox', voice: '/etc/passwd', cloudProvider: 'openai' },
  });
  assert.equal(bad.success, false);
});

test('skillFieldsFrom carries the voice through to writeSkillFile', () => {
  const parsed = builtinSkillFileSchema.parse({
    brief: 'Say things.',
    voice: { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' },
  });
  const fields = skillFieldsFrom('bulletin', parsed as never);
  assert.deepEqual(fields.voice, { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' });
});

test('skillVoiceFor: no override returns the speaker untouched', () => {
  const speaker = { id: 'p_x', tts: { engine: 'piper', voice: '', cloudProvider: 'openai' } };
  const r = skillVoiceFor({ kind: 'news', voice: null }, speaker);
  assert.equal(r.overridden, false);
  assert.equal(r.persona, speaker);
});

test('skillVoiceFor: override replaces the tts slot, keeping speaker identity', () => {
  const speaker = { id: 'p_x', name: 'X', tts: { engine: 'piper', voice: '', cloudProvider: 'openai', gainDb: 2, speed: 1 } };
  const r = skillVoiceFor(
    { kind: 'bulletin', voice: { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' } },
    speaker,
  );
  assert.equal(r.overridden, true);
  assert.equal(r.persona.id, 'p_x');
  assert.deepEqual(r.persona.tts.engine, 'remote');
  assert.deepEqual(r.persona.tts.voice, 'Tyrone');
  assert.equal(r.persona.tts.gainDb, 2);
});

test('skillVoiceFor: applies with no speaker (Run now passes none)', () => {
  const r = skillVoiceFor(
    { kind: 'bulletin', voice: { engine: 'kokoro', voice: 'bf_isabella', cloudProvider: 'openai' } },
    null,
  );
  assert.equal(r.overridden, true);
  assert.equal(r.persona.tts.engine, 'kokoro');
  assert.equal(r.persona.tts.voice, 'bf_isabella');
});

test('SKILL.md round trip: voice lines written, read back, and cleared', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const stateDir = process.env.STATE_DIR as string;
  const { writeSkillFile } = await import('../src/skills/scaffold.js');
  const { parseFrontmatter } = await import('../src/skills/loader.js');

  const base = {
    kind: 'bulletin',
    label: 'Bulletin',
    cooldown: '3h',
    tags: [],
    brief: 'Read the bulletin.',
    config: {},
    configKeys: [],
  };
  await writeSkillFile({ ...base, voice: { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' } });
  const md = readFileSync(join(stateDir, 'skills', 'bulletin', 'SKILL.md'), 'utf8');
  assert.match(md, /^voiceEngine: remote$/m);
  assert.match(md, /^voiceId: Tyrone$/m);
  const { data } = parseFrontmatter(md);
  assert.deepEqual(normalizeSkillVoice(data), { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' });

  await writeSkillFile({ ...base, voice: null });
  const cleared = readFileSync(join(stateDir, 'skills', 'bulletin', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(cleared, /^voiceEngine:/m);
  const { data: clearedData } = parseFrontmatter(cleared);
  assert.equal(normalizeSkillVoice(clearedData), null);
});

// A managed cloud provider needs a voice id. Fish sends it as `reference_id`,
// ElevenLabs as the voice name, and OpenAI as `voice`; an empty value reaches
// all three as empty and the render fails into the rescue chain. Every other
// normaliser in the station defaults it — the strict skill schema below does,
// and so do both persona paths — so the disk path being the one that left it
// blank made a hand-written `voiceEngine: cloud` override that could never
// render.
test('a managed cloud provider defaults a blank voice instead of rendering empty', () => {
  for (const provider of ['openai', 'elevenlabs', 'fish-audio']) {
    const out = normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: '', voiceProvider: provider });
    assert.equal(out?.voice, 'alloy',
      `${provider} requires a voice id — an empty one fails every render and falls through `
        + 'the rescue chain instead of leniently reading as "no override"');
    assert.equal(out?.cloudProvider, provider, `${provider} must survive the default`);
  }
});

// The one provider where empty is meaningful: its voices are server-specific,
// so "let the server pick its own default" has to survive normalisation. This is
// the exception that would be lost if the rule above were written as a blanket
// "cloud always gets a voice".
test('openai-compatible keeps a blank voice — empty means the server picks', () => {
  const out = normalizeSkillVoice({
    voiceEngine: 'cloud', voiceId: '', voiceProvider: 'openai-compatible',
  });
  assert.equal(out?.voice, '',
    'openai-compatible voices are server-specific; blank is its documented "use your own default"');
  assert.equal(out?.cloudProvider, 'openai-compatible');
});

// An explicit voice is never overwritten, and the rule does not leak to engines
// that read empty as their own default.
test('the default only fills a blank voice, and only for cloud', () => {
  assert.equal(
    normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: 'Kore', voiceProvider: 'elevenlabs' })?.voice,
    'Kore', 'an explicit provider voice must survive',
  );
  assert.equal(
    normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: 'my-server-voice', voiceProvider: 'openai-compatible' })?.voice,
    'my-server-voice', 'an explicit compatible voice must survive',
  );
  for (const [engine, voice] of [['piper', ''], ['kokoro', ''], ['chatterbox', ''], ['gemini', '']]) {
    assert.equal(normalizeSkillVoice({ voiceEngine: engine, voiceId: voice, voiceProvider: 'openai' })?.voice, '',
      `${engine} reads an empty voice as its own default and must be left alone`);
  }
});
