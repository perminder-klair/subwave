// HTTP client for the optional subwave-tts-heavy sidecar (docker/tts-heavy/
// server.py). With config.ttsHeavy.url set, chatterbox.ts and pocketTts.ts route
// speak() here instead of spawning a local venv; the sidecar writes the WAV to
// the shared /var/sub-wave volume and returns its absolute path. The two modes
// are mutually exclusive per engine (TTS_HEAVY_URL set → sidecar wins), and this
// module is a no-op when the url isn't configured.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { cachedHealthProbe } from '../util/health-probe.js';

const PROBE_TIMEOUT_MS = 5_000;
// /warm only ARMS a load and returns. Short ceiling on purpose: the render path
// reloads on its own if this call never lands.
const WARM_TIMEOUT_MS = 5_000;

export type RemoteEngine = 'chatterbox' | 'pocket-tts';

export function isRemoteEnabled(): boolean {
  return !!config.ttsHeavy.url;
}

// Extra capability flags the probe surfaces beyond bare availability. Today just
// PocketTTS' cloning capability (#238); null when unknown.
export type ProbeMeta = { voiceCloning: boolean | null };

// Sidecar-wide health snapshot, refreshed on every /health probe (independent of
// the per-engine onChange). Lets the admin UI tell "sidecar down" from "sidecar
// up, engine disabled via TTS_HEAVY_ENGINES". `enabled` is the sidecar's engine
// list; `cold` is the engines its idle unload has parked (#1579), still routable
// but paying a model load on the next line. Both null when unknown (sidecar
// down, or an older image that doesn't report the field).
let cachedHealth: { up: boolean; enabled: string[] | null; cold: string[] | null } = {
  up: false,
  enabled: null,
  cold: null,
};

// The sidecar's configured engines (TTS_HEAVY_ENGINES); null in every unknown
// case so the UI degrades to "sidecar off" rather than guessing.
export function heavyEnabledEngines(): string[] | null {
  if (!config.ttsHeavy.url) return null;
  return cachedHealth.up ? cachedHealth.enabled : null;
}

// Engines the sidecar has idle-unloaded (#1579); null means unknown. Diagnostic
// only: a cold engine is still available, so nothing routes on this.
export function heavyColdEngines(): string[] | null {
  if (!config.ttsHeavy.url) return null;
  return cachedHealth.up ? cachedHealth.cold : null;
}

// One /health probe. `available` is true iff the sidecar reports ok and lists
// the requested engine. Network/timeout/parse failures collapse to unavailable,
// so an unreachable sidecar looks identical to a missing venv.
async function probeOnce(engine: RemoteEngine): Promise<{ available: boolean; meta: ProbeMeta }> {
  const url = config.ttsHeavy.url;
  const miss = { available: false, meta: { voiceCloning: null } as ProbeMeta };
  if (!url) return miss;
  try {
    const res = await fetchWithTimeout(`${url}/health`, { timeoutMs: PROBE_TIMEOUT_MS, bodyDeadline: true });
    if (!res.ok) {
      cachedHealth = { up: false, enabled: null, cold: null };
      return miss;
    }
    const body = (await res.json()) as {
      ok?: boolean;
      engines?: string[];
      enabled?: string[];
      cold?: string[];
      pocket_voice_cloning?: boolean | null;
    };
    // Refresh the sidecar-wide snapshot on every probe (see cachedHealth).
    cachedHealth = {
      up: !!body.ok,
      enabled: Array.isArray(body.enabled) ? body.enabled : null,
      cold: Array.isArray(body.cold) ? body.cold : null,
    };
    // Do NOT subtract `cold` here: a cold engine is one on-demand load from
    // speaking, and treating it as unavailable would stop the dispatcher ever
    // calling /speak on it, which is the only thing that wakes it (#1579).
    const available =
      !!body.ok && Array.isArray(body.engines) && body.engines.includes(engine);
    const voiceCloning =
      engine === 'pocket-tts' && typeof body.pocket_voice_cloning === 'boolean'
        ? body.pocket_voice_cloning
        : null;
    return { available, meta: { voiceCloning } };
  } catch {
    cachedHealth = { up: false, enabled: null, cold: null };
    return miss;
  }
}

// Ask the sidecar to start reloading anything its idle unload parked, without
// waiting for the load (#1579). broadcast/stream-idle.ts calls it when the
// programme's idle pause releases, so the model comes back while the music does
// rather than on the first spoken line. Resolves on every failure path: a warm
// that never lands just means the next render pays the load itself.
export async function warmHeavy(): Promise<void> {
  const url = config.ttsHeavy.url;
  if (!url) return;
  try {
    const res = await fetchWithTimeout(`${url}/warm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No engine named: warm everything enabled. The caller is a station-wide
      // event and can't know which persona speaks first.
      body: JSON.stringify({ engine: '' }),
      timeoutMs: WARM_TIMEOUT_MS,
      // The deadline covers the body read too. Nobody awaits this call, so a
      // body that never drains would sit on undici's ~300s default holding a
      // socket and a dangling promise.
      bodyDeadline: true,
    });
    if (!res.ok) return;
    const body = (await res.json()) as { warming?: string[] };
    // Only worth a line when it actually started something.
    if (Array.isArray(body.warming) && body.warming.length > 0) {
      console.log(`[tts-heavy] warming idle-unloaded engine(s): ${body.warming.join(', ')}`);
    }
  } catch {
    /* a failed warm costs the next render a model load, nothing more */
  }
}

// Periodic probe loop. Reports via onChange so callers can update the cached
// boolean isAvailable() reads synchronously. onChange fires whenever
// availability OR a capability flag changes, so a sidecar that finishes loading
// the cloning weights after boot is reflected without a restart. The interval is
// unref'd so it doesn't hold the event loop open on its own.
export function startProbeLoop(
  engine: RemoteEngine,
  onChange: (avail: boolean, meta: ProbeMeta) => void,
): void {
  if (!config.ttsHeavy.url) return;
  cachedHealthProbe<{ available: boolean; meta: ProbeMeta }>({
    probe: () => probeOnce(engine),
    intervalMs: config.ttsHeavy.probeIntervalMs,
    initial: { available: false, meta: { voiceCloning: null } },
    equals: (a, b) => a.available === b.available && a.meta.voiceCloning === b.meta.voiceCloning,
    onChange: (next, prev) => {
      if (next.available !== prev.available) {
        console.log(
          `[${engine}] tts-heavy sidecar ${next.available ? 'available' : 'unavailable'} (${config.ttsHeavy.url})`,
        );
      }
      if (engine === 'pocket-tts' && next.available && next.meta.voiceCloning === false) {
        console.warn(
          '[pocket-tts] sidecar reports voice cloning UNAVAILABLE — cloned .wav '
            + 'voices will fall back to a built-in. Set HF_TOKEN to enable cloning.',
        );
      }
      onChange(next.available, next.meta);
    },
  }).start();
}

export type RemoteSpeakRequest = {
  engine: RemoteEngine;
  text: string;
  out: string;
  voice?: string;
  referenceWav?: string;
};

export async function speakRemote(req: RemoteSpeakRequest): Promise<string> {
  const url = config.ttsHeavy.url;
  if (!url) throw new Error('tts-heavy URL not configured');
  await mkdir(path.dirname(req.out), { recursive: true });

  const res = await fetchWithTimeout(`${url}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      engine: req.engine,
      text: req.text.trim(),
      voice: req.voice ?? '',
      reference_wav: req.referenceWav ?? '',
      out: req.out,
    }),
    timeoutMs: config.ttsHeavy.requestTimeoutMs,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`tts-heavy ${res.status}: ${errBody || res.statusText}`);
  }
  const body = (await res.json()) as {
    ok: boolean;
    path: string;
    error?: string;
    voice_used?: string;
    fell_back?: boolean;
    fell_back_reason?: string;
  };
  if (!body.ok) throw new Error(body.error || 'tts-heavy returned ok:false');
  // Make a silent voice substitution visible (#238): the call succeeded and
  // audio plays, but not in the requested voice.
  if (body.fell_back) {
    console.warn(
      `[${req.engine}] requested voice "${req.referenceWav || req.voice || ''}" not honoured`
        + ` (${body.fell_back_reason || 'fell back'}); rendered "${body.voice_used ?? 'default'}"`,
    );
  }
  return body.path;
}
