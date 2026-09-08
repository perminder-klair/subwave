// HTTP client for a user-configured remote TTS engine (settings.tts.remote.url).
// Unlike the tts-heavy sidecar, which shares the /var/sub-wave volume and
// returns a path, `remote` carries the audio BYTES in the response body, so the
// endpoint can live on any reachable host with no shared filesystem. The
// controller writes those bytes to a local file for Liquidsoap.
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
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { cachedHealthProbe } from '../util/health-probe.js';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 180_000;

function getUrl(): string {
  return settings.get().tts?.remote?.url || '';
}

// One /health probe: true iff the endpoint reports ok. No engine-name check —
// the endpoint is a generic bridge and decides what it supports.
// Network/timeout/parse failures collapse to unavailable.
async function probeOnce(): Promise<boolean> {
  const url = getUrl();
  if (!url) return false;
  try {
    const res = await fetchWithTimeout(`${url}/health`, { timeoutMs: PROBE_TIMEOUT_MS, bodyDeadline: true });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return !!body.ok;
  } catch {
    return false;
  }
}

// Cached availability, read synchronously by the dispatcher. The shared probe
// runs probeOnce() on an interval (and on demand via refresh()) and logs only on
// a change.
const probe = cachedHealthProbe<boolean>({
  probe: probeOnce,
  intervalMs: PROBE_INTERVAL_MS,
  initial: false,
  onChange: (available) => {
    const url = getUrl();
    console.log(
      url
        ? `[remote] TTS endpoint ${available ? 'available' : 'unavailable'} (${url})`
        : '[remote] TTS endpoint unavailable (no URL configured)',
    );
  },
});

// Start the periodic /health probe loop (idempotent). Must be called AFTER
// settings.load(): the remote URL lives in settings, not env, so starting at
// import time would only ever see the empty default. The interval is unref'd.
export function start(): void {
  probe.start();
}

// Force an immediate probe, so a URL change in the admin UI reflects without
// waiting for the next 30s tick.
export async function refresh(): Promise<void> {
  await probe.refresh();
}

export function isAvailable(): boolean {
  if (!getUrl()) return false;
  return probe.get();
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

  const res = await fetchWithTimeout(`${url}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.trim(), voice: voice ?? '' }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
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
