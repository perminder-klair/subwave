// Chatterbox TTS client — two modes:
//
// 1. Sidecar mode (when config.ttsHeavy.url is set). speak() POSTs to the
//    subwave-tts-heavy container (docker/Dockerfile.tts-heavy +
//    docker/tts-heavy/server.py). isAvailable() reads the cached result of
//    a periodic /health probe. This is the default deployment story for
//    operators on the pre-built ghcr.io images (issue #103).
//
// 2. Local-spawn mode (the original). chatterbox_worker.py loads the
//    Chatterbox Turbo model once (5-15s) and stays resident, reading one
//    JSON request per line over stdin and emitting one JSON response per
//    line on stdout. This is the legacy --build-arg WITH_CHATTERBOX=1 path
//    in docker/Dockerfile.controller; kept working for backwards compat.
//
// The dispatcher in tts.ts treats both modes identically — speak() returns a
// WAV path, isAvailable() returns a boolean, that's the whole contract.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  isRemoteEnabled,
  speakRemote,
  startProbeLoop,
} from './ttsHeavyClient.js';

const READY_TIMEOUT_MS = 120_000;        // first call may include model + weights load
// Chatterbox is heavier than Kokoro — 350M params vs ~80M — and on CPU a single
// sentence can take 1-3s. On GPU it's ~75ms. The 180s ceiling matches Kokoro's
// for symmetry; CHATTERBOX_REQUEST_TIMEOUT_MS overrides for tighter ops.
const REQUEST_TIMEOUT_MS = parseInt(process.env.CHATTERBOX_REQUEST_TIMEOUT_MS || '180000', 10);

type PendingRequest = {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: ChatterboxWorker | null = null;
let bootingPromise: Promise<ChatterboxWorker> | null = null;

class ChatterboxWorker {
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
    this.proc = spawn(config.chatterbox.python, [config.chatterbox.workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CHATTERBOX_DEVICE: config.chatterbox.device,
        CHATTERBOX_REFERENCE_WAV: config.chatterbox.referenceWav,
      },
    });

    this.readyTimer = setTimeout(() => {
      this.failReady(new Error('chatterbox worker ready timeout'));
    }, READY_TIMEOUT_MS);

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) console.error(`[chatterbox] ${text}`);
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
      catch { console.error('[chatterbox] bad json from worker:', line); continue; }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg: any) {
    if (msg.ready) {
      this.ready = true;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyResolve?.();
      return;
    }
    if (msg.fatal) {
      this.fatalError = new Error(msg.error || 'chatterbox worker fatal');
      this.failReady(this.fatalError);
      return;
    }
    const pending = this.requests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.requests.delete(msg.id);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.error || 'chatterbox request failed'));
  }

  failReady(err: Error) {
    if (this.ready) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyReject?.(err);
  }

  onExit(code: number | null, signal: NodeJS.Signals | null) {
    console.error(`[chatterbox] worker exited code=${code} signal=${signal}`);
    const err = this.fatalError || new Error(`chatterbox worker exited (${code ?? signal})`);
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
        reject(new Error(`chatterbox request ${id} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(id, { resolve, reject, timer });
      this.proc?.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }
}

async function ensureWorker(): Promise<ChatterboxWorker> {
  if (worker && worker.ready) return worker;
  if (bootingPromise) return bootingPromise;
  bootingPromise = (async () => {
    const w = new ChatterboxWorker();
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

// `voice` here is the reference-WAV filename (not a voice id like Kokoro's
// `bf_isabella`). The dispatcher passes the persona's `voice` field directly;
// resolve it against the configured voice directory so the worker gets an
// absolute path (or empty string → built-in voice).
//
// Shared with PocketTTS via `config.voices` (issue #213). The new canonical
// path is `state/voices/`; the legacy `state/chatterbox-voices/` is still
// probed so pre-existing installs don't break — `voices/` wins on filename
// clash.
export function resolveReferenceWav(voice?: string): string {
  if (!voice) return '';
  if (path.isAbsolute(voice)) return voice;
  const primary = path.join(config.voices.dir, voice);
  if (existsSync(primary)) return primary;
  const legacy = path.join(config.voices.legacyDir, voice);
  if (existsSync(legacy)) return legacy;
  // Neither exists yet — return the canonical path; the worker will surface a
  // clear error rather than silently use a stale legacy file.
  return primary;
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

  if (isRemoteEnabled()) {
    return speakRemote({
      engine: 'chatterbox',
      text: text.trim(),
      out: outPath,
      referenceWav: resolveReferenceWav(voice),
    });
  }

  const w = await ensureWorker();
  const msg = await w.send(id, {
    text: text.trim(),
    reference_wav: resolveReferenceWav(voice),
    out: outPath,
  });
  return msg.path;
}

// In sidecar mode this is the cached result of the /health probe loop; the
// dispatcher reads it synchronously so we can't await per-call. In local
// mode it's existsSync on the venv interpreter and worker script — true in
// a --build-arg WITH_CHATTERBOX=1 image, false in the default image — which
// is what lets the dispatcher fall back to Piper.
let remoteAvailable = false;
if (isRemoteEnabled()) {
  startProbeLoop('chatterbox', (avail) => {
    remoteAvailable = avail;
  });
}

export function isAvailable() {
  if (isRemoteEnabled()) return remoteAvailable;
  return existsSync(config.chatterbox.python) && existsSync(config.chatterbox.workerScript);
}

// List the reference-WAV filenames the operator has uploaded into the shared
// voice directory. The admin UI uses these to populate the per-persona voice
// dropdown for BOTH Chatterbox and PocketTTS (issue #213). Returns [] (not an
// error) if the directories don't exist yet — that's the pre-install state and
// the UI handles it gracefully.
//
// The legacy `state/chatterbox-voices/` folder is still scanned so operators
// who set up before #213 don't have to move files. Filenames present in both
// dirs are deduped (the canonical `state/voices/` copy wins on resolution —
// see resolveReferenceWav).
let legacyWarned = false;
async function readVoiceWavs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.toLowerCase().endsWith('.wav'));
  } catch {
    return [];
  }
}
export async function listReferenceVoices(): Promise<string[]> {
  const [primary, legacy] = await Promise.all([
    readVoiceWavs(config.voices.dir),
    readVoiceWavs(config.voices.legacyDir),
  ]);
  if (legacy.length > 0 && !legacyWarned) {
    legacyWarned = true;
    console.log(
      `[voices] reading ${legacy.length} legacy voice(s) from ${config.voices.legacyDir}`
      + ` — move them to ${config.voices.dir} when convenient`,
    );
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const f of [...primary, ...legacy]) {
    if (seen.has(f)) continue;
    seen.add(f);
    merged.push(f);
  }
  return merged.sort();
}

export function voiceDir(): string {
  return config.voices.dir;
}
