// Merges the voices discovered from a cloud TTS provider with the curated
// fallback list into VoicePicker groups. Shared by the Personas page
// (per-persona voice) and the Settings page (the station-wide default) so the
// two can't drift.
//
// Per provider:
//   openai-compatible — no curated list exists (ids are server-specific), so
//     the picker is entirely discovered. With nothing discovered the caller
//     shows the free-text input instead.
//   elevenlabs — discovered first under "Your voices" (this is where an
//     operator's *cloned* voices show up, which a hardcoded list can never
//     know about), then any curated stock voice the account didn't return.
//   openai — never discoverable; the curated list is complete by construction.
import { CLOUD_VOICES } from './cloudVoices';
import type { VoicePickerGroup } from '../components/admin/tts/VoicePicker';
import type { DiscoveredVoice } from '../hooks/useVoiceDiscovery';

// Sentinel for the "type your own id" action row. Not a voice — the call site
// maps it to '' on selection.
export const CUSTOM_VOICE_ID = '__custom__';

const CUSTOM_ROW = { id: CUSTOM_VOICE_ID, label: 'Custom voice id…', previewVoice: null };

// Providers with a voice-list endpoint. Mirrors listVoices() in
// controller/src/llm/internal/speech/voice-catalog.ts.
export function providerSupportsDiscovery(provider: string): boolean {
  return provider === 'openai-compatible' || provider === 'elevenlabs';
}

function curatedFor(provider: string) {
  return CLOUD_VOICES[provider as keyof typeof CLOUD_VOICES] || [];
}

/**
 * Every voice id the picker can offer for this provider — the test for
 * "is the current value a known voice, or a custom one?". Callers use it both
 * to decide whether to reveal the free-text input and to avoid clobbering a
 * valid selection when the engine or provider changes.
 */
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

/**
 * Build the grouped option list for a cloud provider. Always ends with the
 * "Custom voice id…" action row so an operator can enter an id the server
 * never advertised.
 */
export function buildCloudVoiceGroups(provider: string, discovered: DiscoveredVoice[]): VoicePickerGroup[] {
  const curated = curatedFor(provider);
  const groups: VoicePickerGroup[] = [];

  if (discovered.length) {
    const discoveredIds = new Set(discovered.map(v => v.id));
    // Discovered wins on an id collision — it carries the operator's own name
    // for the voice, which beats our stock label.
    const rest = curated.filter(v => !discoveredIds.has(v.id));
    groups.push({
      label: provider === 'elevenlabs' ? 'Your voices' : 'Discovered',
      voices: discovered.map(v => ({ id: v.id, label: v.label, hint: v.hint })),
    });
    if (rest.length) groups.push({ label: 'Presets', voices: rest.map(v => ({ id: v.id, label: v.label })) });
  } else if (curated.length) {
    // Unlabelled single group — matches how the picker looked before discovery.
    groups.push({ voices: curated.map(v => ({ id: v.id, label: v.label })) });
  }

  groups.push({ voices: [CUSTOM_ROW] });
  return groups;
}
