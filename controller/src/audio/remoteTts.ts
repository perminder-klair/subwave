// HTTP client for a user-configured remote TTS engine.
//
// When settings.tts.remote.url is set, the `remote` engine POSTs to that
// endpoint's /speak and receives the rendered audio BYTES back in the HTTP
// response, then writes them to a local file the controller (and Liquidsoap)
// can read. Unlike the tts-heavy sidecar — which shares the /var/sub-wave
// volume and returns a path — `remote` carries the audio in the response
// body, so the endpoint can live on any host reachable over the network
// (LAN, Tailscale, …) with no shared filesystem. This is the TTS equivalent
// of the LLM's custom base URL: a first-class, self-hosted HTTP engine
// without impersonating pocket-tts or chatterbox.
//
// Contract:
//   GET  {url}/health  → 200 JSON { ok: true }
//   POST {url}/speak   → 200, request JSON { text, voice }, response BODY is
//                        the rendered audio (WAV, Content-Type audio/*). The
//                        controller writes the body to its own voice dir.
//                        Optional response headers make a silent voice
//                        substitution visible (issue #238): X-TTS-Fell-Back,
//                        X-TTS-Voice-Used, X-TTS-Fell-Back-Reason.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as settings from '../settings.js';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 180_000;

function getUrl(): string {
  return settings.get().tts?.remote?.url || '';
}

// Cached availability — read synchronously by the dispatcher in tts.ts. The
// periodic loop, the post-load boot probe, and refresh() on a URL change all
// update it through runProbe(), the single writer.
let remoteAvailable = false;

// One /health probe. true iff the endpoint reports ok. No engine-name check —
// the remote endpoint is a generic bridge; it decides what it supports.
// Network/timeout/parse failures collapse to unavailable.
async function probeOnce(): Promise<boolean> {
  const url = getUrl();
  if (!url) return false;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/health`, { signal: ac.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return !!body.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Probe once and update the cached availability, logging only on a change.
// The single writer of remoteAvailable.
async function runProbe(): Promise<void> {
  const url = getUrl();
  const available = url ? await probeOnce() : false;
  if (available === remoteAvailable) return;
  remoteAvailable = available;
  console.log(
    url
      ? `[remote] TTS endpoint ${available ? 'available' : 'unavailable'} (${url})`
      : '[remote] TTS endpoint unavailable (no URL configured)',
  );
}

// Start the periodic /health probe loop (idempotent). Called from server.ts
// AFTER settings.load(): the remote URL lives in settings (not env), so unlike
// the tts-heavy probe this can't self-start at import time — it would only ever
// see the empty default and leave the engine unavailable for the first tick.
// The interval is unref'd so it doesn't keep the event loop alive on its own.
let loopStarted = false;
export function start(): void {
  if (loopStarted) return;
  loopStarted = true;
  runProbe();
  const handle = setInterval(runProbe, PROBE_INTERVAL_MS);
  handle.unref?.();
}

// Force an immediate probe — called when the URL changes via the admin UI so
// availability (and the UI badge) reflects the new endpoint without waiting for
// the next 30s tick.
export async function refresh(): Promise<void> {
  await runProbe();
}

export function isAvailable(): boolean {
  if (!getUrl()) return false;
  return remoteAvailable;
}

export async function speak(
  text: string,
  { outPath: customPath, voice }: { outPath?: string; voice?: string },
): Promise<string> {
  const url = getUrl();
  if (!url) throw new Error('remote TTS URL not configured');
  if (!text || !text.trim()) throw new Error('Empty TTS text');

  const outPath = customPath || path.join(config.piper.outDir, `${crypto.randomBytes(6).toString('hex')}.wav`);
  await mkdir(path.dirname(outPath), { recursive: true });

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${url}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), voice: voice ?? '' }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`remote TTS ${res.status}: ${errBody || res.statusText}`);
  }
  // The audio rides back in the response body — write it where the controller
  // and Liquidsoap can both read it (no shared volume needed). An empty body
  // throws so the dispatcher falls back to Piper instead of handing Liquidsoap
  // a zero-byte file (a silent segment with no error).
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('remote TTS returned an empty response body');
  await writeFile(outPath, audio);

  // Make a silent voice substitution visible (issue #238): the call succeeded
  // and audio plays, but NOT in the requested voice. Surfaced via optional
  // response headers since the body carries audio, not JSON.
  if (res.headers.get('x-tts-fell-back')) {
    console.warn(
      `[remote] requested voice "${voice || ''}" not honoured`
        + ` (${res.headers.get('x-tts-fell-back-reason') || 'fell back'});`
        + ` rendered "${res.headers.get('x-tts-voice-used') || 'default'}"`,
    );
  }
  return outPath;
}
