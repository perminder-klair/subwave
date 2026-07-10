// HTTP client for the optional subwave-tts-heavy sidecar.
//
// When config.ttsHeavy.url is set, audio/chatterbox.ts and audio/pocketTts.ts
// route speak() through this module instead of spawning a local Python venv.
// The sidecar writes the WAV to the shared /var/sub-wave volume and returns
// the absolute path, which the controller then hands to Liquidsoap via
// next.txt / say.txt / intro.txt — same semantics as the local-spawn path,
// just with an HTTP hop in the middle.
//
// See docker/Dockerfile.tts-heavy + docker/tts-heavy/server.py for the
// server side. The two operating modes (sidecar vs local venv) are
// mutually exclusive per engine: TTS_HEAVY_URL set → sidecar wins; unset →
// fall back to the existing --build-arg WITH_CHATTERBOX=1 / WITH_POCKETTTS=1
// venv path. This module is a no-op when the url isn't configured.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const PROBE_TIMEOUT_MS = 5_000;

export type RemoteEngine = 'chatterbox' | 'pocket-tts';

export function isRemoteEnabled(): boolean {
  return !!config.ttsHeavy.url;
}

// Extra capability flags the probe surfaces beyond bare availability. Today
// just PocketTTS' voice-cloning capability (issue #238): null when unknown
// (sidecar down / engine still booting / engine doesn't report it), true/false
// once the worker has declared whether the gated cloning weights loaded.
export type ProbeMeta = { voiceCloning: boolean | null };

// Sidecar-wide health snapshot, refreshed on every /health probe (independent
// of the per-engine onChange, which only fires on availability/capability
// changes). Lets the admin UI tell "sidecar down" apart from "sidecar up but
// this engine disabled via TTS_HEAVY_ENGINES". `enabled` is the sidecar's
// configured engine list; null when the sidecar is unreachable OR is an older
// image that doesn't report the field (so callers fall back to old behaviour).
let cachedHealth: { up: boolean; enabled: string[] | null } = { up: false, enabled: null };

// The tts-heavy sidecar's configured engines (TTS_HEAVY_ENGINES). Returns null
// when not in sidecar mode, the sidecar is unreachable, or it's too old to
// report the list — in every "unknown" case, so the UI degrades to the plain
// "sidecar off" label rather than guessing.
export function heavyEnabledEngines(): string[] | null {
  if (!config.ttsHeavy.url) return null;
  return cachedHealth.up ? cachedHealth.enabled : null;
}

// One /health probe. `available` is true iff the sidecar reports ok and lists
// the requested engine. Network/timeout/parse failures collapse to
// unavailable — the dispatcher reads the result the same way it reads an
// existsSync() in the local path, and an unavailable sidecar should look
// identical to a missing venv (i.e. let the engine fall back to Piper).
async function probeOnce(engine: RemoteEngine): Promise<{ available: boolean; meta: ProbeMeta }> {
  const url = config.ttsHeavy.url;
  const miss = { available: false, meta: { voiceCloning: null } as ProbeMeta };
  if (!url) return miss;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/health`, { signal: ac.signal });
    if (!res.ok) {
      cachedHealth = { up: false, enabled: null };
      return miss;
    }
    const body = (await res.json()) as {
      ok?: boolean;
      engines?: string[];
      enabled?: string[];
      pocket_voice_cloning?: boolean | null;
    };
    // Refresh the sidecar-wide snapshot on every probe (see cachedHealth).
    cachedHealth = {
      up: !!body.ok,
      enabled: Array.isArray(body.enabled) ? body.enabled : null,
    };
    const available =
      !!body.ok && Array.isArray(body.engines) && body.engines.includes(engine);
    const voiceCloning =
      engine === 'pocket-tts' && typeof body.pocket_voice_cloning === 'boolean'
        ? body.pocket_voice_cloning
        : null;
    return { available, meta: { voiceCloning } };
  } catch {
    cachedHealth = { up: false, enabled: null };
    return miss;
  } finally {
    clearTimeout(t);
  }
}

// Kick off a periodic probe loop. Reports availability via onChange so callers
// can update their cached boolean (which isAvailable() reads synchronously —
// the dispatcher in tts.ts is sync). onChange fires whenever availability OR a
// capability flag changes, so a sidecar that finishes loading the cloning
// weights after boot is reflected without a restart. The interval is unref'd
// so it doesn't keep the event loop alive on its own; the Express server in
// server.ts is what holds the loop open.
export function startProbeLoop(
  engine: RemoteEngine,
  onChange: (avail: boolean, meta: ProbeMeta) => void,
): void {
  if (!config.ttsHeavy.url) return;
  let lastAvail = false;
  let lastCloning: boolean | null = null;
  const tick = async () => {
    const { available, meta } = await probeOnce(engine);
    if (available !== lastAvail) {
      console.log(
        `[${engine}] tts-heavy sidecar ${available ? 'available' : 'unavailable'} (${config.ttsHeavy.url})`,
      );
    }
    if (available !== lastAvail || meta.voiceCloning !== lastCloning) {
      if (engine === 'pocket-tts' && available && meta.voiceCloning === false) {
        console.warn(
          '[pocket-tts] sidecar reports voice cloning UNAVAILABLE — cloned .wav '
            + 'voices will fall back to a built-in. Set HF_TOKEN to enable cloning.',
        );
      }
      lastAvail = available;
      lastCloning = meta.voiceCloning;
      onChange(available, meta);
    }
  };
  tick();
  const handle = setInterval(tick, config.ttsHeavy.probeIntervalMs);
  handle.unref?.();
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

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), config.ttsHeavy.requestTimeoutMs);
  let res: Response;
  try {
    res = await fetch(`${url}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: req.engine,
        text: req.text.trim(),
        voice: req.voice ?? '',
        reference_wav: req.referenceWav ?? '',
        out: req.out,
      }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
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
  // Make a silent voice substitution visible (issue #238): the call succeeded
  // and audio plays, but NOT in the requested voice. Without this the operator
  // sees a healthy stream and assumes their selection took effect.
  if (body.fell_back) {
    console.warn(
      `[${req.engine}] requested voice "${req.referenceWav || req.voice || ''}" not honoured`
        + ` (${body.fell_back_reason || 'fell back'}); rendered "${body.voice_used ?? 'default'}"`,
    );
  }
  return body.path;
}
