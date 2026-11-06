// Hosted mode (SUBWAVE_HOSTED=1): a station run by SUB/WAVE Cloud, whose box
// agent owns the LLM route (the DJ Brain) and the voice engine. The agent
// writes those into settings.json itself; this module is the station's side of
// that contract, so the wizard, the settings API, backup restore and persona
// imports can't overwrite them.
//
// Managed: the LLM route under `llm` (provider, model, endpoint, keys,
// fallback; HOSTED_LLM_KEYS), not the DJ tuning that also lives there (track
// selection, no-repeat and variety windows, request matching, segment
// runtime...); the voice engine choice plus each engine's
// provider config; and the embedding route (provider, model, endpoint, key),
// which also goes through the brain. A persona or jingle voice slot may only
// pin an engine the box runs (or the brain's cloud voice on a premium
// station); any other pin becomes `inherit`. Still the operator's: whether the
// DJ speaks, the Kokoro voice and language, gain/speed, voice levelling,
// pronunciation corrections, personas (bar that engine rule), the tagger's
// tuning (on/off, seed count, propagation, enrichment), and every non-voice
// setting. API keys for LLM, voice and embedding providers are dropped too
// (the brain token is the only one in use); other keys (web search,
// scrobbling) still save.
//
// The env is read through util/env.ts with the parsers in schemas/hosted.ts,
// the same ones the web admin reads it with (web/lib/hosted.ts), on every
// call: a malformed value warns once and reads as unset.

import { LLM_KEY_ENV_VARS } from '../schemas/providers.js';
import { hostedFlagSchema, hostedMaxBitrateSchema, hostedPersonaEngines } from '../schemas/hosted.js';
import { LLM_LEG_FIELDS } from '../settings/llm-swap.js';
import { AAC_BITRATES, MP3_BITRATES, OPUS_BITRATES } from '../settings/vocab.js';
import { envParsed } from '../util/env.js';

export { hostedPersonaEngines };

export function isHosted(): boolean {
  return envParsed('SUBWAVE_HOSTED', hostedFlagSchema, false);
}

// The plan's stream bitrate ceiling in kbps (SUBWAVE_MAX_BITRATE, set by the
// box agent from the station's SUB/WAVE Cloud plan). Undefined when not
// hosted, not set, or malformed (which warns): no ceiling.
export function hostedMaxBitrate(): number | undefined {
  if (!isHosted()) return undefined;
  return envParsed<number | undefined>('SUBWAVE_MAX_BITRATE', hostedMaxBitrateSchema, undefined, {
    fallbackLabel: 'no bitrate ceiling',
  });
}

// Per-leg fields (LLM_LEG_FIELDS) the operator still owns on a hosted
// station: the agent's discovery rounds per pick, which the Music selection
// page saves alongside trackSelection. Every other leg field is part of the
// route, so a leg field added later is managed unless it is listed here.
export const HOSTED_OPERATOR_LEG_FIELDS = ['discoverySteps'] as const;

// llm.* keys that pick where the DJ's LLM runs: every per-leg connection field
// but the operator's, plus the flat/inline keys and the whole fallback leg.
// The rest of the block is the operator's tuning, which the Music selection
// and DJ behaviour pages save.
export const HOSTED_LLM_KEYS: readonly string[] = [
  ...LLM_LEG_FIELDS.filter(k => !(HOSTED_OPERATOR_LEG_FIELDS as readonly string[]).includes(k)),
  'baseUrl', 'apiKey', 'keys', 'fallback',
];

// stream.* keys the agent owns: the listener ceiling is the plan's (the agent
// sets ICECAST_MAX_CLIENTS on the broadcast container, which wins over this
// setting anyway), so saving another number would only mislead the owner.
export const HOSTED_STREAM_KEYS = ['maxListeners'] as const;

// tts.* keys the agent owns on a hosted station.
export const HOSTED_TTS_KEYS = ['defaultEngine', 'cloud', 'remote', 'gemini', 'chatterbox', 'pocketTts', 'heavyEnabled', 'fallback'] as const;

// embedding.* keys that pick where embeddings come from. The rest of the block
// (enabled, seedCount, propagation, enrichment) is the operator's tuning.
export const HOSTED_EMBEDDING_KEYS = ['provider', 'model', 'providerBaseUrls', 'baseUrl', 'ollamaUrl', 'apiKey', 'headers'] as const;

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
// if none fits — MP3 always fits, since a ceiling is never under its lowest,
// 64), and FLAC is off, since a lossless mount runs near 1 Mbps a listener.
// Applied where the settings reach Liquidsoap (settings/liquidsoap.ts, on save
// and at boot), so a value saved before the plan changed can't exceed it
// either. No ceiling → returned untouched.
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

export interface AdvertisedMounts { opusEnabled: boolean; flacEnabled: boolean; aacEnabled: boolean }

// Which optional mounts the mixer runs, for every surface that lists them
// (/now-playing, the tune-in files, the admin Connect page, /debug, the
// Doctor): the saved flags through the same ceiling the mixer files get, so a
// mount the ceiling switched off is never offered. No ceiling: the saved flags.
export function advertisedMounts(stream: unknown): AdvertisedMounts {
  const m: Partial<StreamBitrates> = stream && typeof stream === 'object'
    ? capStreamBitrates(stream as StreamBitrates)
    : {};
  return { opusEnabled: m.opusEnabled === true, flacEnabled: m.flacEnabled === true, aacEnabled: m.aacEnabled === true };
}

// LLM, voice and embedding provider keys; LLM ones come from the provider table.
const HOSTED_SECRET_KEYS = new Set<string>([...LLM_KEY_ENV_VARS, 'ELEVENLABS_API_KEY', 'FISH_API_KEY', 'EMBEDDING_API_KEY']);

// One voice slot ({ engine, voice, ... }) under the hosted engine rule: an
// engine the box doesn't run becomes `inherit`, everything else in the slot
// stays. The one copy of the rule, for personas and jingles alike.
export function hostedVoiceSlot<S>(slot: S, defaultEngine: unknown): { slot: S; changed: boolean } {
  const engine = (slot as { engine?: unknown } | null | undefined)?.engine;
  if (!isHosted() || typeof engine !== 'string' || hostedPersonaEngines(defaultEngine).includes(engine)) {
    return { slot, changed: false };
  }
  return { slot: { ...slot, engine: 'inherit' }, changed: true };
}

// A copy of `block` without `keys`, the dropped ones recorded as `prefix.key`.
// The block itself goes when nothing is left in it.
function stripBlock(out: Record<string, any>, block: string, keys: readonly string[], dropped: string[]): void {
  const value = out[block];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const kept = { ...value };
  for (const k of keys) {
    if (k in kept) {
      delete kept[k];
      dropped.push(`${block}.${k}`);
    }
  }
  if (Object.keys(kept).length) out[block] = kept;
  else delete out[block];
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
  if ('llm' in out && (!out.llm || typeof out.llm !== 'object' || Array.isArray(out.llm))) {
    delete out.llm;
    dropped.push('llm');
  }
  stripBlock(out, 'llm', HOSTED_LLM_KEYS, dropped);
  stripBlock(out, 'tts', HOSTED_TTS_KEYS, dropped);
  // Over the plan's bitrate ceiling: drop the value (the stored one stays)
  // rather than save one the encoders would never use.
  const max = hostedMaxBitrate();
  const overCeiling = max === undefined || !out.stream || typeof out.stream !== 'object'
    ? []
    : [
      ...(['bitrate', 'aacBitrate', 'opusBitrate'] as const).filter(k => typeof out.stream[k] === 'number' && out.stream[k] > max),
      ...(out.stream.flacEnabled === true ? ['flacEnabled'] : []),
    ];
  stripBlock(out, 'stream', [...HOSTED_STREAM_KEYS, ...overCeiling], dropped);
  stripBlock(out, 'embedding', HOSTED_EMBEDDING_KEYS, dropped);
  if (Array.isArray(out.personas)) {
    out.personas = out.personas.map((p: any, i: number) => {
      const { slot, changed } = hostedVoiceSlot(p?.tts, defaultEngine);
      if (!changed) return p;
      dropped.push(`personas.${p?.id ?? i}.tts.engine`);
      return { ...p, tts: slot };
    });
  }
  return { patch: out, dropped };
}

// API keys with the LLM, voice and embedding provider keys removed, and the
// names of the ones it dropped. Never mutates the input.
export function stripManagedSecrets(patch: Record<string, string>): { patch: Record<string, string>; dropped: string[] } {
  if (!isHosted()) return { patch, dropped: [] };
  const dropped = Object.keys(patch).filter(k => HOSTED_SECRET_KEYS.has(k));
  return { patch: Object.fromEntries(Object.entries(patch).filter(([k]) => !HOSTED_SECRET_KEYS.has(k))), dropped };
}
