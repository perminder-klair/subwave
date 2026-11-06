// Pins for the per-skill TTS voice override (SKILL.md
// voiceEngine/voiceId/voiceProvider → cap.voice → the speaker's tts slot).
//
// Three contracts:
//   • both paths run persona's voice-slot rules, never a copy: the strict body
//     schemas wrap ttsVoiceSlotSchema and the disk read wraps
//     repairTtsVoiceSlot (schemas/skill-server.ts), so every TTS engine is
//     reachable and the disk read's output always passes the form.
//   • the disk read is lenient: a bad engine, or a blank ElevenLabs/Fish voice,
//     reads as no override and the skill still loads; any other voice the
//     engine can't use (a path among them) is repaired as a persona's is.
//   • skillVoiceFor swaps only the voice; co-hosted exchanges keep roster
//     voices (scripts/skill-voice-runtime.test.ts drives the air-time half).
//
// Run: `npm test -- skill-voice`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TTS_ENGINES, TTS_VOICE_MAX } from '../src/schemas/persona.js';
import { customSkillFileSchema, skillFieldsFrom } from '../src/schemas/skill.js';
import {
  builtinSkillFileBodySchema,
  customSkillFileBodySchema,
  normalizeSkillVoice,
} from '../src/schemas/skill-server.js';

// _agent.ts pulls the settings/queue chain at module scope; the runner's
// STATE_DIR is already set by then.
const { skillVoiceFor } = await import('../src/skills/_agent.js');

const strictVoice = (voice: unknown) => builtinSkillFileBodySchema.safeParse({ brief: 'Say things.', voice });
const issues = (r: ReturnType<typeof strictVoice>) => (r.success ? [] : r.error.issues.map(i => i.message));

// ── The disk read ────────────────────────────────────────────────────────────

test('normalizeSkillVoice: absent engine reads as no override', () => {
  assert.equal(normalizeSkillVoice({}), null);
  assert.equal(normalizeSkillVoice({ voiceId: 'Tyrone' }), null);
  assert.equal(normalizeSkillVoice(null), null);
});

test('normalizeSkillVoice: an engine that is not a real one reads as no override', () => {
  assert.equal(normalizeSkillVoice({ voiceEngine: 'elevenlabs-direct' }), null);
  // A persona may inherit the station voice; a skill override that inherits
  // would be no override at all, so it reads as none rather than as piper.
  assert.equal(normalizeSkillVoice({ voiceEngine: 'inherit' }), null);
});

test('normalizeSkillVoice: every TTS engine is reachable from a skill', () => {
  // The skill surface reads persona's own engine list, so a new engine needs
  // no skill edit. Each one, with no voice, still reads as an override.
  for (const engine of TTS_ENGINES) {
    assert.equal(normalizeSkillVoice({ voiceEngine: engine })?.engine, engine, engine);
  }
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
  assert.equal(
    normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: 'Kore', voiceProvider: 'elevenlabs' })?.voice,
    'Kore', 'an explicit provider voice must survive',
  );
  assert.equal(
    normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: 'my-server-voice', voiceProvider: 'openai-compatible' })?.voice,
    'my-server-voice', 'an explicit compatible voice must survive',
  );
});

test('normalizeSkillVoice: a voice the engine cannot use is repaired as a persona slot is', () => {
  const cases: Array<[Record<string, string>, string, string]> = [
    [{ voiceEngine: 'kokoro' }, 'bf_isabella', 'a blank kokoro voice takes the kokoro floor'],
    [{ voiceEngine: 'kokoro', voiceId: 'not a kokoro' }, 'bf_isabella', 'a malformed kokoro id takes the floor'],
    [{ voiceEngine: 'pocket-tts' }, 'alba', 'a blank pocket-tts voice takes its default'],
    [{ voiceEngine: 'pocket-tts', voiceId: 'Not A Voice!' }, 'alba', 'a malformed pocket-tts id takes its default'],
    [{ voiceEngine: 'chatterbox', voiceId: 'foo bar' }, '', 'a bad chatterbox file is its built-in voice'],
    [{ voiceEngine: 'piper', voiceId: 'foo' }, '', 'a bad piper file is its built-in voice'],
    [{ voiceEngine: 'piper', voiceId: 'bf_isabella' }, 'bf_isabella', 'piper keeps a Kokoro-shaped id, as a persona does'],
  ];
  for (const [data, voice, why] of cases) {
    assert.equal(normalizeSkillVoice(data)?.voice, voice, why);
  }
});

test('normalizeSkillVoice: a path never reaches an engine that reads files', () => {
  // chatterbox and pocket-tts resolve the voice as a reference .wav and piper
  // as an .onnx, so a hand-edited or imported SKILL.md must not smuggle a path
  // in. Persona's rules reset each to the engine's default.
  assert.equal(normalizeSkillVoice({ voiceEngine: 'chatterbox', voiceId: '/etc/passwd' })?.voice, '');
  assert.equal(normalizeSkillVoice({ voiceEngine: 'chatterbox', voiceId: '../../x.wav' })?.voice, '');
  assert.equal(normalizeSkillVoice({ voiceEngine: 'pocket-tts', voiceId: '../../x.wav' })?.voice, 'alba');
  assert.equal(normalizeSkillVoice({ voiceEngine: 'piper', voiceId: 'C:\\voices\\a.onnx' })?.voice, '');
});

test('normalizeSkillVoice: a remote voice id is free text, slashes included', () => {
  // The remote sidecar interprets its own ids and reads no file here, so a
  // skill takes the same ids a persona does.
  assert.equal(normalizeSkillVoice({ voiceEngine: 'remote', voiceId: 'en/female-1' })?.voice, 'en/female-1');
});

test('normalizeSkillVoice: a managed cloud provider without a shared default voice reads as no override', () => {
  assert.equal(
    normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: '', voiceProvider: 'openai' })?.voice,
    'alloy',
    'alloy is an OpenAI voice id, so it is a real default there',
  );
  for (const provider of ['elevenlabs', 'fish-audio']) {
    assert.equal(
      normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: '', voiceProvider: provider }),
      null,
      `${provider} hosts no alloy; an override that fails every render is no override`,
    );
  }
  const compatible = normalizeSkillVoice({ voiceEngine: 'cloud', voiceId: '', voiceProvider: 'openai-compatible' });
  assert.equal(compatible?.voice, '', 'openai-compatible reads empty as "the server picks"');
  assert.equal(compatible?.cloudProvider, 'openai-compatible');
});

test('normalizeSkillVoice: an unknown provider is openai, and an over-long voice is cut', () => {
  assert.deepEqual(
    normalizeSkillVoice({ voiceEngine: 'cloud', voiceProvider: 'bogus' }),
    { engine: 'cloud', voice: 'alloy', cloudProvider: 'openai' },
  );
  const long = 'x'.repeat(TTS_VOICE_MAX + 20);
  assert.equal(normalizeSkillVoice({ voiceEngine: 'remote', voiceId: long })?.voice.length, TTS_VOICE_MAX);
});

test('normalizeSkillVoice: every override it reads passes the strict body schema', () => {
  // The two paths agree because both run persona's rules: whatever loads from
  // disk, the editor can save back unchanged.
  const disk: Record<string, string>[] = [
    { voiceEngine: 'kokoro' },
    { voiceEngine: 'kokoro', voiceId: 'not a kokoro' },
    { voiceEngine: 'pocket-tts' },
    { voiceEngine: 'chatterbox', voiceId: '/etc/passwd' },
    { voiceEngine: 'piper', voiceId: 'foo' },
    { voiceEngine: 'cloud', voiceProvider: 'bogus' },
    { voiceEngine: 'cloud', voiceProvider: 'openai-compatible' },
    { voiceEngine: 'remote', voiceId: 'en/female-1' },
    { voiceEngine: 'remote', voiceId: 'x'.repeat(TTS_VOICE_MAX + 20) },
    ...TTS_ENGINES.map(engine => ({ voiceEngine: engine })),
  ];
  for (const data of disk) {
    const voice = normalizeSkillVoice(data);
    assert.ok(voice, JSON.stringify(data));
    const r = strictVoice(voice);
    assert.equal(r.success, true, `${JSON.stringify(data)} → ${JSON.stringify(voice)}: ${issues(r).join('; ')}`);
    assert.deepEqual(r.success && r.data.voice, voice, 'and the form keeps it as it is');
  }
});

// ── The strict body schemas ──────────────────────────────────────────────────

test('strict schema: absent or null reads as no override', () => {
  for (const voice of [null, undefined]) {
    const r = strictVoice(voice);
    assert.equal(r.success, true);
    assert.equal(r.success && r.data.voice, null);
  }
  // No `voice` key at all, as a community install or an older client sends.
  for (const schema of [builtinSkillFileBodySchema, customSkillFileBodySchema]) {
    const r = schema.safeParse({ brief: 'Say things.' });
    assert.equal(r.success, true, r.success ? '' : r.error.issues.map(i => i.message).join('; '));
    assert.equal(r.success && r.data.voice, null);
  }
  assert.deepEqual(issues(strictVoice('remote')), ['voice must be an object or null']);
  assert.deepEqual(issues(strictVoice(['remote'])), ['voice must be an object or null']);
});

test('strict schema: the voice rules are persona\'s, messages included', () => {
  assert.deepEqual(
    issues(strictVoice({ engine: 'kokoro', voice: 'nope', cloudProvider: 'openai' })),
    ['voice.voice must match <lang><gender>_<name> for kokoro, e.g. bf_isabella'],
  );
  assert.deepEqual(
    issues(strictVoice({ engine: 'chatterbox', voice: '/etc/passwd', cloudProvider: 'openai' })),
    ['voice.voice for chatterbox must be a .wav filename (no path), or empty for the default voice'],
  );
  assert.match(issues(strictVoice({ engine: 'inherit', voice: '', cloudProvider: 'openai' }))[0], /^voice\.engine must be one of: /);
  assert.match(issues(strictVoice({ engine: 'cloud', voice: 'v', cloudProvider: 'bogus' }))[0], /^voice\.cloudProvider must be one of: /);
  assert.equal(strictVoice({ engine: 'remote', voice: 'en/female-1', cloudProvider: 'openai' }).success, true,
    'a remote id with a slash is accepted, as on a persona');
});

test('strict schema: a managed cloud provider needs a voice; openai-compatible does not', () => {
  for (const provider of ['openai', 'elevenlabs', 'fish-audio']) {
    assert.deepEqual(issues(strictVoice({ engine: 'cloud', voice: '', cloudProvider: provider })),
      ['voice.voice must be 1-100 chars'], provider);
  }
  assert.equal(strictVoice({ engine: 'cloud', voice: '', cloudProvider: 'openai-compatible' }).success, true);
});

test('strict schema: a missing provider is openai, engines are trimmed, gain and speed are dropped', () => {
  const r = strictVoice({ engine: ' remote ', voice: 'Tyrone', gainDb: 6, speed: 1.5 });
  assert.equal(r.success, true);
  assert.deepEqual(r.success && r.data.voice, { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' },
    'an override changes the voice, never the speaker\'s gain or speed');
});

test('skillFieldsFrom carries the voice through to writeSkillFile', () => {
  const parsed = customSkillFileBodySchema.parse({
    brief: 'Say things.',
    voice: { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' },
  });
  assert.deepEqual(skillFieldsFrom('bulletin', parsed).voice, { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' });
  // A body parsed without the override attached carries none.
  assert.equal(skillFieldsFrom('bulletin', customSkillFileSchema.parse({ brief: 'Say things.' })).voice, null);
});

// ── Air time ─────────────────────────────────────────────────────────────────

test('skillVoiceFor: no override returns the speaker untouched', () => {
  const speaker = { id: 'p_x', tts: { engine: 'piper', voice: '', cloudProvider: 'openai' } };
  const r = skillVoiceFor({ kind: 'news', voice: null }, speaker);
  assert.equal(r.overridden, false);
  assert.equal(r.persona, speaker);
});

test('skillVoiceFor: override replaces the voice, keeping speaker identity, gain and speed', () => {
  const speaker = { id: 'p_x', name: 'X', tts: { engine: 'piper', voice: '', cloudProvider: 'openai', gainDb: 2, speed: 1.1 } };
  const r = skillVoiceFor(
    { kind: 'bulletin', voice: { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' } },
    speaker,
  );
  assert.equal(r.overridden, true);
  assert.equal(r.persona.id, 'p_x');
  assert.equal(r.persona.name, 'X');
  assert.equal(r.persona.tts.engine, 'remote');
  assert.equal(r.persona.tts.voice, 'Tyrone');
  assert.equal(r.persona.tts.gainDb, 2);
  assert.equal(r.persona.tts.speed, 1.1);
});

test('skillVoiceFor: a missing speaker does not throw', () => {
  const r = skillVoiceFor(
    { kind: 'bulletin', voice: { engine: 'kokoro', voice: 'bf_isabella', cloudProvider: 'openai' } },
    null,
  );
  assert.equal(r.overridden, true);
  assert.equal(r.persona.tts.engine, 'kokoro');
  assert.equal(r.persona.tts.voice, 'bf_isabella');
});

// ── SKILL.md ─────────────────────────────────────────────────────────────────

test('SKILL.md round trip: voice lines written, read back, and cleared', async () => {
  const stateDir = process.env.STATE_DIR as string;
  const { writeSkillFile } = await import('../src/skills/scaffold.js');
  const { parseFrontmatter } = await import('../src/skills/loader.js');
  const file = join(stateDir, 'skills', 'bulletin', 'SKILL.md');

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
  const md = readFileSync(file, 'utf8');
  assert.match(md, /^voiceEngine: remote$/m);
  assert.match(md, /^voiceId: Tyrone$/m);
  assert.doesNotMatch(md, /^voiceProvider:/m, 'the provider means nothing to a non-cloud engine, so it is not written');
  assert.deepEqual(normalizeSkillVoice(parseFrontmatter(md).data), { engine: 'remote', voice: 'Tyrone', cloudProvider: 'openai' });

  await writeSkillFile({ ...base, voice: { engine: 'cloud', voice: 'Rachel', cloudProvider: 'elevenlabs' } });
  const cloud = readFileSync(file, 'utf8');
  assert.match(cloud, /^voiceProvider: elevenlabs$/m);
  assert.deepEqual(normalizeSkillVoice(parseFrontmatter(cloud).data), { engine: 'cloud', voice: 'Rachel', cloudProvider: 'elevenlabs' });

  await writeSkillFile({ ...base, voice: null });
  const cleared = readFileSync(file, 'utf8');
  assert.doesNotMatch(cleared, /^voice(Engine|Id|Provider):/m);
  assert.equal(normalizeSkillVoice(parseFrontmatter(cleared).data), null);
});
