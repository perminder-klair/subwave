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

// One /health probe. Returns true iff the sidecar reports ok and lists the
// requested engine. Network/timeout/parse failures collapse to false — the
// dispatcher reads the result the same way it reads an existsSync() in the
// local path, and an unavailable sidecar should look identical to a missing
// venv (i.e. let the engine fall back to Piper).
async function probeOnce(engine: RemoteEngine): Promise<boolean> {
  const url = config.ttsHeavy.url;
  if (!url) return false;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/health`, { signal: ac.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; engines?: string[] };
    return !!body.ok && Array.isArray(body.engines) && body.engines.includes(engine);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Kick off a periodic probe loop. Reports availability state changes via
// onChange so callers can update their cached boolean (which isAvailable()
// reads synchronously — the dispatcher in tts.ts is sync). The interval is
// unref'd so it doesn't keep the event loop alive on its own; the Express
// server in server.ts is what holds the loop open.
export function startProbeLoop(
  engine: RemoteEngine,
  onChange: (avail: boolean) => void,
): void {
  if (!config.ttsHeavy.url) return;
  let last = false;
  const tick = async () => {
    const next = await probeOnce(engine);
    if (next !== last) {
      console.log(
        `[${engine}] tts-heavy sidecar ${next ? 'available' : 'unavailable'} (${config.ttsHeavy.url})`,
      );
      last = next;
      onChange(next);
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
  const body = (await res.json()) as { ok: boolean; path: string; error?: string };
  if (!body.ok) throw new Error(body.error || 'tts-heavy returned ok:false');
  return body.path;
}
