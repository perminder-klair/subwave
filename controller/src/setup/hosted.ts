// Hosted mode (SUBWAVE_HOSTED=1): a station run by SUB/WAVE Cloud, whose box
// agent owns the LLM route (the DJ Brain) and the voice engine. The agent
// writes those into settings.json itself; this module is the station's side of
// that contract, so the wizard and the settings API can't overwrite them.
//
// Managed: everything under `llm`, and the voice engine choice plus each
// engine's provider config. Still the operator's: whether the DJ speaks, the
// Kokoro voice and language, gain/speed, voice levelling, pronunciation
// corrections, personas, and every non-voice setting. API keys for LLM and
// voice providers are dropped too (the brain token is the only one in use);
// other keys (web search, scrobbling) still save.

import { LLM_KEY_ENV_VARS } from '../schemas/providers.js';

export function isHosted(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.SUBWAVE_HOSTED || '').trim().toLowerCase());
}

// tts.* keys the agent owns on a hosted station.
export const HOSTED_TTS_KEYS = ['defaultEngine', 'cloud', 'remote', 'gemini', 'chatterbox', 'pocketTts', 'heavyEnabled', 'fallback'] as const;

// Voice provider keys; LLM ones come from the provider table.
const HOSTED_SECRET_KEYS = new Set<string>([...LLM_KEY_ENV_VARS, 'ELEVENLABS_API_KEY', 'FISH_API_KEY']);

// A settings patch with the managed keys removed. Returns the paths it dropped
// so a caller can tell the operator. Never mutates the input.
export function stripManagedSettings(patch: Record<string, any>): { patch: Record<string, any>; dropped: string[] } {
  if (!isHosted() || !patch || typeof patch !== 'object') return { patch, dropped: [] };
  const out: Record<string, any> = { ...patch };
  const dropped: string[] = [];
  if ('llm' in out) {
    delete out.llm;
    dropped.push('llm');
  }
  if (out.tts && typeof out.tts === 'object' && !Array.isArray(out.tts)) {
    const tts = { ...out.tts };
    for (const k of HOSTED_TTS_KEYS) {
      if (k in tts) {
        delete tts[k];
        dropped.push(`tts.${k}`);
      }
    }
    if (Object.keys(tts).length) out.tts = tts;
    else delete out.tts;
  }
  return { patch: out, dropped };
}

// API keys with the LLM and voice provider keys removed.
export function stripManagedSecrets(patch: Record<string, string>): Record<string, string> {
  if (!isHosted()) return patch;
  return Object.fromEntries(Object.entries(patch).filter(([k]) => !HOSTED_SECRET_KEYS.has(k)));
}
