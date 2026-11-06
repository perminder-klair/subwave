// Hosted mode (SUBWAVE_HOSTED=1): a station run by SUB/WAVE Cloud, whose box
// agent owns the LLM route (the DJ Brain) and the voice engine. The agent
// writes those into settings.json itself; this module is the station's side of
// that contract, so the wizard and the settings API can't overwrite them.
//
// Managed: the LLM route under `llm` (provider, model, endpoint, keys,
// fallback; HOSTED_LLM_KEYS), not the DJ tuning that also lives there (track
// selection, no-repeat and variety windows, request matching, segment
// runtime...); the voice engine choice plus each engine's
// provider config; and the embedding route (provider, model, endpoint, key),
// which also goes through the brain. A persona may only pin an engine the box
// runs (or the brain's cloud voice on a premium station); any other pin
// becomes `inherit`. Still the operator's: whether the DJ speaks, the Kokoro
// voice and language, gain/speed, voice levelling, pronunciation corrections,
// personas (bar that engine rule), the tagger's tuning (on/off, seed count,
// propagation, enrichment), and every non-voice setting. API keys for LLM,
// voice and embedding providers are dropped too (the brain token is the only
// one in use); other keys (web search, scrobbling) still save.

import { LLM_KEY_ENV_VARS } from '../schemas/providers.js';
import { AAC_BITRATES, MP3_BITRATES, OPUS_BITRATES } from '../settings/vocab.js';

export function isHosted(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.SUBWAVE_HOSTED || '').trim().toLowerCase());
}

// llm.* keys that pick where the DJ's LLM runs. The rest of the block is the
// operator's tuning, which the Music selection and DJ behaviour pages save.
export const HOSTED_LLM_KEYS = [
  'provider', 'model', 'baseUrl', 'apiKey', 'keys', 'providerBaseUrls', 'ollamaUrl', 'headers',
  'compatibleMode', 'fallback', 'numCtx', 'repeatPenalty', 'reasoning', 'toolChoice', 'geminiSafety',
] as const;

// stream.* keys the agent owns: the listener ceiling is the plan's (the agent
// sets ICECAST_MAX_CLIENTS on the broadcast container, which wins over this
// setting anyway), so saving another number would only mislead the owner.
export const HOSTED_STREAM_KEYS = ['maxListeners'] as const;

// tts.* keys the agent owns on a hosted station.
export const HOSTED_TTS_KEYS = ['defaultEngine', 'cloud', 'remote', 'gemini', 'chatterbox', 'pocketTts', 'heavyEnabled', 'fallback'] as const;

// embedding.* keys that pick where embeddings come from. The rest of the block
// (enabled, seedCount, propagation, enrichment) is the operator's tuning.
export const HOSTED_EMBEDDING_KEYS = ['provider', 'model', 'providerBaseUrls', 'baseUrl', 'ollamaUrl', 'apiKey', 'headers'] as const;

// The plan's stream bitrate ceiling in kbps (SUBWAVE_MAX_BITRATE, set by the
// box agent from the station's SUB/WAVE Cloud plan). Undefined when not
// hosted or not set: no ceiling.
export function hostedMaxBitrate(env: Record<string, string | undefined> = process.env): number | undefined {
  if (!['1', 'true', 'yes'].includes((env.SUBWAVE_HOSTED || '').trim().toLowerCase())) return undefined;
  const n = Number((env.SUBWAVE_MAX_BITRATE || '').trim());
  return Number.isInteger(n) && n >= 32 && n <= 10000 ? n : undefined;
}

// The highest value of a codec's vocabulary at or under the ceiling, or
// undefined when even its lowest is over it.
function highestUnder(values: readonly number[], max: number): number | undefined {
  return [...values].filter((v) => v <= max).sort((a, b) => b - a)[0];
}

type StreamBitrates = {
  bitrate: number; aacEnabled: boolean; aacBitrate: number;
  opusEnabled: boolean; opusBitrate: number; flacEnabled: boolean;
};

// The stream settings the encoders actually get under the plan's ceiling:
// each lossy codec above it drops to its highest allowed bitrate (switched off
// if none fits — MP3 always fits, it goes down to 64), and FLAC is off, since
// a lossless mount runs near 1 Mbps a listener. Applied where the settings
// reach Liquidsoap (settings/liquidsoap.ts), so a value saved before the plan
// changed can't exceed it either. No ceiling → returned untouched.
export function capStreamBitrates<T extends StreamBitrates>(stream: T, max = hostedMaxBitrate()): T {
  if (max === undefined) return stream;
  const out = { ...stream };
  if (out.bitrate > max) out.bitrate = highestUnder(MP3_BITRATES, max) ?? Math.min(...MP3_BITRATES);
  if (out.aacBitrate > max) {
    const aac = highestUnder(AAC_BITRATES, max);
    if (aac === undefined) out.aacEnabled = false;
    else out.aacBitrate = aac;
  }
  if (out.opusBitrate > max) {
    const opus = highestUnder(OPUS_BITRATES, max);
    if (opus === undefined) out.opusEnabled = false;
    else out.opusBitrate = opus;
  }
  out.flacEnabled = false;
  return out;
}

// LLM, voice and embedding provider keys; LLM ones come from the provider table.
const HOSTED_SECRET_KEYS = new Set<string>([...LLM_KEY_ENV_VARS, 'ELEVENLABS_API_KEY', 'FISH_API_KEY', 'EMBEDDING_API_KEY']);

// The engines a persona may pin on a hosted station: the station default
// (inherit) and the two local engines the box runs, plus the brain's cloud
// voice when the station itself speaks through it (premium). Heavy engines
// aren't on hosted boxes, and a cloud pin on a base station would need a key
// of the owner's own, which hosted mode doesn't store.
export function hostedPersonaEngines(defaultEngine: unknown): string[] {
  return ['inherit', 'kokoro', 'piper', ...(defaultEngine === 'cloud' ? ['cloud'] : [])];
}

// A settings patch with the managed keys removed. Returns the paths it dropped
// so a caller can tell the operator. Never mutates the input.
export function stripManagedSettings(
  patch: Record<string, any>,
  { defaultEngine }: { defaultEngine?: unknown } = {},
): { patch: Record<string, any>; dropped: string[] } {
  if (!isHosted() || !patch || typeof patch !== 'object') return { patch, dropped: [] };
  const out: Record<string, any> = { ...patch };
  const dropped: string[] = [];
  if (out.llm && typeof out.llm === 'object' && !Array.isArray(out.llm)) {
    const llm = { ...out.llm };
    for (const k of HOSTED_LLM_KEYS) {
      if (k in llm) {
        delete llm[k];
        dropped.push(`llm.${k}`);
      }
    }
    if (Object.keys(llm).length) out.llm = llm;
    else delete out.llm;
  } else if ('llm' in out) {
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
  if (out.stream && typeof out.stream === 'object' && !Array.isArray(out.stream)) {
    const stream = { ...out.stream };
    for (const k of HOSTED_STREAM_KEYS) {
      if (k in stream) {
        delete stream[k];
        dropped.push(`stream.${k}`);
      }
    }
    // Over the plan's bitrate ceiling: drop the value (the stored one stays)
    // rather than save one the encoders would never use.
    const max = hostedMaxBitrate();
    if (max !== undefined) {
      for (const k of ['bitrate', 'aacBitrate', 'opusBitrate'] as const) {
        if (typeof stream[k] === 'number' && stream[k] > max) {
          delete stream[k];
          dropped.push(`stream.${k}`);
        }
      }
      if (stream.flacEnabled === true) {
        delete stream.flacEnabled;
        dropped.push('stream.flacEnabled');
      }
    }
    if (Object.keys(stream).length) out.stream = stream;
    else delete out.stream;
  }
  if (out.embedding && typeof out.embedding === 'object' && !Array.isArray(out.embedding)) {
    const embedding = { ...out.embedding };
    for (const k of HOSTED_EMBEDDING_KEYS) {
      if (k in embedding) {
        delete embedding[k];
        dropped.push(`embedding.${k}`);
      }
    }
    if (Object.keys(embedding).length) out.embedding = embedding;
    else delete out.embedding;
  }
  if (Array.isArray(out.personas)) {
    const allowed = hostedPersonaEngines(defaultEngine);
    out.personas = out.personas.map((p: any, i: number) => {
      const engine = p?.tts?.engine;
      if (typeof engine !== 'string' || allowed.includes(engine)) return p;
      dropped.push(`personas.${p?.id ?? i}.tts.engine`);
      return { ...p, tts: { ...p.tts, engine: 'inherit' } };
    });
  }
  return { patch: out, dropped };
}

// API keys with the LLM and voice provider keys removed.
export function stripManagedSecrets(patch: Record<string, string>): Record<string, string> {
  if (!isHosted()) return patch;
  return Object.fromEntries(Object.entries(patch).filter(([k]) => !HOSTED_SECRET_KEYS.has(k)));
}
