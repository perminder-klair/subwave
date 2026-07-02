// Shared types for the personas editor (/admin/personas). Split out of
// PersonasPanel so the presentational sub-components can share one shape.

export interface PersonaTts {
  engine: 'piper' | 'kokoro' | 'chatterbox' | 'pocket-tts' | 'cloud' | 'remote' | string;
  cloudProvider: string;
  voice: string;
  // Per-persona voice-level trim in dB (−12..+12, default 0 = no change). Stacks
  // on top of the per-engine gain. See controller settings.ts:clampTtsGain.
  gainDb: number;
  // Per-persona speech-rate multiplier (0.5..2.0×, default 1.0 = no change).
  // Composes with the per-engine speed + daypart energy. Honoured by
  // Piper/Kokoro/cloud only. See controller settings.ts:clampTtsSpeed.
  speed: number;
}

export interface Persona {
  id: string;
  name: string;
  tagline: string;
  frequency: string;
  scriptLength: string;
  // When true the persona behaves like a working DJ — back-announces AND teases
  // what's next, runs callbacks across the session, and is more present. Off =
  // the historical tasteful-narrator behaviour.
  djMode: boolean;
  // Tone dials, 0–10, default 5 (neutral). Map to prompt bands server-side.
  humour: number;
  localColour: number;
  warmth: number;
  soul: string;
  // Free-text on-air language ("Turkish", "Türkçe"). Empty = English (no
  // directive injected server-side).
  language: string;
  // Stored basename like `p_abc123.png` — empty when no avatar is uploaded.
  // The actual image is served via /api/persona-avatar/<id>; we keep the
  // basename in state only so the form round-trips it on save.
  avatar: string;
  tts: PersonaTts;
  skills: string[];
}

export interface FormState {
  personas: Persona[];
  activePersonaId: string;
  useCustomPrompt: boolean;
  systemPrompt: string;
}

export interface SkillCatalogEntry {
  name: string;
  label?: string;
  description?: string;
}

export interface VoiceOption {
  id: string;
  label: string;
}

export interface SettingsResponse {
  // The persona actually on air right now — resolves a scheduled show's owner
  // when a show is live this hour, otherwise the admin-selected default. The
  // roster/hero mark "on air" by this; `values.activePersonaId` is only the
  // default. Optional so the UI degrades against older controllers.
  onAir?: {
    personaId?: string;
    show?: { id: string; name: string } | null;
  };
  values?: {
    personas?: Array<Partial<Persona> & { avatar?: string }>;
    activePersonaId?: string;
    djPrompt?: string;
    tts?: { defaultEngine?: string };
  };
  defaults?: { djPrompt?: string };
  skills?: { catalog?: SkillCatalogEntry[] };
  tts?: {
    kokoroVoices?: string[];
    kokoroVoiceLanguages?: Record<string, string>;
    piperVoices?: string[];
    chatterboxVoices?: string[];
    // `voiceDir` is the new shared name (issue #213). `chatterboxVoiceDir` is
    // kept as an alias so the UI keeps working against older controllers.
    voiceDir?: string;
    chatterboxVoiceDir?: string;
    pocketTtsVoices?: VoiceOption[];
    pocketTtsCustomVoices?: string[];
    available?: Record<string, boolean>;
    cloudProviders?: string[];
  };
  env?: Record<string, unknown>;
}
