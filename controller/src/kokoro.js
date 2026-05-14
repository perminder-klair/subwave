// Kokoro TTS client — supervises a persistent Python worker over stdio.
//
// kokoro_worker.py loads the ONNX model once (2-5s) and stays resident,
// reading one JSON request per line and emitting one JSON response per line.
// We manage the lifecycle here: lazy spawn on first speak(), auto-restart
// on crash, and a small request map keyed by monotonic id.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const READY_TIMEOUT_MS = 60_000;        // first call may include model load
// Generous because Kokoro on Apple Silicon runs under Rosetta (linux/amd64 image
// on arm64 host) and ONNX inference can easily take 30-120s for a typical DJ
// line. On a native Linux x86 host it completes in 1-2s — this ceiling is never
// hit there. Override via KOKORO_REQUEST_TIMEOUT_MS if you want to clamp tighter.
const REQUEST_TIMEOUT_MS = parseInt(process.env.KOKORO_REQUEST_TIMEOUT_MS || '180000', 10);

let worker = null;        // active Worker or null
let bootingPromise = null;

class Worker {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.requests = new Map();   // id → { resolve, reject, timer }
    this.buffer = '';
    this.fatalError = null;
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

    this.proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) console.error(`[kokoro] ${text}`);
    });
    this.proc.on('exit', (code, signal) => this.onExit(code, signal));
  }

  onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { console.error('[kokoro] bad json from worker:', line); continue; }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    if (msg.ready) {
      this.ready = true;
      clearTimeout(this.readyTimer);
      this.readyResolve();
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

  failReady(err) {
    if (this.ready) return;
    clearTimeout(this.readyTimer);
    this.readyReject(err);
  }

  onExit(code, signal) {
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

  send(id, payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`kokoro request ${id} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }
}

async function ensureWorker() {
  if (worker && worker.ready) return worker;
  if (bootingPromise) return bootingPromise;
  bootingPromise = (async () => {
    const w = new Worker();
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

export async function speak(text, { outPath: customPath, voice } = {}) {
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
    speed: config.kokoro.speed,
    out: outPath,
  });
  return msg.path;
}

export function isAvailable() {
  return Boolean(config.kokoro.python && config.kokoro.workerScript);
}
