import { PERSONA_VOICE_STYLE_MAX } from '../schemas/persona.js';

// Persisted by versions before the half-budget cap; larger values were never valid.
const LEGACY_VOICE_STYLE_MAX = 300;

/** Migrate only formerly valid directives. Other errors still reach strict validation. */
export function migrateImportedPersona(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('voiceStyle' in raw)) return raw;
  if (typeof raw.voiceStyle !== 'string') return raw;
  const style = raw.voiceStyle.trim();
  if (style.length <= PERSONA_VOICE_STYLE_MAX || style.length > LEGACY_VOICE_STYLE_MAX) return raw;
  return { ...raw, voiceStyle: style.slice(0, PERSONA_VOICE_STYLE_MAX) };
}
