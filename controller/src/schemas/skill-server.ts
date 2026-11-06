// Server-only skill rules: the skill-file bodies with the voice override
// attached, and the lenient SKILL.md read of that override. The per-engine
// voice rules live in schemas/persona.ts, and schemas/skill.ts may import only
// zod so it can be copied into the browser bundle, so they meet here.
import { TTS_ENGINES, repairTtsVoiceSlot, ttsVoiceSlotSchema } from './persona.js';
import {
  builtinSkillFileSchema,
  customSkillFileSchema,
  skillCreateSchema,
  withSkillVoice,
  type SkillVoiceSlot,
} from './skill.js';

const voiceSlot = ttsVoiceSlotSchema('voice');

// POST /dj/skills, PUT /dj/skills/:kind/file and the community install. The
// skill editor composes the same two pieces from the mirror.
export const builtinSkillFileBodySchema = withSkillVoice(builtinSkillFileSchema, voiceSlot);
export const customSkillFileBodySchema = withSkillVoice(customSkillFileSchema, voiceSlot);
export const skillCreateBodySchema = withSkillVoice(skillCreateSchema, voiceSlot);

// The override's flat SKILL.md keys, one line each so a hand edit stays simple.
export const SKILL_VOICE_KEYS = {
  engine: 'voiceEngine',
  voice: 'voiceId',
  cloudProvider: 'voiceProvider',
} as const;

/**
 * The lenient disk read of a skill's voice override, the twin of the strict
 * body schemas above. Its output always passes them.
 *
 * Two outcomes differ from a persona's repair, because a skill has somewhere
 * safe to land that a persona does not, the on-air DJ's own voice:
 * - an engine that isn't a real one (absent, a typo, `inherit`) reads as no
 *   override, where a persona is repaired to piper;
 * - a blank ElevenLabs or Fish voice reads as no override. repairTtsVoiceSlot
 *   fills a blank managed-cloud voice with `alloy`, which is an OpenAI id:
 *   neither provider hosts it, so every render would fail into the rescue chain.
 *
 * Anything else is repaired the way a persona's slot is: a voice the engine
 * can't use (a path, a bad Kokoro id, a missing PocketTTS voice) is reset to
 * that engine's default, and an unknown provider to openai.
 */
export function normalizeSkillVoice(data: Record<string, unknown> | null | undefined): SkillVoiceSlot | null {
  if (!data) return null;
  const engine = String(data[SKILL_VOICE_KEYS.engine] ?? '').trim();
  if (!(TTS_ENGINES as readonly string[]).includes(engine)) return null;
  const voice = String(data[SKILL_VOICE_KEYS.voice] ?? '').trim();
  const slot = repairTtsVoiceSlot({
    engine,
    voice,
    cloudProvider: String(data[SKILL_VOICE_KEYS.cloudProvider] ?? '').trim(),
  });
  if (
    engine === 'cloud'
    && !voice
    && (slot.cloudProvider === 'elevenlabs' || slot.cloudProvider === 'fish-audio')
  ) {
    return null;
  }
  return { engine: slot.engine, voice: slot.voice, cloudProvider: slot.cloudProvider };
}
