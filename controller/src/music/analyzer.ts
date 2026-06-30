// Acoustic-analysis client — resolves bpm / key / intro for a track id by
// running librosa, which deliberately does NOT live in the controller image.
//
// Two backends, in priority order:
//   1. analysis sidecar — POST {url} to its /analyze endpoint (production).
//      The base URL is resolved from config.analyzer.urls: the dedicated
//      `--profile analyzer` image (ANALYZE_URL) first, then the tts-heavy
//      sidecar (TTS_HEAVY_URL), whose image still carries the analyze worker —
//      so existing tts-heavy installs keep working with zero config.
//   2. local Python venv — spawn scripts/analyze_worker.py over stdio, the
//      same persistent-worker pattern as audio/kokoro.ts (offline / dev; set
//      ANALYZE_PYTHON to a venv that has librosa).
//
// When neither is available, isAvailable() returns false and the analysis
// phase (music/analyze.ts) skips cleanly — the station is unaffected, every
// analysis column stays NULL, and consumers behave exactly as today.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import * as subsonic from './subsonic.js';

// A structural span over the track, in milliseconds (span shape). Spans
// are contiguous and cover the analysed window; the first is the intro/leading
// section. `kind` is reserved for a future labelled segmenter.
export interface Section {
  startMs: number;
  endMs: number;
  kind?: string;
}

// A pace sample: a 0..1 perceptual-energy value over a span.
export interface PaceSpan {
  startMs: number;
  endMs: number;
  value: number;
}

// A key over a time range: tonic note (sharps) + mode, as a span value.
export interface KeyRange {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: 'major' | 'minor';
}

export interface AnalysisResult {
  bpm: number | null;
  musicalKey: string | null;
  introMs: number | null;
  confidence: number | null;
  // Structural sections over the analysed window (intro/leading sections are
  // the reliable part — the outro is beyond the decode window). null when the
  // backend computed none; consumers treat null as "no structure".
  sections: Section[] | null;
  // Vocal-presence ranges (Demucs) over the analysed window. An empty array is
  // a meaningful value — "analysed, instrumental"; null means not computed (no
  // ANALYZE_VOCAL_ACTIVITY / no demucs). Consumers treat null as "no signal".
  vocalRanges: Section[] | null;
  // Perceptual energy/momentum curve (decoupled from BPM), 0..1 per span. null
  // when the backend computed none; consumers treat null as "no signal".
  paceCurve: PaceSpan[] | null;
  // Beat and downbeat (bar) timestamps in ms. null when the backend computed
  // none; consumers treat null as "no grid" (today's blind crossfade).
  beats: number[] | null;
  bars: number[] | null;
  // Per-region key (tonic + mode) over time. null when none computed; the
  // scalar musicalKey stays the back-compat dominant key.
  keyRanges: KeyRange[] | null;
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

// Coerce a list of spans to clean Section[]. Drops malformed/zero-length spans.
function coerceSpans(v: unknown): Section[] {
  if (!Array.isArray(v)) return [];
  const out: Section[] = [];
  for (const s of v) {
    const startMs = parseFinite((s as any)?.startMs);
    const endMs = parseFinite((s as any)?.endMs);
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    const kind = typeof (s as any)?.kind === 'string' ? (s as any).kind : undefined;
    out.push(kind ? { startMs, endMs, kind } : { startMs, endMs });
  }
  return out;
}

// Sections: the worker omits the field when segmentation produced nothing, so
// empty collapses to null ("no structure").
function parseSections(v: unknown): Section[] | null {
  if (!Array.isArray(v)) return null;
  const out = coerceSpans(v);
  return out.length ? out : null;
}

// Vocal ranges: an empty array is a MEANINGFUL value (analysed instrumental),
// distinct from null (not computed). Preserve [] when the field is present.
function parseVocalRanges(v: unknown): Section[] | null {
  if (!Array.isArray(v)) return null;
  return coerceSpans(v);
}

// Key ranges: spans carrying tonic + mode. Drops malformed spans; empty → null.
function parseKeyRanges(v: unknown): KeyRange[] | null {
  if (!Array.isArray(v)) return null;
  const out: KeyRange[] = [];
  for (const s of v) {
    const startMs = parseFinite((s as any)?.startMs);
    const endMs = parseFinite((s as any)?.endMs);
    const tonic = (s as any)?.tonic;
    const mode = (s as any)?.mode;
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    if (typeof tonic !== 'string' || (mode !== 'major' && mode !== 'minor')) continue;
    out.push({ startMs, endMs, tonic, mode });
  }
  return out.length ? out : null;
}

// A list of ms timestamps → sorted finite number[] or null (empty → null).
function parseMsList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
  return out.length ? out : null;
}

// Pace curve: spans carrying a 0..1 value. Drops malformed/zero-length spans;
// empty collapses to null ("no pace").
function parsePaceCurve(v: unknown): PaceSpan[] | null {
  if (!Array.isArray(v)) return null;
  const out: PaceSpan[] = [];
  for (const s of v) {
    const startMs = parseFinite((s as any)?.startMs);
    const endMs = parseFinite((s as any)?.endMs);
    const value = parseFinite((s as any)?.value);
    if (startMs == null || endMs == null || value == null || endMs <= startMs) continue;
    out.push({ startMs, endMs, value });
  }
  return out.length ? out : null;
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
  // Force a (lazy) Demucs load for vocal-activity ranges even when the backend's
  // ANALYZE_VOCAL_ACTIVITY env is off — the admin/backfill path, mirroring embed.
  vocal?: boolean;
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
          sections: parseSections(msg.sections),
          vocalRanges: parseVocalRanges(msg.vocal_ranges),
          paceCurve: parsePaceCurve(msg.pace_curve),
          beats: parseMsList(msg.beats),
          bars: parseMsList(msg.bars),
          keyRanges: parseKeyRanges(msg.key_ranges),
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
// Same, for vocal-activity (Demucs) support — null until probed/absent field.
let _sidecarVocalCapable: boolean | null = null;
// The candidate base URL that last reported the 'analyze' engine — the one
// sidecarRequest POSTs to. Set by sidecarReachable; '' until a probe succeeds.
let _sidecarBase = '';

// Probe one candidate /health for the 'analyze' engine. Records the capability
// flags + the winning base URL on success.
async function probeSidecar(url: string): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(`${url}/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = (await res.json()) as {
      ok?: boolean;
      engines?: string[];
      analyze_audio_capable?: boolean | null;
      analyze_vocal_capable?: boolean | null;
    };
    const reachable = !!body.ok && Array.isArray(body.engines) && body.engines.includes('analyze');
    if (reachable) {
      _sidecarBase = url;
      _sidecarAudioCapable = typeof body.analyze_audio_capable === 'boolean' ? body.analyze_audio_capable : null;
      _sidecarVocalCapable = typeof body.analyze_vocal_capable === 'boolean' ? body.analyze_vocal_capable : null;
    }
    return reachable;
  } catch {
    return false;
  }
}

// Try each configured candidate (dedicated analyzer first, then the tts-heavy
// sidecar) and stop at the first that advertises the 'analyze' engine.
async function sidecarReachable(): Promise<boolean> {
  for (const url of config.analyzer.urls) {
    if (await probeSidecar(url)) return true;
  }
  return false;
}

// POST the sidecar a request body of either {url} (it downloads) or {path}
// (a file on the shared volume the controller pre-fetched).
async function sidecarRequest(body: ({ url: string } | { path: string }) & AnalyzeRequestOpts): Promise<AnalysisResult> {
  const base = _sidecarBase;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), config.analyzer.requestTimeoutMs);
  try {
    const res = await fetch(`${base}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`analyze sidecar ${res.status}: ${await res.text().catch(() => '')}`);
    const resBody = (await res.json()) as any;
    if (!resBody.ok) throw new Error(resBody.error || 'analysis failed');
    return {
      bpm: resBody.bpm ?? null,
      musicalKey: resBody.key ?? null,
      introMs: resBody.intro_ms ?? null,
      confidence: resBody.confidence ?? null,
      loudnessLufs: parseFinite(resBody.loudness_lufs),
      peakDb: parseFinite(resBody.peak_db),
      sections: parseSections(resBody.sections),
      vocalRanges: parseVocalRanges(resBody.vocal_ranges),
      paceCurve: parsePaceCurve(resBody.pace_curve),
      beats: parseMsList(resBody.beats),
      bars: parseMsList(resBody.bars),
      keyRanges: parseKeyRanges(resBody.key_ranges),
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

// Whether the active backend can emit Demucs vocal-activity ranges right now.
// Same semantics as audioEmbeddingAvailable: null = unknown (local, or sidecar
// not yet reached / old sidecar without the field); false = sidecar built
// without the demucs stack (WITH_DEMUCS=0). Only meaningful for the sidecar.
export function vocalActivityAvailable(): boolean | null {
  return _backend === 'sidecar' ? _sidecarVocalCapable : null;
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

// A stream response that wasn't audio — Navidrome answers a request for a file
// that's missing on disk (a stale library entry still in its DB) with an HTTP
// 200 Subsonic error envelope, not audio bytes. Typed so the analysis loop can
// tell this APART from a transient network failure: there's no point retrying
// it via the url path (the file is simply gone), so the caller records it as a
// clean failure instead of masking it behind the url-fallback's decode error.
export class NonAudioResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonAudioResponseError';
  }
}

// Pull the human-readable message out of a Subsonic error envelope (JSON or the
// XML attribute form), falling back to a trimmed snippet when it isn't a
// recognisable envelope.
function subsonicErrorMessage(body: string): string {
  if (!body) return 'empty response';
  try {
    const j = JSON.parse(body);
    const msg = j?.['subsonic-response']?.error?.message;
    if (msg) return String(msg);
  } catch { /* not JSON — try the XML attribute form below */ }
  const m = body.match(/message="([^"]+)"/);
  return m ? m[1] : body.slice(0, 200).replace(/\s+/g, ' ').trim();
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
    // Navidrome returns Subsonic API errors (e.g. a file that's gone from disk
    // but still indexed — a stale library entry) as HTTP 200 with a JSON/XML
    // body, NOT audio. Without this guard we'd stream that envelope to disk as
    // `.audio` and the decoder would fail opaquely ("analyze failed"). Catch it
    // on the content type and surface the real reason.
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json') || contentType.includes('xml') || contentType.startsWith('text/')) {
      const body = await res.text().catch(() => '');
      throw new NonAudioResponseError(
        `navidrome returned ${contentType || 'a non-audio response'}, not audio: ${subsonicErrorMessage(body)}`,
      );
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
    // Backstop for the content-type guard: an error envelope that slipped past
    // the headers is tiny and starts with '{' (JSON) or '<' (XML); real audio
    // never does (m4a 'ftyp' box, mp3 ID3 / 0xFF frame sync). Only re-read
    // suspiciously small files so we never touch real audio.
    if (read < 1024) {
      const head = readFileSync(dest);
      if (head[0] === 0x7b /* { */ || head[0] === 0x3c /* < */) {
        throw new NonAudioResponseError(
          `navidrome returned a ${read}-byte non-audio response: ${subsonicErrorMessage(head.toString('utf8'))}`,
        );
      }
    }
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
