// Voice-list discovery for the cloud TTS engine.
//
// `GET /v1/audio/voices` is NOT part of the OpenAI spec — it's a convention
// self-hosted TTS servers converged on (Fish, Echo-TTS, Omnivoice, Kokoro-
// FastAPI, openedai-speech, …), and each one invented its own path and payload
// shape. So discovery is best-effort: probe a few known paths, accept every
// response shape seen in the wild, and give up quietly. A station whose server
// answers none of them is exactly where it was before — a free-text voice box.
//
// ElevenLabs is the other discoverable provider: it has a real voice-list API,
// and it's the one that matters most, since an operator's *cloned* voices can
// never appear in a hardcoded list.
//
// OpenAI is deliberately absent — it publishes no voice-list endpoint, and its
// voice set is fixed, so the curated list in web/lib/cloudVoices.ts is correct
// by construction.

import { fetchWithTimeout } from '../../../util/fetch-timeout.js';

export type CloudVoice = { id: string; label: string; hint?: string };

export type VoiceListResult = {
  ok: boolean;
  voices: CloudVoice[];
  error?: string;
};

// Persona voice ids are capped at 100 chars by normalizeTts() in settings.ts.
// Offering a voice we could never persist would be a trap, so drop them here.
const MAX_ID_LEN = 100;
const MAX_VOICES = 500;
const MAX_HINT_LEN = 80;

// Probed in order; first response that yields >=1 voice wins.
const COMPAT_PATHS = ['/audio/voices', '/voices', '/audio/speech/voices'];

// Compat probing walks up to three paths, so each leg gets a short leash and
// the whole probe is capped. A managed provider is one request against a known
// endpoint, so it gets the same 10s budget /settings/llm/models allows —
// establishing the connection can intermittently stall for several seconds,
// and timing out there would drop the operator back to the curated list for
// no good reason.
const PER_ATTEMPT_MS = 3000;
const TOTAL_MS = 8000;
const MANAGED_MS = 10_000;

const ID_KEYS = ['id', 'voice_id', 'voiceId', 'name', 'voice'];
const LABEL_KEYS = ['name', 'label', 'display_name', 'displayName', 'title'];
const HINT_KEYS = ['category', 'gender', 'language', 'description'];

function pickString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// 'af_alloy' -> 'Af Alloy', 'alloy' -> 'Alloy'. An opaque id (an ElevenLabs
// voice_id, a hash) is left alone — title-casing it only makes it noisier.
function labelFor(id: string): string {
  if (/[_-]/.test(id)) {
    return id
      .split(/[_-]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');
  }
  if (/^[a-z]+$/.test(id)) return id[0].toUpperCase() + id.slice(1);
  return id;
}

// Unwrap the common envelopes: {voices: [...]} (Kokoro, openedai-speech),
// {data: [...]} (servers mimicking /v1/models). Depth-limited so a
// self-referential or pathological payload can't spin.
function unwrap(payload: unknown): unknown {
  let cur = payload;
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(cur)) return cur;
    if (!cur || typeof cur !== 'object') return cur;
    const o = cur as Record<string, unknown>;
    const next = o.voices ?? o.data;
    if (next === undefined) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Coerce any of the payload shapes seen in the wild into a clean voice list.
 * Pure — no I/O. Never throws; junk in yields an empty list out.
 *
 * Accepted:
 *   ["alloy", "nova"]                        bare array of ids
 *   {"voices": ["af_alloy", ...]}            Kokoro-FastAPI, openedai-speech
 *   {"data": [{"id": "x"}, ...]}             /v1/models mimics
 *   [{"voice_id": "x", "name": "Rachel"}]    ElevenLabs
 */
export function normalizeVoiceList(payload: unknown): CloudVoice[] {
  const list = unwrap(payload);
  if (!Array.isArray(list)) return [];

  const out: CloudVoice[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    let id = '';
    let label = '';
    let hint = '';

    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      id = pickString(o, ID_KEYS);
      label = pickString(o, LABEL_KEYS);
      hint = pickString(o, HINT_KEYS);
    }

    if (!id || id.length > MAX_ID_LEN) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const voice: CloudVoice = { id, label: label || labelFor(id) };
    if (hint) voice.hint = hint.slice(0, MAX_HINT_LEN);
    out.push(voice);

    if (out.length >= MAX_VOICES) break;
  }

  return out;
}

function briefError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'Timed out';
    return err.message;
  }
  return 'Discovery failed';
}

// `bodyDeadline` keeps the deadline armed over the JSON read, not just the
// headers — a server that dribbles a response would otherwise fall through to
// undici's ~300s default and hang the probe.
async function fetchVoices(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CloudVoice[]> {
  const r = await fetchWithTimeout(url, { headers, timeoutMs, bodyDeadline: true, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return normalizeVoiceList(await r.json());
}

/**
 * Discover the voices a cloud TTS provider offers.
 *
 * Never throws — always resolves to {ok, voices, error?}, matching the
 * contract of GET /settings/llm/models so the UI has one code path.
 */
export async function listVoices(opts: {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<VoiceListResult> {
  const { provider, signal } = opts;
  const apiKey = (opts.apiKey || '').trim();

  if (provider === 'elevenlabs') {
    if (!apiKey) return { ok: false, voices: [], error: 'ElevenLabs API key not set' };
    try {
      const voices = await fetchVoices(
        'https://api.elevenlabs.io/v1/voices',
        { 'xi-api-key': apiKey },
        MANAGED_MS,
        signal,
      );
      return { ok: true, voices };
    } catch (err) {
      return { ok: false, voices: [], error: briefError(err) };
    }
  }

  if (provider !== 'openai-compatible') {
    // openai has no list endpoint; anything else isn't a cloud TTS provider.
    return { ok: false, voices: [], error: `${provider || 'provider'} does not support voice discovery` };
  }

  const baseUrl = (opts.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, voices: [], error: 'baseUrl is required for openai-compatible' };
  // settings.update() already enforces this on the write path (settings.ts),
  // but load() coerces leniently, so a hand-edited settings.json could still
  // point us at a non-HTTP scheme. Cheap belt-and-braces before we fetch it.
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, voices: [], error: 'baseUrl must start with http:// or https://' };
  }

  // Most local servers accept any key, and many need none — send one only if
  // the operator configured it (mirrors the /v1/models probe in routes/settings).
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const deadline = Date.now() + TOTAL_MS;
  let lastError = 'No voice endpoint found';

  for (const path of COMPAT_PATHS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastError = 'Timed out';
      break;
    }
    try {
      const voices = await fetchVoices(
        `${baseUrl}${path}`,
        headers,
        Math.min(PER_ATTEMPT_MS, remaining),
        signal,
      );
      // A 200 that parses to nothing means "wrong endpoint, right server" as
      // often as "no voices" — keep probing, but remember it wasn't an error.
      if (voices.length) return { ok: true, voices };
      lastError = 'Server returned no voices';
    } catch (err) {
      lastError = briefError(err);
      // A caller-side abort is terminal — don't burn the remaining paths on it.
      if (signal?.aborted) break;
    }
  }

  return { ok: false, voices: [], error: lastError };
}
