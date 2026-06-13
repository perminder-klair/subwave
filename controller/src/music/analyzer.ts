// Acoustic-analysis client — resolves bpm / key / intro for a track id by
// running librosa, which deliberately does NOT live in the controller image.
//
// Two backends, in priority order:
//   1. tts-heavy sidecar — POST {url} to its /analyze endpoint (production).
//   2. local Python venv — spawn scripts/analyze_worker.py over stdio, the
//      same persistent-worker pattern as audio/kokoro.ts (offline / dev; set
//      ANALYZE_PYTHON to a venv that has librosa).
//
// When neither is available, isAvailable() returns false and the analysis
// phase (music/analyze.ts) skips cleanly — the station is unaffected, every
// analysis column stays NULL, and consumers behave exactly as today.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import * as subsonic from './subsonic.js';

export interface AnalysisResult {
  bpm: number | null;
  musicalKey: string | null;
  introMs: number | null;
  confidence: number | null;
  // Integrated loudness (LUFS, BS.1770) + peak (dBFS) over the analysis window,
  // when the backend has pyloudnorm. null otherwise — consumers treat null as
  // "no loudness, play at unity gain", so a backend without pyloudnorm behaves
  // exactly as today. loudnessLufs feeds per-track gain normalisation.
  loudnessLufs: number | null;
  peakDb: number | null;
  // CLAP audio embedding (512 floats) when the backend has the model loaded
  // (ANALYZE_AUDIO_EMBEDDING=1 + CLAP weights). null otherwise — every consumer
  // treats null as "no audio vector this pass", so a backend without CLAP is
  // byte-for-byte today's behaviour.
  audioEmbedding: number[] | null;
}

// Coerce a worker numeric field to a finite number or null. The worker omits
// loudness/peak entirely when pyloudnorm is absent or measurement failed.
function parseFinite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Coerce the worker's audio_embedding field to a clean number[] or null. The
// worker omits it entirely when CLAP isn't loaded; defend against a malformed
// or wrong-length array rather than letting it reach upsertTrackAudioVector.
function parseAudioEmbedding(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    out.push(x);
  }
  return out;
}

// Cap the download so we don't pull whole albums of bytes for a short
// analysis window — mirrors ANALYZE_MAX_BYTES in the Python worker so both
// fetch paths read the same envelope.
const ANALYZE_MAX_BYTES = parseInt(process.env.ANALYZE_MAX_BYTES || String(12 * 1024 * 1024), 10);
// Where the controller stages pre-fetched audio. Lives under the shared
// state dir (mounted at the same /var/sub-wave path in both the controller and
// the tts-heavy sidecar), so the path string the controller writes resolves to
// the same file inside the sidecar — that's what makes the path handoff work.
const ANALYZE_TMP_DIR = `${config.stateDir}/analyze-tmp`;

// ---------------------------------------------------------------------------
// Local Python worker (persistent over stdio)
// ---------------------------------------------------------------------------

function localConfigured(): boolean {
  const { python, workerScript } = config.analyzer;
  return !!python && existsSync(python) && existsSync(workerScript);
}

type Pending = { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let proc: ChildProcessWithoutNullStreams | null = null;
let ready = false;
let booting: Promise<void> | null = null;
let buffer = '';
let reqSeq = 0;
const pending = new Map<string, Pending>();

function startWorker(): Promise<void> {
  if (booting) return booting;
  booting = new Promise<void>((resolve, reject) => {
    const p = spawn(config.analyzer.python, [config.analyzer.workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ANALYZE_SECONDS: String(config.analyzer.seconds) },
    });
    proc = p;
    const readyTimer = setTimeout(() => reject(new Error('analyze worker ready timeout')), 60_000);

    p.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) { ready = true; clearTimeout(readyTimer); resolve(); continue; }
        if (msg.fatal) { clearTimeout(readyTimer); reject(new Error(msg.error || 'analyze worker fatal')); continue; }
        const waiter = pending.get(msg.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        pending.delete(msg.id);
        if (msg.ok) waiter.resolve(msg);
        else waiter.reject(new Error(msg.error || 'analyze failed'));
      }
    });
    p.stderr.on('data', (c: Buffer) => {
      const t = c.toString('utf8').trimEnd();
      if (t) console.error(`[analyze] ${t}`);
    });
    p.on('exit', (code) => {
      ready = false; proc = null; booting = null;
      const err = new Error(`analyze worker exited (${code})`);
      for (const { reject: rej, timer } of pending.values()) { clearTimeout(timer); rej(err); }
      pending.clear();
    });
  });
  return booting;
}

// Per-request analysis options. `embed: true` asks the backend to (lazy-load
// and) run CLAP for this track even when the backend's own env doesn't enable
// it — the admin-toggle path. Omitted → the backend's env-driven default.
export interface AnalyzeRequestOpts {
  embed?: boolean;
}

// Write a request to the local stdio worker and resolve its response. The
// request carries either `url` (worker downloads) or `path` (already-local).
function localRequest(req: ({ url: string } | { path: string }) & AnalyzeRequestOpts): Promise<AnalysisResult> {
  const id = `a${++reqSeq}`;
  return new Promise<AnalysisResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('analyze request timed out'));
    }, config.analyzer.requestTimeoutMs);
    pending.set(id, {
      resolve: (msg: any) =>
        resolve({
          bpm: msg.bpm ?? null,
          musicalKey: msg.key ?? null,
          introMs: msg.intro_ms ?? null,
          confidence: msg.confidence ?? null,
          loudnessLufs: parseFinite(msg.loudness_lufs),
          peakDb: parseFinite(msg.peak_db),
          audioEmbedding: parseAudioEmbedding(msg.audio_embedding),
        }),
      reject,
      timer,
    });
    proc?.stdin.write(JSON.stringify({ id, ...req }) + '\n');
  });
}

async function analyzeViaLocal(url: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  if (!ready) await startWorker();
  return localRequest({ url, ...opts });
}

async function analyzeViaLocalPath(path: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  if (!ready) await startWorker();
  return localRequest({ path, ...opts });
}

// ---------------------------------------------------------------------------
// Sidecar backend
// ---------------------------------------------------------------------------

// Last sidecar /health read of the CLAP capability. null = unknown (not yet
// probed, or the field is absent on an old sidecar); true/false once known.
let _sidecarAudioCapable: boolean | null = null;

async function sidecarReachable(): Promise<boolean> {
  const url = config.ttsHeavy.url;
  if (!url) return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(`${url}/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; engines?: string[]; analyze_audio_capable?: boolean | null };
    const reachable = !!body.ok && Array.isArray(body.engines) && body.engines.includes('analyze');
    if (reachable) {
      _sidecarAudioCapable = typeof body.analyze_audio_capable === 'boolean' ? body.analyze_audio_capable : null;
    }
    return reachable;
  } catch {
    return false;
  }
}

// POST the sidecar a request body of either {url} (it downloads) or {path}
// (a file on the shared volume the controller pre-fetched).
async function sidecarRequest(body: ({ url: string } | { path: string }) & AnalyzeRequestOpts): Promise<AnalysisResult> {
  const base = config.ttsHeavy.url;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), config.analyzer.requestTimeoutMs);
  try {
    const res = await fetch(`${base}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`tts-heavy /analyze ${res.status}: ${await res.text().catch(() => '')}`);
    const resBody = (await res.json()) as any;
    if (!resBody.ok) throw new Error(resBody.error || 'analysis failed');
    return {
      bpm: resBody.bpm ?? null,
      musicalKey: resBody.key ?? null,
      introMs: resBody.intro_ms ?? null,
      confidence: resBody.confidence ?? null,
      loudnessLufs: parseFinite(resBody.loudness_lufs),
      peakDb: parseFinite(resBody.peak_db),
      audioEmbedding: parseAudioEmbedding(resBody.audio_embedding),
    };
  } finally {
    clearTimeout(t);
  }
}

function analyzeViaSidecar(url: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  return sidecarRequest({ url, ...opts });
}

function analyzeViaSidecarPath(path: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  return sidecarRequest({ path, ...opts });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

let _backend: 'sidecar' | 'local' | null = null;

// Resolve once which backend to use. Sidecar wins when it advertises the
// 'analyze' capability; otherwise a configured local venv; otherwise none.
export async function resolveBackend(): Promise<'sidecar' | 'local' | null> {
  if (_backend) return _backend;
  if (await sidecarReachable()) { _backend = 'sidecar'; return _backend; }
  if (localConfigured()) { _backend = 'local'; return _backend; }
  return null;
}

export async function isAvailable(): Promise<boolean> {
  return (await resolveBackend()) !== null;
}

export function backendLabel(): string {
  return _backend || 'none';
}

// Whether the active backend can emit CLAP "sounds-like" audio embeddings right
// now. null = unknown (local backend — we don't probe its venv; or sidecar not
// yet reached); false = sidecar reachable but built without the CLAP stack
// (WITH_CLAP=0) — the signal the admin UI turns into a "rebuild the sidecar"
// warning. Only meaningful for the sidecar backend.
export function audioEmbeddingAvailable(): boolean | null {
  return _backend === 'sidecar' ? _sidecarAudioCapable : null;
}

// Re-read sidecar /health so capability reflects a sidecar rebuilt under a
// long-lived controller (resolveBackend caches the backend *choice* forever,
// but CLAP support flips when the operator rebuilds with WITH_CLAP=1). Cheap;
// driven on the coverage staleness cadence.
export async function refreshCapabilities(): Promise<void> {
  if ((await resolveBackend()) === 'sidecar') await sidecarReachable();
}

// Analyse one track by id. Throws on failure — the caller (analyze pass) logs
// and moves on, leaving the row NULL so it's retried on the next run. This is
// the URL path: the backend fetches the audio itself. Kept as the fallback
// for the prefetch pipeline (see analyzePath / downloadCapped below).
export async function analyze(songId: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  const backend = await resolveBackend();
  if (!backend) throw new Error('no analysis backend available');
  const url = subsonic.getRawStreamUrl(songId);
  return backend === 'sidecar' ? analyzeViaSidecar(url, opts) : analyzeViaLocal(url, opts);
}

// Download a track's audio to a capped temp file on the shared state volume
// and return the absolute path. The controller does this AHEAD of the
// backend's compute so network fetch (controller) overlaps DSP (backend) —
// the path is valid in both containers because the shared dir mounts at the
// same location. Caps bytes + applies the analyzer request timeout. Throws
// on any error; the caller falls back to the url path for that one track.
export async function downloadCapped(songId: string): Promise<string> {
  mkdirSync(ANALYZE_TMP_DIR, { recursive: true });
  const dest = `${ANALYZE_TMP_DIR}/${encodeURIComponent(songId)}.audio`;
  const url = subsonic.getRawStreamUrl(songId);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), config.analyzer.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'subwave-analyzer/1' },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`download ${res.status}: ${await res.text().catch(() => '')}`);
    }
    // Stream the body to disk, stopping once we've pulled the byte cap — a few
    // MB covers the analysis window for any common codec. A capped async
    // generator feeds pipeline (which handles backpressure and tears the source
    // down when we return early). The previous approach — a `data` listener
    // that called src.destroy() alongside pipeline — deadlocked: attaching the
    // listener flips the web-backed Readable into flowing mode and races the
    // pipe, so pipeline() never resolves and every download hangs.
    let read = 0;
    async function* capped() {
      for await (const chunk of res.body as any) {
        read += chunk.length;
        yield chunk;
        if (read >= ANALYZE_MAX_BYTES) return; // enough audio for the window
      }
    }
    await pipeline(capped(), createWriteStream(dest));
    if (read === 0) throw new Error('downloaded empty audio');
    return dest;
  } finally {
    clearTimeout(t);
  }
}

// Analyse a track from an already-local file on the shared volume (produced
// by downloadCapped). Same backend resolution as analyze(), but hands the
// path over instead of a url so the backend skips its own fetch.
export async function analyzePath(localPath: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  const backend = await resolveBackend();
  if (!backend) throw new Error('no analysis backend available');
  return backend === 'sidecar' ? analyzeViaSidecarPath(localPath, opts) : analyzeViaLocalPath(localPath, opts);
}

export function shutdown(): void {
  try { proc?.stdin.end(); } catch { /* ignore */ }
  try { proc?.kill(); } catch { /* ignore */ }
  proc = null; ready = false; booting = null;
}
