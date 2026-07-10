// PocketTTS client — two modes:
//
// 1. Sidecar mode (when config.ttsHeavy.url is set). speak() POSTs to the
//    subwave-tts-heavy container (docker/Dockerfile.tts-heavy +
//    docker/tts-heavy/server.py). isAvailable() reads the cached result of
//    a periodic /health probe. This is the default deployment story for
//    operators on the pre-built ghcr.io images (issue #103).
//
// 2. Local-spawn mode (the original). pocket_tts_worker.py loads the
//    kyutai-labs PocketTTS model once and stays resident, reading one JSON
//    request per line over stdin and emitting one JSON response per line
//    on stdout. This is the legacy --build-arg WITH_POCKETTTS=1 path in
//    docker/Dockerfile.controller; kept working for backwards compat.
//
// Voice selection: a built-in voice id (alba, anna, charles, …) plays the
// curated voice; a `.wav` filename triggers zero-shot cloning against the
// shared voice folder (config.voices.dir, with a fallback read of legacy
// chatterbox-voices/). Issue #213 wired up cloning — earlier versions exposed
// the built-in ids only.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  isRemoteEnabled,
  speakRemote,
  startProbeLoop,
} from './ttsHeavyClient.js';

// PocketTTS' 100M-param model is smaller than Chatterbox Turbo but the first
// call still needs to import torch and warm the Hugging Face cache.
const READY_TIMEOUT_MS = 60_000;
// ~6x real-time on a modern CPU per the upstream README (~200ms TTFB), so a
// typical DJ line should finish in well under 10s. 120s ceiling is the
// pessimistic "first-call-after-cold-boot, slow disk" budget.
const REQUEST_TIMEOUT_MS = parseInt(process.env.POCKET_TTS_REQUEST_TIMEOUT_MS || '120000', 10);

type PendingRequest = {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: PocketTtsWorker | null = null;
let bootingPromise: Promise<PocketTtsWorker> | null = null;
// Whether the local-spawn worker can do voice cloning (gated kyutai/pocket-tts
// weights present). null until the worker has booted and reported it via its
// ready message; cloningAvailable() returns it for the local path. The sidecar
// path uses `remoteCloning` instead (set by the /health probe loop). See #238.
let localCloning: boolean | null = null;

class PocketTtsWorker {
  proc: ChildProcessWithoutNullStreams | null = null;
  ready = false;
  readyResolve: (() => void) | null = null;
  readyReject: ((err: Error) => void) | null = null;
  readyPromise: Promise<void>;
  readyTimer: NodeJS.Timeout | null = null;
  requests = new Map<string, PendingRequest>();
  buffer = '';
  fatalError: Error | null = null;

  constructor() {
    this.readyPromise = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
  }

  start() {
    this.proc = spawn(config.pocketTts.python, [config.pocketTts.workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        POCKET_TTS_VOICE: config.pocketTts.defaultVoice,
      },
    });

    this.readyTimer = setTimeout(() => {
      this.failReady(new Error('pocket-tts worker ready timeout'));
    }, READY_TIMEOUT_MS);

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) console.error(`[pocket-tts] ${text}`);
    });
    this.proc.on('exit', (code, signal) => this.onExit(code, signal));
  }

  onStdout(chunk: Buffer) {
    this.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); }
      catch { console.error('[pocket-tts] bad json from worker:', line); continue; }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg: any) {
    if (msg.ready) {
      this.ready = true;
      if (typeof msg.voice_cloning === 'boolean') {
        localCloning = msg.voice_cloning;
        if (!localCloning) {
          console.warn(
            '[pocket-tts] voice cloning UNAVAILABLE — cloned .wav voices will fall '
              + 'back to a built-in. Set HF_TOKEN to enable cloning.',
          );
        }
      }
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyResolve?.();
      return;
    }
    if (msg.fatal) {
      this.fatalError = new Error(msg.error || 'pocket-tts worker fatal');
      this.failReady(this.fatalError);
      return;
    }
    const pending = this.requests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.requests.delete(msg.id);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.error || 'pocket-tts request failed'));
  }

  failReady(err: Error) {
    if (this.ready) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyReject?.(err);
  }

  onExit(code: number | null, signal: NodeJS.Signals | null) {
    console.error(`[pocket-tts] worker exited code=${code} signal=${signal}`);
    const err = this.fatalError || new Error(`pocket-tts worker exited (${code ?? signal})`);
    for (const { reject, timer } of this.requests.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.requests.clear();
    this.failReady(err);
    if (worker === this) worker = null;
  }

  send(id: string, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`pocket-tts request ${id} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(id, { resolve, reject, timer });
      this.proc?.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }
}

async function ensureWorker(): Promise<PocketTtsWorker> {
  if (worker && worker.ready) return worker;
  if (bootingPromise) return bootingPromise;
  bootingPromise = (async () => {
    const w = new PocketTtsWorker();
    worker = w;
    w.start();
    await w.readyPromise;
    return w;
  })();
  try {
    return await bootingPromise;
  } finally {
    bootingPromise = null;
  }
}

const WAV_RE = /^[A-Za-z0-9_.-]{1,80}\.wav$/i;

// Split a persona's `tts.voice` into the two fields the worker needs.
// - `.wav` filename or absolute path → reference cloning. The base voice falls
//   back to the configured default so the model still has a speaker prior to
//   anchor against if the reference load fails.
// - Anything else → built-in voice id, no reference path.
function resolveVoice(value?: string): { voice: string; referenceWav: string } {
  const v = (value || '').trim();
  if (!v) return { voice: config.pocketTts.defaultVoice, referenceWav: '' };
  if (path.isAbsolute(v)) return { voice: config.pocketTts.defaultVoice, referenceWav: v };
  if (WAV_RE.test(v)) {
    const primary = path.join(config.voices.dir, v);
    if (existsSync(primary)) {
      return { voice: config.pocketTts.defaultVoice, referenceWav: primary };
    }
    const legacy = path.join(config.voices.legacyDir, v);
    if (existsSync(legacy)) {
      return { voice: config.pocketTts.defaultVoice, referenceWav: legacy };
    }
    // File missing — let the worker surface the failure and fall back to the
    // default voice, mirroring chatterbox's behaviour when a reference is
    // unreadable. The canonical path goes on the wire so the error message
    // points at the right place.
    return { voice: config.pocketTts.defaultVoice, referenceWav: primary };
  }
  return { voice: v, referenceWav: '' };
}

export async function speak(
  text: string,
  { outPath: customPath, voice }: { outPath?: string; voice?: string } = {},
): Promise<string> {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  await mkdir(config.piper.outDir, { recursive: true });

  const id = crypto.randomBytes(6).toString('hex');
  const outPath = customPath || path.join(config.piper.outDir, `${id}.wav`);
  if (customPath) await mkdir(path.dirname(customPath), { recursive: true });

  const { voice: resolvedVoice, referenceWav } = resolveVoice(voice);

  if (isRemoteEnabled()) {
    return speakRemote({
      engine: 'pocket-tts',
      text: text.trim(),
      out: outPath,
      voice: resolvedVoice,
      referenceWav,
    });
  }

  const w = await ensureWorker();
  const msg = await w.send(id, {
    text: text.trim(),
    voice: resolvedVoice,
    reference_wav: referenceWav,
    out: outPath,
  });
  // Make a silent voice substitution visible (issue #238) — mirrors the
  // logging speakRemote() does on the sidecar path.
  if (msg.fell_back) {
    console.warn(
      `[pocket-tts] requested voice "${referenceWav || resolvedVoice}" not honoured`
        + ` (${msg.fell_back_reason || 'fell back'}); rendered "${msg.voice_used ?? 'default'}"`,
    );
  }
  return msg.path;
}

// In sidecar mode this is the cached result of the /health probe loop; the
// dispatcher reads it synchronously so we can't await per-call. In local
// mode it's existsSync on the venv interpreter and worker script — true in
// a --build-arg WITH_POCKETTTS=1 image, false in the default image — which
// is what lets the dispatcher fall back to Piper.
let remoteAvailable = false;
let remoteCloning: boolean | null = null;
if (isRemoteEnabled()) {
  startProbeLoop('pocket-tts', (avail, meta) => {
    remoteAvailable = avail;
    remoteCloning = meta?.voiceCloning ?? null;
  });
}

export function isAvailable() {
  if (isRemoteEnabled()) return remoteAvailable;
  return existsSync(config.pocketTts.python) && existsSync(config.pocketTts.workerScript);
}

// Whether PocketTTS can do zero-shot voice cloning (the gated kyutai/pocket-tts
// weights loaded). Returns null when not yet known — the sidecar is still
// booting, or (local mode) the worker hasn't been spawned yet, since it only
// reports the capability in its ready message. Surfaced via tts.availableEngines()
// / describeRouting() so the admin UI can warn that cloned voices won't take
// effect (issue #238) rather than letting them silently revert.
export function cloningAvailable(): boolean | null {
  if (isRemoteEnabled()) return remoteCloning;
  return localCloning;
}
