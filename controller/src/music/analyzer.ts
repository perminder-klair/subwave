// Acoustic-analysis client — resolves bpm / key / intro for a track id by
// running librosa, which deliberately does NOT live in the controller image.
//
// Two backends, in priority order:
//   1. analysis sidecar — POST {url} to its /analyze endpoint (production).
//      The base URL is config.analyzer.urls: the default-on `subwave-analyzer`
//      image (ANALYZE_URL; `subwave-analyzer-heavy` for CLAP/Demucs). tts-heavy
//      is TTS-only now and no longer carries the analyzer.
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
import { fetchWithTimeout } from '../util/fetch-timeout.js';

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
  // Outro (tail) features — measured off the END of a COMPLETE file. null when
  // not computed (truncated download, short track, decode failure); consumers
  // treat null as "no outro signal, behave as today".
  outro: OutroInfo | null;
  // Stem-cache outcome — true when the head stems were written to the
  // requested stems_dir (tail rides along when the outro was computable).
  // null = no stems_dir requested / backend predates the feature.
  stemsCached: boolean | null;
}

// The outgoing track's measured ending — what actually decides whether a
// transition lands. Timestamps are absolute ms into the track.
export interface OutroInfo {
  startMs: number;             // where the wind-down starts
  ending: 'fade' | 'cold';     // fades to silence vs ends at level
  lufs: number | null;         // integrated loudness of the tail (BS.1770)
  bpm: number | null;          // tail tempo (outros drift/ritard vs the lead)
  beats: number[] | null;      // tail beat grid, absolute ms
  bars: number[] | null;       // tail downbeat (bar) grid, absolute ms
  // Tail vocal-activity spans (Demucs over the outro window), absolute ms.
  // [] = analysed instrumental tail (meaningful); ABSENT = not computed —
  // the key must be omitted (not null) when detection didn't run, because
  // outro_json is the JSON.stringify of this object and the vocal backfill
  // probes the raw text for '"vocalRanges"' to find tail-missing tracks.
  vocalRanges?: Section[];
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
  for (const s of v as Record<string, unknown>[]) {
    const startMs = parseFinite(s?.startMs);
    const endMs = parseFinite(s?.endMs);
    if (startMs == null || endMs == null || endMs <= startMs) continue;
    const kind = typeof s?.kind === 'string' ? s.kind : undefined;
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
  for (const s of v as Record<string, unknown>[]) {
    const startMs = parseFinite(s?.startMs);
    const endMs = parseFinite(s?.endMs);
    const tonic = s?.tonic;
    const mode = s?.mode;
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
  for (const s of v as Record<string, unknown>[]) {
    const startMs = parseFinite(s?.startMs);
    const endMs = parseFinite(s?.endMs);
    const value = parseFinite(s?.value);
    if (startMs == null || endMs == null || value == null || endMs <= startMs) continue;
    out.push({ startMs, endMs, value });
  }
  return out.length ? out : null;
}

// Coerce the worker's outro object to a clean OutroInfo or null. The worker
// omits it entirely when not computed; startMs + a valid ending are the
// required core, everything else is optional garnish.
function parseOutro(v: unknown): OutroInfo | null {
  const o = v as Record<string, unknown>;
  const startMs = parseFinite(o?.startMs);
  const ending = o?.ending;
  if (startMs == null || startMs < 0 || (ending !== 'fade' && ending !== 'cold')) return null;
  // Same []-vs-absent distinction as the head ranges: preserve a present-but-
  // empty array (analysed instrumental tail); OMIT the key when the worker
  // didn't compute it, so the stringified outro_json never carries a bare
  // "vocalRanges" key for the backfill probe to misread.
  const vocalRanges = parseVocalRanges(o?.vocalRanges);
  return {
    startMs: Math.round(startMs),
    ending,
    lufs: parseFinite(o?.lufs),
    bpm: parseFinite(o?.bpm),
    beats: parseMsList(o?.beats),
    bars: parseMsList(o?.bars),
    ...(vocalRanges !== null ? { vocalRanges } : {}),
  };
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

// A line of JSON from the stdio worker (or the equivalent sidecar /analyze
// response body — same analyze payload). Protocol fields (ready/fatal/id) are
// worker-only; the analyze fields are shared. Everything the parse* helpers
// consume is `unknown` so they own the coercion; the couple of directly-read
// scalars are pre-typed. Loose because the payload evolves with the worker.
interface WorkerMessage {
  id?: string;
  ok?: boolean;
  ready?: boolean;
  fatal?: boolean;
  error?: string;
  // Capability flags the worker reports on its ready line (find_spec probes —
  // no model load). The sidecar surfaces the same fields via /health.
  audio_embedding_capable?: boolean;
  vocal_activity_capable?: boolean;
  tail_vocal_capable?: boolean;
  text_embedding_capable?: boolean;
  bpm?: number | null;
  key?: string | null;
  intro_ms?: number | null;
  confidence?: number | null;
  loudness_lufs?: unknown;
  peak_db?: unknown;
  sections?: unknown;
  vocal_ranges?: unknown;
  pace_curve?: unknown;
  beats?: unknown;
  bars?: unknown;
  key_ranges?: unknown;
  audio_embedding?: unknown;
  outro?: unknown;
  stems_cached?: boolean;
  text_embeddings?: unknown;
}

type Pending = { resolve: (m: WorkerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let proc: ChildProcessWithoutNullStreams | null = null;
let ready = false;
let booting: Promise<void> | null = null;
let buffer = '';
let reqSeq = 0;
const pending = new Map<string, Pending>();

// Local-backend capability flags, mirroring the sidecar's /health fields. Set
// from the worker's ready line when it boots (authoritative — includes hard
// load failures), or by the one-shot find_spec probe below when the doctor asks
// before any analysis has run. null = not yet known. Without this the AIO image
// (local backend) could never answer "can you do CLAP?" and the doctor guessed
// — issue #966's false "you're on the lean image" warning on subwave-aio-heavy.
let _localAudioCapable: boolean | null = null;
let _localVocalCapable: boolean | null = null;
let _localTailVocalCapable: boolean | null = null;
let _localTextCapable: boolean | null = null;

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
        let msg: WorkerMessage;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) {
          ready = true;
          // The ready line knows about hard load failures the find_spec probe
          // can't see, so it always overwrites.
          if (typeof msg.audio_embedding_capable === 'boolean') _localAudioCapable = msg.audio_embedding_capable;
          if (typeof msg.vocal_activity_capable === 'boolean') _localVocalCapable = msg.vocal_activity_capable;
          if (typeof msg.tail_vocal_capable === 'boolean') _localTailVocalCapable = msg.tail_vocal_capable;
          if (typeof msg.text_embedding_capable === 'boolean') _localTextCapable = msg.text_embedding_capable;
          clearTimeout(readyTimer);
          resolve();
          continue;
        }
        if (msg.fatal) { clearTimeout(readyTimer); reject(new Error(msg.error || 'analyze worker fatal')); continue; }
        const waiter = pending.get(msg.id!);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        pending.delete(msg.id!);
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
  // Whether the handed-over `path` holds the COMPLETE file (downloadCapped
  // knows). false vetoes outro analysis — a truncated file's "tail" is
  // mid-song audio. Omitted on the url path: the backend's own fetch decides.
  complete?: boolean;
  // Stem-cache target dir (feature: stem-blend transitions) — wire-named:
  // both backends spread opts verbatim into the worker request. When set the
  // worker persists its Demucs stems (head + tail) as FLAC into this dir on
  // the shared volume; implies the separation even without `vocal`.
  stems_dir?: string;
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
      resolve: (msg: WorkerMessage) =>
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
          outro: parseOutro(msg.outro),
          stemsCached: typeof msg.stems_cached === 'boolean' ? msg.stems_cached : null,
        }),
      reject,
      timer,
    });
    proc?.stdin.write(JSON.stringify({ id, ...req }) + '\n');
  });
}

// One-shot capability probe for the local backend — the same find_spec checks
// the worker runs before its ready line (keep the module lists in sync with
// analyze_worker.py), in a throwaway `python -c` so the doctor can get a
// definitive answer without booting the persistent worker (which imports
// librosa and stays resident). Fills only still-null flags: a booted worker's
// ready line is authoritative and must not be overwritten by a fresh process
// that can't know about hard load failures.
const LOCAL_CAPABILITY_PROBE = [
  'import importlib.util as u, json',
  'h = lambda *m: all(u.find_spec(x) is not None for x in m)',
  'print(json.dumps({"audio": h("torch", "transformers"), "vocal": h("torch", "demucs"), "text": h("torch", "transformers")}))',
].join('\n');

let _localProbe: Promise<void> | null = null;

function probeLocalCapabilities(): Promise<void> {
  if (_localProbe) return _localProbe;
  _localProbe = new Promise<void>((resolve) => {
    let out = '';
    // Only reached when localConfigured() saw the python binary, so a spawn
    // failure surfaces as the 'error' event, not a sync throw.
    const p = spawn(config.analyzer.python, ['-c', LOCAL_CAPABILITY_PROBE], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill(), 15_000);
    p.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    p.on('error', () => { clearTimeout(timer); _localProbe = null; resolve(); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const caps = JSON.parse(out.trim()) as { audio?: boolean; vocal?: boolean; text?: boolean };
        if (_localAudioCapable === null && typeof caps.audio === 'boolean') _localAudioCapable = caps.audio;
        if (_localVocalCapable === null && typeof caps.vocal === 'boolean') _localVocalCapable = caps.vocal;
        // The local worker script ships with the controller (same repo/image),
        // so tail-vocal support is version-matched: capable iff vocal is.
        if (_localTailVocalCapable === null && typeof caps.vocal === 'boolean') _localTailVocalCapable = caps.vocal;
        if (_localTextCapable === null && typeof caps.text === 'boolean') _localTextCapable = caps.text;
      } catch {
        _localProbe = null; // bad/empty output — stay unknown, allow retry
      }
      resolve();
    });
  });
  return _localProbe;
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
// Same, for tail vocal ranges (outro.vocalRanges) — doubles as a worker-version
// signal: sidecars predating the feature never emit the field, so this stays
// null there and the backfill widening (which requires === true) can't churn.
let _sidecarTailVocalCapable: boolean | null = null;
// Same, for the CLAP TEXT tower (embed-text) — null until probed/absent field.
let _sidecarTextCapable: boolean | null = null;
// The candidate base URL that last reported the 'analyze' engine — the one
// sidecarRequest POSTs to. Set by sidecarReachable; '' until a probe succeeds.
let _sidecarBase = '';

// Probe one candidate /health for the 'analyze' engine. Records the capability
// flags + the winning base URL on success.
async function probeSidecar(url: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${url}/health`, { timeoutMs: 5000 });
    if (!res.ok) return false;
    const body = (await res.json()) as {
      ok?: boolean;
      engines?: string[];
      analyze_audio_capable?: boolean | null;
      analyze_vocal_capable?: boolean | null;
      analyze_tail_vocal_capable?: boolean | null;
      analyze_text_capable?: boolean | null;
    };
    const reachable = !!body.ok && Array.isArray(body.engines) && body.engines.includes('analyze');
    if (reachable) {
      _sidecarBase = url;
      _sidecarAudioCapable = typeof body.analyze_audio_capable === 'boolean' ? body.analyze_audio_capable : null;
      _sidecarVocalCapable = typeof body.analyze_vocal_capable === 'boolean' ? body.analyze_vocal_capable : null;
      _sidecarTailVocalCapable = typeof body.analyze_tail_vocal_capable === 'boolean' ? body.analyze_tail_vocal_capable : null;
      _sidecarTextCapable = typeof body.analyze_text_capable === 'boolean' ? body.analyze_text_capable : null;
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
  const res = await fetchWithTimeout(`${base}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: config.analyzer.requestTimeoutMs,
    bodyDeadline: true,
  });
  if (!res.ok) throw new Error(`analyze sidecar ${res.status}: ${await res.text().catch(() => '')}`);
  const resBody = (await res.json()) as WorkerMessage;
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
    outro: parseOutro(resBody.outro),
    stemsCached: typeof resBody.stems_cached === 'boolean' ? resBody.stems_cached : null,
  };
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
// now. null = unknown (backend not yet reached/probed); false = the backend is
// definitively built without the CLAP stack (sidecar WITH_CLAP=0, or a lean
// local/AIO venv) — the signal the admin UI turns into a "switch to the heavy
// image" warning. Sidecar answers come from /health; local answers from the
// worker's ready line or the find_spec probe (refreshCapabilities).
export function audioEmbeddingAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarAudioCapable;
  if (_backend === 'local') return _localAudioCapable;
  return null;
}

// Whether the active backend can emit Demucs vocal-activity ranges right now.
// Same semantics as audioEmbeddingAvailable: null = unknown; false = built
// without the demucs stack (sidecar WITH_DEMUCS=0, or a lean local/AIO venv).
export function vocalActivityAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarVocalCapable;
  if (_backend === 'local') return _localVocalCapable;
  return null;
}

// Whether the active backend computes TAIL vocal ranges (outro.vocalRanges).
// Doubles as a worker-version signal: backends predating the feature never
// report it, so consumers must treat only `=== true` as capable — the vocal
// backfill widening keys off exactly that, keeping stale sidecars churn-free.
export function tailVocalAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarTailVocalCapable;
  if (_backend === 'local') return _localTailVocalCapable;
  return null;
}

// Refresh capability so it reflects the backend actually running under a
// long-lived controller. Sidecar: re-read /health (the sidecar can be rebuilt
// with WITH_CLAP=1 while the controller stays up). Local: run the one-shot
// find_spec probe unless the persistent worker already reported its ready line
// (an image/venv swap restarts the whole AIO process, so probe-once is enough).
// Cheap; driven on the coverage staleness cadence + the doctor checks.
export async function refreshCapabilities(): Promise<void> {
  const backend = await resolveBackend();
  if (backend === 'sidecar') { await sidecarReachable(); return; }
  if (backend === 'local' && !ready) await probeLocalCapabilities();
}

// Whether the active backend can embed TEXT through the CLAP text tower (same
// semantics as audioEmbeddingAvailable: null = unknown, false = definitively
// can't — lean build or pre-text-tower image).
export function textEmbeddingAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarTextCapable;
  if (_backend === 'local') return _localTextCapable;
  return null;
}

// Coerce a worker text_embeddings payload to clean number[][] or null: one
// finite-valued vector per input text, all the same length. Anything less is
// treated as "no text embedding this pass" — callers degrade, never throw.
function parseVectors(v: unknown, expected: number): number[][] | null {
  if (!Array.isArray(v) || v.length !== expected) return null;
  const out: number[][] = [];
  for (const row of v) {
    const vec = parseAudioEmbedding(row);
    if (!vec || (out.length && vec.length !== out[0].length)) return null;
    out.push(vec);
  }
  return out;
}

// Write a {texts} request to the local stdio worker and resolve its vectors.
function localEmbedTexts(texts: string[], timeoutMs: number): Promise<number[][] | null> {
  const id = `a${++reqSeq}`;
  return new Promise<number[][] | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('embed-text request timed out'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg: WorkerMessage) => resolve(parseVectors(msg.text_embeddings, texts.length)),
      reject,
      timer,
    });
    proc?.stdin.write(JSON.stringify({ id, texts }) + '\n');
  });
}

// Embed a batch of texts through the CLAP TEXT tower — 512-d L2-normalised
// vectors in the SAME space as the stored track audio vectors, so cosine
// against them is meaningful (CLAP is contrastive audio–text). Used for
// natural-language "sounds like ..." search and zero-shot mood scoring.
// Returns null whenever the capability is absent (no backend, lean build, old
// sidecar without /embed-text, worker without torch) — callers degrade to
// their non-text behaviour, never throw. `timeoutMs` lets interactive callers
// (a picker tool mid-pick) use a shorter deadline than a bulk pass.
export async function embedTexts(
  texts: string[],
  opts: { timeoutMs?: number } = {},
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const timeoutMs = opts.timeoutMs ?? config.analyzer.requestTimeoutMs;
  const backend = await resolveBackend();
  if (!backend) return null;
  if (backend === 'sidecar') {
    if (_sidecarTextCapable === false) return null;
    try {
      const res = await fetchWithTimeout(`${_sidecarBase}/embed-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        timeoutMs,
        bodyDeadline: true,
      });
      // 404 = pre-text-tower sidecar, 500 = lean build (no torch) — both mean
      // "no text embeddings", not an error worth surfacing per call.
      if (!res.ok) return null;
      const body = (await res.json()) as { ok?: boolean; embeddings?: unknown };
      return body?.ok ? parseVectors(body.embeddings, texts.length) : null;
    } catch {
      return null;
    }
  }
  try {
    if (!ready) await startWorker();
    return await localEmbedTexts(texts, timeoutMs);
  } catch {
    return null;
  }
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
// and return {path, complete}. The controller does this AHEAD of the
// backend's compute so network fetch (controller) overlaps DSP (backend) —
// the path is valid in both containers because the shared dir mounts at the
// same location. Caps bytes + applies the analyzer request timeout; `complete`
// is false when the cap truncated the file (vetoes outro analysis — the
// file's "tail" would be mid-song audio). Throws on any error; the caller
// falls back to the url path for that one track.
export async function downloadCapped(
  songId: string,
): Promise<{ path: string; complete: boolean }> {
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
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
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
    // A read that hit the cap stopped early — the tail is missing. (A file of
    // exactly cap bytes is flagged incomplete too; erring that way only skips
    // outro analysis, never mis-measures it.)
    return { path: dest, complete: read < ANALYZE_MAX_BYTES };
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
