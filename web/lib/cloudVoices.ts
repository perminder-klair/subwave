// Curated default voices per cloud TTS provider. A free-text "Custom voice id…"
// override sits next to every dropdown, so this only needs the common picks.
import type { CloudProvider, CloudVoice } from './types';

export const CLOUD_VOICES: Record<CloudProvider, CloudVoice[]> = {
  openai: [
    { id: 'alloy',   label: 'Alloy' },
    { id: 'ash',     label: 'Ash' },
    { id: 'ballad',  label: 'Ballad' },
    { id: 'coral',   label: 'Coral' },
    { id: 'echo',    label: 'Echo' },
    { id: 'fable',   label: 'Fable' },
    { id: 'nova',    label: 'Nova' },
    { id: 'onyx',    label: 'Onyx' },
    { id: 'sage',    label: 'Sage' },
    { id: 'shimmer', label: 'Shimmer' },
  ],
  elevenlabs: [
    { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' },
    { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi' },
    { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' },
    { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni' },
    { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli' },
    { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh' },
    { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold' },
    { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam' },
    { id: 'yoZ06aMxZJJ28mfd3POQ', label: 'Sam' },
  ],
  // Discovered from GET /model?self=true. Keep the static catalogue empty so
  // manual public/custom reference IDs remain valid.
  'fish-audio': [],
  // Server-specific ids (Chatterbox cloning refs, Qwen3 speaker names), so no
  // curated list. The UI falls back to free text when this array is empty.
  'openai-compatible': [],
};

// The Model field is free text, but this drives the default when an operator
// switches provider: a model id is provider-specific, so an OpenAI id like
// "gpt-4o-mini-tts" is invalid against ElevenLabs. First entry is the default.
export const CLOUD_MODELS: Record<CloudProvider, string[]> = {
  openai: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  elevenlabs: ['eleven_flash_v2_5', 'eleven_v4_turbo', 'eleven_v4', 'eleven_v3_conversational', 'eleven_v3', 'eleven_multilingual_v2'],
  'fish-audio': ['s2.1-pro', 's2.1-pro-free'],
  // Server-specific model ids. Free text only.
  'openai-compatible': [],
};
