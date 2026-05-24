// PocketTTS client — supervises a persistent Python worker over stdio.
//
// pocket_tts_worker.py loads the kyutai-labs PocketTTS model once (a few
// seconds) and stays resident, reading one JSON request per line and emitting
// one JSON response per line. Lifecycle is identical to kokoro.ts /
// chatterbox.ts — lazy spawn on first speak(), auto-restart on crash, a small
// request map keyed by random id.
//
// v1 ships built-in voices only (alba, anna, charles, …). PocketTTS supports
// reference-WAV cloning too, but the wrapper deliberately doesn't expose it
// yet — the settings surface lists a curated voice id set instead.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

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

// PocketTTS built-in voices. The model also accepts reference-WAV paths for
// zero-shot cloning, but the v1 wrapper sticks to the curated list — the
// settings layer (POCKET_TTS_VOICES) is the source of truth for what the UI
// offers. Anything not on this list falls back to the default voice in the
// worker itself, so an unknown value never breaks a spoken segment.
export const BUILTIN_VOICES = [
  'alba',
  'anna',
  'charles',
  'estelle',
  'giovanni',
  'juergen',
  'lola',
  'rafael',
] as const;

export async function speak(
  text: string,
  { outPath: customPath, voice }: { outPath?: string; voice?: string } = {},
): Promise<string> {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  await mkdir(config.piper.outDir, { recursive: true });

  const id = crypto.randomBytes(6).toString('hex');
  const outPath = customPath || path.join(config.piper.outDir, `${id}.wav`);
  if (customPath) await mkdir(path.dirname(customPath), { recursive: true });

  const w = await ensureWorker();
  const msg = await w.send(id, {
    text: text.trim(),
    voice: voice || config.pocketTts.defaultVoice,
    out: outPath,
  });
  return msg.path;
}

// PocketTTS is bundled only when the controller image is built with
// `--build-arg WITH_POCKETTTS=1`, so a configured path isn't proof the runtime
// exists. Check the venv interpreter and worker script are actually on disk —
// true in a PocketTTS-enabled image, false otherwise — which lets the
// dispatcher fall back to Piper without trying to spawn a missing python.
export function isAvailable() {
  return existsSync(config.pocketTts.python) && existsSync(config.pocketTts.workerScript);
}
