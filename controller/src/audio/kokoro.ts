// Kokoro TTS client: supervises a persistent Python worker over stdio.
// kokoro_worker.py loads the ONNX model once (2-5s) and stays resident, one
// JSON request per line. Lifecycle here: lazy spawn on first speak(),
// auto-restart on crash, request map keyed by monotonic id.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { resolveTtsOutPath } from './tts-out.js';

const READY_TIMEOUT_MS = 60_000;        // first call may include model load
// Generous because Kokoro under Rosetta (amd64 image on an arm64 host) can take
// 30-120s per line; native x86 is 1-2s. KOKORO_REQUEST_TIMEOUT_MS clamps it.
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

    // A spawn that never starts emits 'error', not 'exit', and an unhandled
    // 'error' event takes the whole controller down. This engine's interpreter
    // is absent whenever its venv install did not happen, and
    // POST /settings/tts/preview bypasses isAvailable() on purpose. Route it
    // into failReady() like every other boot failure: the caller's promise
    // rejects, the dispatcher falls back, the station keeps making sound.
    this.proc.on('error', (err: Error) => {
      console.error(`[kokoro] worker spawn failed: ${err.message}`);
      this.fatalError = err;
      // No pending requests can exist yet: speak() awaits readyPromise first.
      this.failReady(err);
    });

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

  // SIGTERM the child and drop the handle. Idempotent and safe on an already
  // exited process; guarded so a race can't throw out of an exit handler.
  reap() {
    const p = this.proc;
    this.proc = null;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    try {
      p.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  failReady(err: Error) {
    if (this.ready) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyReject?.(err);
    // Giving up on the boot must kill the child too: rejecting alone leaves the
    // Python process blocked on stdin with the ONNX model resident, and a later
    // speak() replaces `worker` and orphans it, leaking a few hundred MB per
    // cycle. Model load is 2-5s against a 60s ceiling, so a worker that misses
    // it is stuck rather than slow (REQUEST_TIMEOUT_MS is the knob for slow
    // inference). tts.ts falls back to Piper either way.
    this.reap();
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
  // bootingPromise is nulled as soon as the first boot settles, so a failed boot
  // leaves a non-ready `worker` the next call would otherwise overwrite
  // silently. Reap before replacing: at most one Python child is ever resident.
  if (worker && !worker.ready) {
    worker.reap();
    worker = null;
  }
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

// Reap the resident worker on shutdown. Only matters on the bare-process path
// (npm start / dev); Docker tears down the whole process group. Best-effort.
export function stop(): void {
  const w = worker;
  worker = null;
  w?.reap();
}

export async function speak(
  text: string,
  { outPath: customPath, voice, lang, speedScale }: { outPath?: string; voice?: string; lang?: string; speedScale?: number } = {},
): Promise<string> {
  const { id, outPath } = await resolveTtsOutPath(text, customPath);

  const w = await ensureWorker();
  const msg = await w.send(id, {
    text: text.trim(),
    voice: voice || config.kokoro.voice,
    lang: lang || config.kokoro.lang,
    // Per-call speedScale (daypart energy) composes on top of the config speed.
    speed: config.kokoro.speed * (speedScale != null ? speedScale : 1),
    out: outPath,
  });
  return msg.path;
}

// existsSync the on-disk assets, not the config paths (which always have env
// defaults). The model + voices files are downloaded at image build, and a
// failed download would otherwise report `kokoro: true` while every segment
// silently fell back to Piper.
export function isAvailable() {
  return existsSync(config.kokoro.python)
    && existsSync(config.kokoro.workerScript)
    && existsSync(config.kokoro.model)
    && existsSync(config.kokoro.voices);
}
