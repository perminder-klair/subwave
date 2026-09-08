// PocketTTS client, two modes. Sidecar (config.ttsHeavy.url set): speak() POSTs
// to the subwave-tts-heavy container and isAvailable() reads a cached /health
// probe. Local spawn (--build-arg WITH_POCKETTTS=1): pocket_tts_worker.py stays
// resident, one JSON request per line over stdio.
//
// Voice selection: a built-in id (alba, anna, …) plays the curated voice; a
// `.wav` filename triggers zero-shot cloning against config.voices.dir, with a
// fallback read of the legacy chatterbox-voices/ (#213).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  isRemoteEnabled,
  speakRemote,
  startProbeLoop,
} from './ttsHeavyClient.js';
import { resolveTtsOutPath } from './tts-out.js';

// The first call still imports torch and warms the Hugging Face cache.
const READY_TIMEOUT_MS = 60_000;
// ~6x real-time on a modern CPU, so a DJ line finishes well under 10s. The 120s
// ceiling is the first-call-after-cold-boot, slow-disk budget.
const REQUEST_TIMEOUT_MS = parseInt(process.env.POCKET_TTS_REQUEST_TIMEOUT_MS || '120000', 10);

type PendingRequest = {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: PocketTtsWorker | null = null;
let bootingPromise: Promise<PocketTtsWorker> | null = null;
// Local-spawn cloning capability (gated weights present); null until the worker
// reports it in its ready message. The sidecar path uses `remoteCloning`. #238.
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

    // A spawn that never starts emits 'error', not 'exit', and an unhandled
    // 'error' event takes the whole controller down. This engine's interpreter
    // is absent whenever its venv install did not happen, and
    // POST /settings/tts/preview bypasses isAvailable() on purpose. Route it
    // into failReady() like every other boot failure: the caller's promise
    // rejects, the dispatcher falls back, the station keeps making sound.
    this.proc.on('error', (err: Error) => {
      console.error(`[pocket-tts] worker spawn failed: ${err.message}`);
      this.fatalError = err;
      // No pending requests can exist yet: speak() awaits readyPromise first.
      this.failReady(err);
    });

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

// Reap the resident worker on shutdown. Only matters on the bare-process path
// (npm start / dev); Docker tears down the whole process group, and sidecar mode
// spawns nothing. Best-effort SIGTERM.
export function stop(): void {
  const w = worker;
  worker = null;
  w?.proc?.kill('SIGTERM');
}

const WAV_RE = /^[A-Za-z0-9_.-]{1,80}\.wav$/i;

// Split a persona's `tts.voice` into the two fields the worker needs: a `.wav`
// filename or absolute path is reference cloning (base voice falls back to the
// configured default so a failed reference load still has a speaker prior),
// anything else is a built-in voice id.
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
    // File missing: let the worker surface the failure and fall back to the
    // default voice, like chatterbox does. The canonical path goes on the wire
    // so the error message points at the right place.
    return { voice: config.pocketTts.defaultVoice, referenceWav: primary };
  }
  return { voice: v, referenceWav: '' };
}

export async function speak(
  text: string,
  { outPath: customPath, voice }: { outPath?: string; voice?: string } = {},
): Promise<string> {
  const { id, outPath } = await resolveTtsOutPath(text, customPath);

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
  // Make a silent voice substitution visible (#238), like speakRemote() does.
  if (msg.fell_back) {
    console.warn(
      `[pocket-tts] requested voice "${referenceWav || resolvedVoice}" not honoured`
        + ` (${msg.fell_back_reason || 'fell back'}); rendered "${msg.voice_used ?? 'default'}"`,
    );
  }
  return msg.path;
}

// Sidecar mode: the cached /health probe result (the dispatcher reads this
// synchronously, so it can't await). Local mode: existsSync on the venv
// interpreter and worker script, false in the default image, which is what lets
// the dispatcher fall back to Piper.
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

// Whether zero-shot cloning is possible (gated weights loaded); null when not
// yet known (sidecar booting, or no worker spawned yet). Surfaced so the admin
// UI can warn instead of letting a cloned voice silently revert (#238).
export function cloningAvailable(): boolean | null {
  if (isRemoteEnabled()) return remoteCloning;
  return localCloning;
}
