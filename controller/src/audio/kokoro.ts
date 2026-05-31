// Kokoro TTS client — supervises a persistent Python worker over stdio.
//
// kokoro_worker.py loads the ONNX model once (2-5s) and stays resident,
// reading one JSON request per line and emitting one JSON response per line.
// We manage the lifecycle here: lazy spawn on first speak(), auto-restart
// on crash, and a small request map keyed by monotonic id.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const READY_TIMEOUT_MS = 60_000;        // first call may include model load
// Generous because Kokoro on Apple Silicon runs under Rosetta (linux/amd64 image
// on arm64 host) and ONNX inference can easily take 30-120s for a typical DJ
// line. On a native Linux x86 host it completes in 1-2s — this ceiling is never
// hit there. Override via KOKORO_REQUEST_TIMEOUT_MS if you want to clamp tighter.
const REQUEST_TIMEOUT_MS = parseInt(process.env.KOKORO_REQUEST_TIMEOUT_MS || '180000', 10);

type PendingRequest = {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: KokoroWorker | null = null;        // active Worker or null
let bootingPromise: Promise<KokoroWorker> | null = null;

class KokoroWorker {
  proc: ChildProcessWithoutNullStreams | null = null;
  ready = false;
  readyResolve: (() => void) | null = null;
  readyReject: ((err: Error) => void) | null = null;
  readyPromise: Promise<void>;
  readyTimer: NodeJS.Timeout | null = null;
  requests = new Map<string, PendingRequest>();   // id → { resolve, reject, timer }
  buffer = '';
  fatalError: Error | null = null;

  constructor() {
    this.readyPromise = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
  }

  start() {
    this.proc = spawn(config.kokoro.python, [config.kokoro.workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KOKORO_MODEL: config.kokoro.model,
        KOKORO_VOICES: config.kokoro.voices,
        KOKORO_VOICE: config.kokoro.voice,
        KOKORO_LANG: config.kokoro.lang,
      },
    });

    this.readyTimer = setTimeout(() => {
      this.failReady(new Error('kokoro worker ready timeout'));
    }, READY_TIMEOUT_MS);

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) console.error(`[kokoro] ${text}`);
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
      catch { console.error('[kokoro] bad json from worker:', line); continue; }
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
      this.fatalError = new Error(msg.error || 'kokoro worker fatal');
      this.failReady(this.fatalError);
      return;
    }
    const pending = this.requests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.requests.delete(msg.id);
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.error || 'kokoro request failed'));
  }

  failReady(err: Error) {
    if (this.ready) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyReject?.(err);
  }

  onExit(code: number | null, signal: NodeJS.Signals | null) {
    console.error(`[kokoro] worker exited code=${code} signal=${signal}`);
    const err = this.fatalError || new Error(`kokoro worker exited (${code ?? signal})`);
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
        reject(new Error(`kokoro request ${id} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(id, { resolve, reject, timer });
      this.proc?.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }
}

async function ensureWorker(): Promise<KokoroWorker> {
  if (worker && worker.ready) return worker;
  if (bootingPromise) return bootingPromise;
  bootingPromise = (async () => {
    const w = new KokoroWorker();
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

export async function speak(
  text: string,
  { outPath: customPath, voice, speedScale }: { outPath?: string; voice?: string; speedScale?: number } = {},
): Promise<string> {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  await mkdir(config.piper.outDir, { recursive: true });

  const id = crypto.randomBytes(6).toString('hex');
  const outPath = customPath || path.join(config.piper.outDir, `${id}.wav`);
  if (customPath) await mkdir(path.dirname(customPath), { recursive: true });

  const w = await ensureWorker();
  const msg = await w.send(id, {
    text: text.trim(),
    voice: voice || config.kokoro.voice,
    lang: config.kokoro.lang,
    // Per-call speedScale (daypart energy) composes on top of the config speed.
    speed: config.kokoro.speed * (speedScale != null ? speedScale : 1),
    out: outPath,
  });
  return msg.path;
}

export function isAvailable() {
  return Boolean(config.kokoro.python && config.kokoro.workerScript);
}
