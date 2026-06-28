// HTTP client for a user-configured remote TTS engine.
//
// When settings.tts.remote.url is set, the `remote` engine speaks the
// Subwave-native /speak + /health contract against that endpoint — the same
// protocol the built-in tts-heavy sidecar uses (docker/tts-heavy/server.py).
// This is the TTS equivalent of the LLM's custom base URL: a first-class,
// self-hosted HTTP engine without impersonating pocket-tts or chatterbox.
//
// See controller/src/audio/ttsHeavyClient.ts for the canonical /speak +
// /health contract. The sidecar writes the WAV to the shared /var/sub-wave
// volume and returns the absolute path, which the controller hands to
// Liquidsoap via next.txt / say.txt / intro.txt — same semantics as every
// other engine.

import { mkdir } from 'node:fs/promises';
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

// Cached availability — read synchronously by the dispatcher in tts.ts.
let remoteAvailable = false;

// One /health probe. `available` is true iff the sidecar reports ok.
// No engine-name check — the remote endpoint is a generic bridge; the
// sidecar decides what it supports. Network/timeout/parse failures
// collapse to unavailable.
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

// Periodic probe loop. Runs every PROBE_INTERVAL_MS. Handles the case where
// the URL is set AFTER the controller starts (e.g. via the admin UI). When
// URL is empty the probe is a fast no-op; when it becomes present the next
// tick picks it up. The interval is unref'd so it doesn't keep the event
// loop alive on its own.
let lastAvail = false;
let loopStarted = false;
function ensureProbeLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  const tick = async () => {
    const url = getUrl();
    if (!url) {
      if (remoteAvailable) {
        remoteAvailable = false;
        lastAvail = false;
        console.log('[remote] TTS endpoint unavailable (no URL configured)');
      }
      return;
    }
    const available = await probeOnce();
    if (available !== lastAvail) {
      console.log(
        `[remote] TTS endpoint ${available ? 'available' : 'unavailable'} (${url})`,
      );
      lastAvail = available;
      remoteAvailable = available;
    }
  };
  tick();
  const handle = setInterval(tick, PROBE_INTERVAL_MS);
  handle.unref?.();
}

export function isAvailable(): boolean {
  const url = getUrl();
  if (!url) return false;
  return remoteAvailable;
}

// Read by the settings route to tell the UI whether remote has a URL.
export function isConfigured(): boolean {
  return !!getUrl();
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
      body: JSON.stringify({
        engine: 'remote',
        text: text.trim(),
        voice: voice ?? '',
        reference_wav: '',
        out: outPath,
      }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`remote TTS ${res.status}: ${errBody || res.statusText}`);
  }
  const body = (await res.json()) as {
    ok: boolean;
    path: string;
    error?: string;
    voice_used?: string;
    fell_back?: boolean;
    fell_back_reason?: string;
  };
  if (!body.ok) throw new Error(body.error || 'remote TTS returned ok:false');
  // Make a silent voice substitution visible (issue #238): the call succeeded
  // and audio plays, but NOT in the requested voice.
  if (body.fell_back) {
    console.warn(
      `[remote] requested voice "${voice || ''}" not honoured`
        + ` (${body.fell_back_reason || 'fell back'}); rendered "${body.voice_used ?? 'default'}"`,
    );
  }
  return body.path;
}

// Kick off the probe loop at import time so availability is known before
// the first segment fires. The loop handles a URL that is set later through
// settings without a restart.
ensureProbeLoop();
