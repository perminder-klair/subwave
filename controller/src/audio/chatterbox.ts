// Chatterbox TTS client, two modes. Sidecar (config.ttsHeavy.url set): speak()
// POSTs to the subwave-tts-heavy container and isAvailable() reads a cached
// /health probe. Local spawn (--build-arg WITH_CHATTERBOX=1):
// chatterbox_worker.py stays resident, one JSON request per line over stdio.
// The dispatcher treats both identically: speak() returns a WAV path,
// isAvailable() a boolean.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { scan as scanVoices } from './voice-library.js';
import {
  isRemoteEnabled,
  speakRemote,
  startProbeLoop,
} from './ttsHeavyClient.js';
import { resolveTtsOutPath } from './tts-out.js';

const READY_TIMEOUT_MS = 120_000;        // first call may include model + weights load
// 350M params: a sentence takes 1-3s on CPU, ~75ms on GPU. The 180s ceiling
// matches Kokoro's; CHATTERBOX_REQUEST_TIMEOUT_MS overrides it.
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

    // A spawn that never starts emits 'error', not 'exit', and an unhandled
    // 'error' event takes the whole controller down. This engine's interpreter
    // is absent whenever its venv install did not happen, and
    // POST /settings/tts/preview bypasses isAvailable() on purpose. Route it
    // into failReady() like every other boot failure: the caller's promise
    // rejects, the dispatcher falls back, the station keeps making sound.
    this.proc.on('error', (err: Error) => {
      console.error(`[chatterbox] worker spawn failed: ${err.message}`);
      this.fatalError = err;
      // No pending requests can exist yet: speak() awaits readyPromise first.
      this.failReady(err);
    });

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

// Reap the resident worker on shutdown. Only matters on the bare-process path
// (npm start / dev); Docker tears down the whole process group, and sidecar mode
// spawns nothing. Best-effort SIGTERM.
export function stop(): void {
  const w = worker;
  worker = null;
  w?.proc?.kill('SIGTERM');
}

// `voice` is a reference-WAV filename, not a voice id. Resolved against the
// configured voice directory so the worker gets an absolute path (or '' for the
// built-in voice). The folder is shared with PocketTTS (#213): canonical
// `state/voices/` wins on a filename clash with legacy
// `state/chatterbox-voices/`, which is still probed for older installs.
export function resolveReferenceWav(voice?: string): string {
  if (!voice) return '';
  if (path.isAbsolute(voice)) return voice;
  const primary = path.join(config.voices.dir, voice);
  if (existsSync(primary)) return primary;
  const legacy = path.join(config.voices.legacyDir, voice);
  if (existsSync(legacy)) return legacy;
  // Neither exists: return the canonical path so the worker surfaces a clear
  // error rather than silently using a stale legacy file.
  return primary;
}

export async function speak(
  text: string,
  { outPath: customPath, voice }: { outPath?: string; voice?: string } = {},
): Promise<string> {
  const { id, outPath } = await resolveTtsOutPath(text, customPath);

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

// Sidecar mode: the cached /health probe result (the dispatcher reads this
// synchronously, so it can't await). Local mode: existsSync on the venv
// interpreter and worker script, false in the default image, which is what lets
// the dispatcher fall back to Piper.
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

// Reference-WAV filenames in the shared voice directory, for the per-persona
// dropdown of both Chatterbox and PocketTTS (#213). [] (not an error) when the
// directories don't exist yet. The scan lives in audio/voice-library.ts, the
// single owner of those directories; legacy chatterbox-voices/ is deduped with
// canonical voices/ winning, matching resolveReferenceWav.
// Calls scan() and NOT list(): GET /settings publishes this on every 3s admin
// poll, and list() probes durations with an ffprobe subprocess per voice.
let legacyWarned = false;
export async function listReferenceVoices(): Promise<string[]> {
  const files = await scanVoices();
  const legacy = files.filter((f) => f.legacy);
  if (legacy.length > 0 && !legacyWarned) {
    legacyWarned = true;
    console.log(
      `[voices] reading ${legacy.length} legacy voice(s) from ${config.voices.legacyDir}`
      + ` — move them to ${config.voices.dir} when convenient`,
    );
  }
  return files.map((f) => f.file);
}

export function voiceDir(): string {
  return config.voices.dir;
}
