// Merge discovered and curated voices for both Settings and Personas. OpenAI-compatible has no
// curated list; ElevenLabs and Fish show discovered voices first; OpenAI uses its curated list.
import { CLOUD_VOICES } from './cloudVoices';
import type { VoicePickerGroup } from '../components/admin/tts/VoicePicker';
import type { DiscoveredVoice } from '../hooks/useVoiceDiscovery';

// Sentinel for the "type your own id" action row; the call site maps it to ''.
export const CUSTOM_VOICE_ID = '__custom__';

const CUSTOM_ROW = { id: CUSTOM_VOICE_ID, label: 'Custom voice id…', previewVoice: null };

// Providers with a voice-list endpoint. Mirrors listVoices() in
// controller/src/llm/internal/speech/voice-catalog.ts.
export function providerSupportsDiscovery(provider: string): boolean {
  return provider === 'openai-compatible' || provider === 'elevenlabs' || provider === 'fish-audio';
}

function curatedFor(provider: string) {
  return CLOUD_VOICES[provider as keyof typeof CLOUD_VOICES] || [];
}

/** Every voice id the picker can offer, so callers can tell a known voice from
 *  a custom one without clobbering a valid selection on a provider change. */
export function knownCloudVoiceIds(provider: string, discovered: DiscoveredVoice[]): Set<string> {
  const ids = new Set<string>();
  for (const v of curatedFor(provider)) ids.add(v.id);
  for (const v of discovered) ids.add(v.id);
  return ids;
}

export function isKnownCloudVoice(provider: string, discovered: DiscoveredVoice[], voice: string): boolean {
  const v = voice.trim();
  return !!v && knownCloudVoiceIds(provider, discovered).has(v);
}

// Keep Gemini descriptors shared between the persona and station voice pickers.
const GEMINI_PREBUILT_VOICES: { id: string; label: string }[] = [
  { id: 'Zephyr', label: 'Zephyr — Bright' },
  { id: 'Puck', label: 'Puck — Upbeat' },
  { id: 'Charon', label: 'Charon — Informative' },
  { id: 'Kore', label: 'Kore — Firm' },
  { id: 'Fenrir', label: 'Fenrir — Excitable' },
  { id: 'Leda', label: 'Leda — Youthful' },
  { id: 'Orus', label: 'Orus — Firm' },
  { id: 'Aoede', label: 'Aoede — Breezy' },
  { id: 'Callirrhoe', label: 'Callirrhoe — Easy-going' },
  { id: 'Autonoe', label: 'Autonoe — Bright' },
  { id: 'Enceladus', label: 'Enceladus — Breathy' },
  { id: 'Iapetus', label: 'Iapetus — Clear' },
  { id: 'Umbriel', label: 'Umbriel — Easy-going' },
  { id: 'Algieba', label: 'Algieba — Smooth' },
  { id: 'Despina', label: 'Despina — Smooth' },
  { id: 'Erinome', label: 'Erinome — Clear' },
  { id: 'Algenib', label: 'Algenib — Gravelly' },
  { id: 'Rasalgethi', label: 'Rasalgethi — Informative' },
  { id: 'Laomedeia', label: 'Laomedeia — Upbeat' },
  { id: 'Achernar', label: 'Achernar — Soft' },
  { id: 'Alnilam', label: 'Alnilam — Firm' },
  { id: 'Schedar', label: 'Schedar — Even' },
  { id: 'Gacrux', label: 'Gacrux — Mature' },
  { id: 'Pulcherrima', label: 'Pulcherrima — Forward' },
  { id: 'Achird', label: 'Achird — Friendly' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi — Casual' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix — Gentle' },
  { id: 'Sadachbia', label: 'Sadachbia — Lively' },
  { id: 'Sadaltager', label: 'Sadaltager — Knowledgeable' },
  { id: 'Sulafat', label: 'Sulafat — Warm' },
];

/** The Gemini half of the shared voice field: the 30 prebuilt voices, plus the
 *  same "Custom voice id…" row every cloud provider ends with — so a designed
 *  (`voice_…`) or replicated (`voicekey_…`) id has a home in the picker exactly
 *  where an operator already looks for one. Never discoverable: Google's Voice
 *  Library endpoint is not the prebuilt catalogue (it omits Puck, Zephyr and
 *  Kore entirely), so the curated list here is the complete one. */
export function buildGeminiVoiceGroups(): VoicePickerGroup[] {
  return [{ label: 'Google prebuilt', voices: GEMINI_PREBUILT_VOICES }, { voices: [CUSTOM_ROW] }];
}

/** What the picker shows when the Gemini card is chosen and the slot has no
 *  usable voice yet. Mirrors the cloud branch, which falls back to the first
 *  curated id — landing an operator on an empty "Custom voice id…" box because
 *  they picked a provider card reads as a broken field, not as a choice. */
export function defaultGeminiVoice(): string {
  // noUncheckedIndexedAccess: the list is a literal above, so this cannot be
  // undefined at runtime — but the type says it could be, and the fallback
  // keeps that from becoming a `voice: undefined` write.
  return GEMINI_PREBUILT_VOICES[0]?.id ?? 'Puck';
}

/** True when the saved voice is one of the 30 prebuilt ids. Case-insensitive
 *  because the engine accepts any case (verified — `Charon`/`charon`/`CHARON`
 *  all render) and a persona stored in lowercase is still that voice, not a
 *  custom one. */
export function isKnownGeminiVoice(voice: string): boolean {
  const v = voice.trim().toLowerCase();
  return !!v && GEMINI_PREBUILT_VOICES.some(o => o.id.toLowerCase() === v);
}

/** Always ends with the "Custom voice id…" action row so an operator can enter
 *  an id the server never advertised. */
export function buildCloudVoiceGroups(provider: string, discovered: DiscoveredVoice[]): VoicePickerGroup[] {
  const curated = curatedFor(provider);
  const groups: VoicePickerGroup[] = [];

  if (discovered.length) {
    const discoveredIds = new Set(discovered.map(v => v.id));
    // Discovered wins on an id collision: it carries the operator's own name
    // for the voice, which beats the stock label.
    const rest = curated.filter(v => !discoveredIds.has(v.id));
    groups.push({
      label: provider === 'elevenlabs' || provider === 'fish-audio' ? 'Your voices' : 'Discovered',
      voices: discovered.map(v => ({ id: v.id, label: v.label, hint: v.hint })),
    });
    if (rest.length) groups.push({ label: 'Presets', voices: rest.map(v => ({ id: v.id, label: v.label })) });
  } else if (curated.length) {
    groups.push({ voices: curated.map(v => ({ id: v.id, label: v.label })) });
  }

  groups.push({ voices: [CUSTOM_ROW] });
  return groups;
}
