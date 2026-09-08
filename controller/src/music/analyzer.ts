// Acoustic-analysis client. Two backends in priority order: the analysis
// sidecar (POST /analyze, base URL from config.analyzer.urls), then a local
// Python venv running scripts/analyze_worker.py over stdio. Neither available
// → isAvailable() is false and every analysis column stays NULL.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import * as subsonic from './subsonic.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { envInt } from '../util/env.js';

// A structural span over the track, in ms. Contiguous over the analysed
// window; the first is the intro/leading section.
export interface Section {
  startMs: number;
  endMs: number;
  kind?: string;
}

// A 0..1 perceptual-energy value over a span.
export interface PaceSpan {
  startMs: number;
  endMs: number;
  value: number;
}

// Tonic note (spelled with sharps) + mode over a time range.
export interface KeyRange {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: 'major' | 'minor';
}

// A null optional field means the backend did not compute it; every consumer
// must read null as "no signal, behave as today", which is what keeps a lean
// backend byte-identical.
export interface AnalysisResult {
  bpm: number | null;
  musicalKey: string | null;
  introMs: number | null;
  confidence: number | null;
  // Structural sections over the analysed window (the outro is beyond it).
  sections: Section[] | null;
  // Demucs vocal-presence ranges. [] means "analysed, instrumental" and is NOT
  // the same as null (not computed).
  vocalRanges: Section[] | null;
  // Perceptual energy/momentum curve (decoupled from BPM), 0..1 per span.
  paceCurve: PaceSpan[] | null;
  // Beat and downbeat (bar) timestamps in ms.
  beats: number[] | null;
  bars: number[] | null;
  // Per-region key; the scalar musicalKey stays the back-compat dominant key.
  keyRanges: KeyRange[] | null;
  // Integrated loudness (LUFS, BS.1770) + peak (dBFS); needs pyloudnorm. null
  // reads as "play at unity gain".
  loudnessLufs: number | null;
  peakDb: number | null;
  // CLAP audio embedding (512 floats); needs the model loaded.
  audioEmbedding: number[] | null;
  // Tail features, measured off the END of a COMPLETE file only.
  outro: OutroInfo | null;
  // true when head stems were written to the requested stems_dir. null = none
  // requested / backend predates the feature.
  stemsCached: boolean | null;
  // Dead-air gaps at the file's edges (ms), measured against an ABSOLUTE dBFS
  // floor — never the relative gates behind introMs / outro.startMs, which ask
  // where the MUSIC starts and would read a quiet intro as silence. The tail is
  // null unless the file was proven complete.
  leadSilenceMs: number | null;
  tailSilenceMs: number | null;
  // Where the trailing gap opens, absolute ms from byte zero, so the controller
  // never reconstructs it as (tagged duration - gap); tag and decoded file
  // disagree often enough to move the cut. null whenever tailSilenceMs is.
  tailStartMs: number | null;
}

// The outgoing track's measured ending. Timestamps are absolute ms.
export interface OutroInfo {
  startMs: number;             // where the wind-down starts
  ending: 'fade' | 'cold';     // fades to silence vs ends at level
  lufs: number | null;         // integrated loudness of the tail (BS.1770)
  bpm: number | null;          // tail tempo (outros drift/ritard vs the lead)
  beats: number[] | null;
  bars: number[] | null;
  // Tail vocal spans. [] = analysed instrumental tail; the key must be OMITTED
  // (not null) when detection didn't run — outro_json is the JSON.stringify of
  // this object and the vocal backfill probes the raw text for '"vocalRanges"'.
  vocalRanges?: Section[];
}

function parseFinite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Non-negative whole ms, or null. A negative/non-finite value is a broken
// measurement, not a zero-length gap, so it reads as "trim nothing".
function parseSilenceMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
}

// Drops malformed/zero-length spans.
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

// Empty collapses to null ("no structure").
function parseSections(v: unknown): Section[] | null {
  if (!Array.isArray(v)) return null;
  const out = coerceSpans(v);
  return out.length ? out : null;
}

// Preserves an empty array: [] (analysed instrumental) is distinct from null.
function parseVocalRanges(v: unknown): Section[] | null {
  if (!Array.isArray(v)) return null;
  return coerceSpans(v);
}

// Drops malformed spans, empty → null.
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

// ms timestamps → finite number[], empty → null.
function parseMsList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
  return out.length ? out : null;
}

// Drops malformed spans, empty → null.
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

// startMs + a valid ending are required; everything else is optional.
function parseOutro(v: unknown): OutroInfo | null {
  const o = v as Record<string, unknown>;
  const startMs = parseFinite(o?.startMs);
  const ending = o?.ending;
  if (startMs == null || startMs < 0 || (ending !== 'fade' && ending !== 'cold')) return null;
  // Omit the key when not computed, so outro_json never carries a bare
  // "vocalRanges" for the backfill probe.
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

// Clean number[] or null — a malformed array must not reach
// upsertTrackAudioVector.
function parseAudioEmbedding(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    out.push(x);
  }
  return out;
}

// Mirrors ANALYZE_MAX_BYTES in the Python worker so both fetch paths read the
// same envelope. Via envInt, never parseInt: a NaN disables the cap and flags
// every download incomplete (#1549).
const ANALYZE_MAX_BYTES = envInt('ANALYZE_MAX_BYTES', 12 * 1024 * 1024, { min: 1 });
// Staging dir for pre-fetched audio, under the shared state dir so the path the
// controller writes resolves to the same file inside the sidecar.
const ANALYZE_TMP_DIR = `${config.stateRoot}/analyze-tmp`;

function localConfigured(): boolean {
  const { python, workerScript } = config.analyzer;
  return !!python && existsSync(python) && existsSync(workerScript);
}

// A line of JSON from the stdio worker, or the sidecar's /analyze body — same
// payload; ready/fatal/id are worker-only.
interface WorkerMessage {
  id?: string;
  ok?: boolean;
  ready?: boolean;
  fatal?: boolean;
  error?: string;
  // Ready-line capability flags (find_spec probes, no model load); the sidecar
  // surfaces the same fields via /health.
  audio_embedding_capable?: boolean;
  vocal_activity_capable?: boolean;
  tail_vocal_capable?: boolean;
  text_embedding_capable?: boolean;
  // Capabilities advertised at ready but lost when the model was asked to load.
  // Rides on EVERY message: the failure it exists for answers ok=true with the
  // field absent.
  capability_loss?: Record<string, string>;
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
  lead_silence_ms?: unknown;
  tail_silence_ms?: unknown;
  tail_start_ms?: unknown;
  stems_cached?: boolean;
  text_embeddings?: unknown;
  // render_transition op fields
  path?: string;
  blend_start_sec?: number;
  in_cue_sec?: number;
  clip_sec?: number;
}

type Pending = { resolve: (m: WorkerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

let proc: ChildProcessWithoutNullStreams | null = null;
let ready = false;
let booting: Promise<void> | null = null;
let buffer = '';
let reqSeq = 0;
const pending = new Map<string, Pending>();

// Local-backend capability flags, mirroring the sidecar's /health fields. Set
// from the worker's ready line (authoritative) or the one-shot find_spec probe
// below. null = not yet known.
let _localAudioCapable: boolean | null = null;
let _localVocalCapable: boolean | null = null;
let _localTailVocalCapable: boolean | null = null;
let _localTextCapable: boolean | null = null;
// Local twins of _sidecarAudioError / _sidecarVocalError — see there.
let _localAudioError: string | null = null;
let _localVocalError: string | null = null;

// A reported failure beats the ready line's find_spec probe, and is applied
// downward only.
function noteLocalCapabilityLoss(msg: WorkerMessage): void {
  const lost = msg.capability_loss;
  if (!lost || typeof lost !== 'object') return;
  if (typeof lost.audio_embedding === 'string') {
    if (_localAudioError !== lost.audio_embedding) {
      console.error(`[analyze] audio embeddings unavailable: ${lost.audio_embedding}`);
    }
    _localAudioError = lost.audio_embedding;
    _localAudioCapable = false;
    // The text tower rides CLAP's load, so it goes down with it.
    _localTextCapable = false;
  }
  if (typeof lost.vocal_activity === 'string') {
    if (_localVocalError !== lost.vocal_activity) {
      console.error(`[analyze] vocal activity unavailable: ${lost.vocal_activity}`);
    }
    _localVocalError = lost.vocal_activity;
    _localVocalCapable = false;
    // Tail ranges are the same Demucs separation over the outro window.
    _localTailVocalCapable = false;
  }
}

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
          // The ready line overwrites, except where a model was already seen
          // failing to load: a respawned worker announces a clean find_spec
          // probe, and raising the flag back to true re-widens the backfill to
          // the same doomed track set every pass.
          if (typeof msg.audio_embedding_capable === 'boolean' && _localAudioError === null) _localAudioCapable = msg.audio_embedding_capable;
          if (typeof msg.vocal_activity_capable === 'boolean' && _localVocalError === null) _localVocalCapable = msg.vocal_activity_capable;
          if (typeof msg.tail_vocal_capable === 'boolean' && _localVocalError === null) _localTailVocalCapable = msg.tail_vocal_capable;
          if (typeof msg.text_embedding_capable === 'boolean' && _localAudioError === null) _localTextCapable = msg.text_embedding_capable;
        }
        // After the ready assignments, so a reported loss always wins.
        noteLocalCapabilityLoss(msg);
        if (msg.ready) {
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

// Per-request analysis options. Snake-cased keys are wire-named: both backends
// spread opts verbatim into the worker request.
export interface AnalyzeRequestOpts {
  // Force a lazy CLAP load even when the backend's env doesn't enable it.
  // Omitted → the backend's env-driven default.
  embed?: boolean;
  // Same, for a lazy Demucs load for vocal-activity ranges.
  vocal?: boolean;
  // Whether the handed-over `path` holds the COMPLETE file; false vetoes outro
  // analysis. Omitted on the url path: the backend's own fetch decides.
  complete?: boolean;
  // Stem-cache target dir on the shared volume; implies the Demucs separation
  // even without `vocal`.
  stems_dir?: string;
  // Baseline analysis is already current; compute only the CLAP vector.
  embedding_only?: boolean;
}

// Carries either `url` (worker downloads) or `path` (already-local).
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
          leadSilenceMs: parseSilenceMs(msg.lead_silence_ms),
          tailSilenceMs: parseSilenceMs(msg.tail_silence_ms),
          tailStartMs: parseSilenceMs(msg.tail_start_ms),
          stemsCached: typeof msg.stems_cached === 'boolean' ? msg.stems_cached : null,
        }),
      reject,
      timer,
    });
    proc?.stdin.write(JSON.stringify({ id, ...req }) + '\n');
  });
}

// The same find_spec checks the worker runs before its ready line (keep the
// module lists in sync with analyze_worker.py), in a throwaway `python -c` so
// the doctor can answer without booting the resident worker. Fills only
// still-null flags: a booted worker's ready line is authoritative.
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
        // The worker ships with the controller, so tail-vocal is version-matched
        // to vocal.
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

// Last sidecar /health read of each capability. null = unknown (not yet probed,
// or the field is absent on an old sidecar).
let _sidecarAudioCapable: boolean | null = null;
let _sidecarVocalCapable: boolean | null = null;
// Tail vocal ranges. Doubles as a worker-version signal: sidecars predating the
// feature never emit the field, so this stays null and the backfill widening
// (which requires === true) can't churn.
let _sidecarTailVocalCapable: boolean | null = null;
// The CLAP TEXT tower (embed-text).
let _sidecarTextCapable: boolean | null = null;
// Why a capability is false, when the cause is a failed model load rather than
// a lean build. Sourced from /health only: the sidecar remembers the failure
// across its idle worker respawn, so a second write path could only disagree.
let _sidecarAudioError: string | null = null;
let _sidecarVocalError: string | null = null;
// Base URL that last reported the 'analyze' engine — what sidecarRequest POSTs
// to. Set by sidecarReachable; '' until a probe succeeds.
let _sidecarBase = '';

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
      analyze_audio_error?: string | null;
      analyze_vocal_error?: string | null;
    };
    const reachable = !!body.ok && Array.isArray(body.engines) && body.engines.includes('analyze');
    if (reachable) {
      _sidecarBase = url;
      _sidecarAudioCapable = typeof body.analyze_audio_capable === 'boolean' ? body.analyze_audio_capable : null;
      _sidecarVocalCapable = typeof body.analyze_vocal_capable === 'boolean' ? body.analyze_vocal_capable : null;
      _sidecarTailVocalCapable = typeof body.analyze_tail_vocal_capable === 'boolean' ? body.analyze_tail_vocal_capable : null;
      _sidecarTextCapable = typeof body.analyze_text_capable === 'boolean' ? body.analyze_text_capable : null;
      _sidecarAudioError = typeof body.analyze_audio_error === 'string' ? body.analyze_audio_error : null;
      _sidecarVocalError = typeof body.analyze_vocal_error === 'string' ? body.analyze_vocal_error : null;
    }
    return reachable;
  } catch {
    return false;
  }
}

// Stop at the first configured candidate advertising the 'analyze' engine.
async function sidecarReachable(): Promise<boolean> {
  for (const url of config.analyzer.urls) {
    if (await probeSidecar(url)) return true;
  }
  return false;
}

class AnalyzerPathUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzerPathUnavailableError';
  }
}

async function sidecarFailure(res: Response): Promise<never> {
  const raw = await res.text().catch(() => '');
  let detail: unknown = null;
  try {
    detail = JSON.parse(raw)?.detail;
  } catch {
    // Non-JSON responses retain the previous status + raw-body error shape.
  }
  if (
    res.status === 422
    && detail != null
    && typeof detail === 'object'
    && (detail as Record<string, unknown>).code === 'path_unavailable'
  ) {
    const message = (detail as Record<string, unknown>).message;
    throw new AnalyzerPathUnavailableError(
      typeof message === 'string' ? message : 'analyzer cannot read controller path',
    );
  }
  const message = typeof detail === 'string' ? detail : raw;
  throw new Error(`analyze sidecar ${res.status}: ${message}`);
}

async function sidecarRequest(body: ({ url: string } | { path: string }) & AnalyzeRequestOpts): Promise<AnalysisResult> {
  const base = _sidecarBase;
  const res = await fetchWithTimeout(`${base}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: config.analyzer.requestTimeoutMs,
    bodyDeadline: true,
  });
  if (!res.ok) return sidecarFailure(res);
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
    leadSilenceMs: parseSilenceMs(resBody.lead_silence_ms),
    tailSilenceMs: parseSilenceMs(resBody.tail_silence_ms),
    tailStartMs: parseSilenceMs(resBody.tail_start_ms),
    stemsCached: typeof resBody.stems_cached === 'boolean' ? resBody.stems_cached : null,
  };
}

function analyzeViaSidecar(url: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  return sidecarRequest({ url, ...opts });
}

function analyzeViaSidecarPath(path: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  return sidecarRequest({ path, ...opts });
}

let _backend: 'sidecar' | 'local' | null = null;
// When the last MISS was resolved, or 0 for "never asked".
let _missAt = 0;

// Sidecar advertising 'analyze', else a configured local venv, else none. A HIT
// is cached for the process lifetime, a MISS only for
// config.analyzer.missProbeIntervalMs: an unreachable host costs a 5s probe per
// candidate per call, but the analyzer container may come up after the controller.
export async function resolveBackend(): Promise<'sidecar' | 'local' | null> {
  if (_backend) return _backend;
  if (_missAt && Date.now() - _missAt < config.analyzer.missProbeIntervalMs) return null;
  if (await sidecarReachable()) { _backend = 'sidecar'; return _backend; }
  if (localConfigured()) { _backend = 'local'; return _backend; }
  _missAt = Date.now();
  return null;
}

// Forget a cached miss so the next resolveBackend() probes again. For tests and
// operator actions that could have just started a backend — never a read path.
export function _resetBackendCacheForTests(): void {
  _backend = null;
  _missAt = 0;
}

export async function isAvailable(): Promise<boolean> {
  return (await resolveBackend()) !== null;
}

export function backendLabel(): string {
  return _backend || 'none';
}

// null = unknown (not yet probed); false = built without the CLAP stack, which
// the admin UI turns into a "switch to the heavy image" warning.
export function audioEmbeddingAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarAudioCapable;
  if (_backend === 'local') return _localAudioCapable;
  return null;
}

// Demucs vocal-activity ranges. Same semantics as audioEmbeddingAvailable.
export function vocalActivityAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarVocalCapable;
  if (_backend === 'local') return _localVocalCapable;
  return null;
}

// Why the CLAP capability is false, when the cause is a model that failed to
// load rather than an image built without it (null in every other case).
export function audioEmbeddingError(): string | null {
  if (_backend === 'sidecar') return _sidecarAudioError;
  if (_backend === 'local') return _localAudioError;
  return null;
}

// Demucs twin of audioEmbeddingError.
export function vocalActivityError(): string | null {
  if (_backend === 'sidecar') return _sidecarVocalError;
  if (_backend === 'local') return _localVocalError;
  return null;
}

// Backends predating the feature never report it, so consumers must treat only
// `=== true` as capable.
export function tailVocalAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarTailVocalCapable;
  if (_backend === 'local') return _localTailVocalCapable;
  return null;
}

// Re-read capability under a long-lived controller: the sidecar can be rebuilt
// with WITH_CLAP=1 while the controller stays up.
export async function refreshCapabilities(): Promise<void> {
  const backend = await resolveBackend();
  if (backend === 'sidecar') { await sidecarReachable(); return; }
  if (backend === 'local' && !ready) await probeLocalCapabilities();
}

// The CLAP text tower. Same semantics as audioEmbeddingAvailable.
export function textEmbeddingAvailable(): boolean | null {
  if (_backend === 'sidecar') return _sidecarTextCapable;
  if (_backend === 'local') return _localTextCapable;
  return null;
}

// One finite-valued vector per input text, all the same length. Anything less
// is "no text embedding this pass" — callers degrade, never throw.
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

// A deadline that expired mid-request, as opposed to a refused connection or a
// capability 404/500.
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  const message = (err as { message?: unknown } | null)?.message;
  return name === 'AbortError' || (typeof message === 'string' && message.includes('timed out'));
}

// Embed texts through the CLAP text tower — 512-d L2-normalised vectors in the
// same space as stored track audio vectors, so cosine against them is
// meaningful. Returns null whenever the capability is absent; callers degrade,
// never throw. One retry on TIMEOUT only, since with the idle model release
// (#1204) a call can land on a cold worker whose CLAP reload eats the deadline;
// bulk callers pass `coldRetry: false`.
export async function embedTexts(
  texts: string[],
  opts: { timeoutMs?: number; coldRetry?: boolean } = {},
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const timeoutMs = opts.timeoutMs ?? config.analyzer.requestTimeoutMs;
  const backend = await resolveBackend();
  if (!backend) return null;
  if (backend === 'sidecar' && _sidecarTextCapable === false) return null;
  const attempt = async (): Promise<number[][] | null> => {
    if (backend === 'sidecar') {
      const res = await fetchWithTimeout(`${_sidecarBase}/embed-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        timeoutMs,
        bodyDeadline: true,
      });
      // 404 = pre-text-tower sidecar, 500 = lean build; both mean "no text
      // embeddings", not an error worth surfacing per call.
      if (!res.ok) return null;
      const body = (await res.json()) as { ok?: boolean; embeddings?: unknown };
      return body?.ok ? parseVectors(body.embeddings, texts.length) : null;
    }
    if (!ready) await startWorker();
    return await localEmbedTexts(texts, timeoutMs);
  };
  try {
    return await attempt();
  } catch (err) {
    if (opts.coldRetry === false || !isTimeoutError(err)) return null;
    try {
      return await attempt();
    } catch {
      return null;
    }
  }
}

// What the stem-blend render op needs to align and mix — straight from
// library.db, the worker never re-detects. Wire-shaped (snake keys pass through
// verbatim). `gain_db` is the dB the station itself would apply to that side
// (music/loudness.ts) and is what the worker mixes with; `lufs` is the
// pre-#1240 input, kept so an older analyzer image still renders.
export interface RenderTransitionPayload {
  out: {
    stems_dir: string;
    duration_s: number; // tagged duration, advisory — tail alignment comes from the stems' tail-meta.json
    outro: { start_ms: number; bars: number[]; lufs?: number | null };
    gain_db?: number | null;
    lufs?: number | null;
  };
  in: {
    stems_dir: string;
    bars: number[];
    gain_db?: number | null;
    lufs?: number | null;
  };
  out_dir: string;
  clip_name: string;
  target_lufs?: number | null;
}

export interface RenderTransitionResult {
  path: string;
  blendStartSec: number; // absolute in the OUTGOING track — its liq_cue_out
  inCueSec: number;      // absolute in the INCOMING track — its liq_cue_in
  clipSec: number;
}

// Mix a pre-rendered transition WAV from two tracks' cached stems. Returns null
// on ANY miss or failure — the caller falls back to a plain pair-aware
// crossfade. Needs only numpy+soundfile, so it works on the lean image as long
// as a heavy backend cached the stems earlier.
export async function renderTransition(
  payload: RenderTransitionPayload,
  opts: { timeoutMs?: number } = {},
): Promise<RenderTransitionResult | null> {
  const timeoutMs = opts.timeoutMs ?? config.analyzer.renderTimeoutMs;
  const backend = await resolveBackend();
  if (!backend) return null;
  if (backend === 'sidecar') {
    try {
      const res = await fetchWithTimeout(`${_sidecarBase}/render-transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs,
        bodyDeadline: true,
      });
      if (!res.ok) return null; // 404 = pre-render sidecar — silently no blend
      const body = (await res.json()) as WorkerMessage & { ok?: boolean };
      return coerceRenderResult(body);
    } catch {
      return null;
    }
  }
  try {
    if (!ready) await startWorker();
    return await localRenderTransition(payload, timeoutMs);
  } catch {
    return null;
  }
}

function coerceRenderResult(msg: WorkerMessage & { ok?: boolean }): RenderTransitionResult | null {
  if (!msg?.ok || typeof msg.path !== 'string') return null;
  const blendStartSec = parseFinite(msg.blend_start_sec);
  const inCueSec = parseFinite(msg.in_cue_sec);
  const clipSec = parseFinite(msg.clip_sec);
  if (blendStartSec == null || inCueSec == null || clipSec == null) return null;
  return { path: msg.path, blendStartSec, inCueSec, clipSec };
}

function localRenderTransition(payload: RenderTransitionPayload, timeoutMs: number): Promise<RenderTransitionResult | null> {
  const id = `a${++reqSeq}`;
  return new Promise<RenderTransitionResult | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('render-transition request timed out'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg: WorkerMessage) => resolve(coerceRenderResult({ ...msg, ok: true })),
      reject, // a worker {ok:false} rejects here — caller maps to null
      timer,
    });
    proc?.stdin.write(JSON.stringify({ id, op: 'render_transition', ...payload }) + '\n');
  });
}

// Analyse one track by id over the URL path (the backend fetches the audio).
// Throws on failure — the caller leaves the row NULL and retries next run.
export async function analyze(songId: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  const backend = await resolveBackend();
  if (!backend) throw new Error('no analysis backend available');
  const url = subsonic.getRawStreamUrl(songId);
  return backend === 'sidecar' ? analyzeViaSidecar(url, opts) : analyzeViaLocal(url, opts);
}

// Navidrome answers a request for a file missing on disk with an HTTP 200
// Subsonic error envelope, not audio. Typed so the analysis loop can tell it
// apart from a transient network failure and skip the url retry.
export class NonAudioResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonAudioResponseError';
  }
}

// The human-readable message out of a Subsonic error envelope (JSON or the XML
// attribute form), else a trimmed snippet.
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

// Download a track's audio to a capped temp file on the shared state volume,
// ahead of the backend's compute so the fetch overlaps its DSP. `complete` is
// false when the cap truncated the file, which vetoes outro analysis. Throws on
// any error; the caller falls back to the url path for that one track.
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
    // Catch the HTTP 200 Subsonic error envelope on content type; streamed to
    // disk as `.audio` it fails opaquely in the decoder instead.
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('json') || contentType.includes('xml') || contentType.startsWith('text/')) {
      const body = await res.text().catch(() => '');
      throw new NonAudioResponseError(
        `navidrome returned ${contentType || 'a non-audio response'}, not audio: ${subsonicErrorMessage(body)}`,
      );
    }
    // Must stay a capped async generator feeding pipeline: a `data` listener
    // alongside pipeline flips the web-backed Readable into flowing mode and
    // deadlocks every download.
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
    // Backstop for the content-type guard: an envelope that slipped past the
    // headers is tiny and starts with '{' or '<'; real audio never does.
    if (read < 1024) {
      const head = readFileSync(dest);
      if (head[0] === 0x7b /* { */ || head[0] === 0x3c /* < */) {
        throw new NonAudioResponseError(
          `navidrome returned a ${read}-byte non-audio response: ${subsonicErrorMessage(head.toString('utf8'))}`,
        );
      }
    }
    // A read that hit the cap stopped early, so the tail is missing. Exactly
    // cap bytes counts as incomplete too: that only skips outro analysis,
    // never mis-measures it.
    return { path: dest, complete: read < ANALYZE_MAX_BYTES };
  } catch (err) {
    // Drop the staging file on every failure: createWriteStream truncates
    // `dest` into existence, and only the success path hands a path back for
    // the caller to clean up. Best-effort, so a failed cleanup cannot replace
    // the real error.
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// Analyse from an already-local file on the shared volume (downloadCapped), so
// the backend skips its own fetch.
export async function analyzePath(localPath: string, opts: AnalyzeRequestOpts = {}): Promise<AnalysisResult> {
  const backend = await resolveBackend();
  if (!backend) throw new Error('no analysis backend available');
  return backend === 'sidecar' ? analyzeViaSidecarPath(localPath, opts) : analyzeViaLocalPath(localPath, opts);
}

let pathFallbackWarned = false;

// Prefer the shared-path handoff, degrading a sidecar that cannot see the
// controller's state mount to the URL input. Only the machine-readable
// path-unavailable response earns the retry; a decode/model failure must not be
// doubled. `complete` and `stems_dir` are dropped: neither is valid when the
// sidecar downloads its own copy.
export async function analyzePathWithUrlFallback(
  songId: string,
  localPath: string,
  opts: AnalyzeRequestOpts = {},
): Promise<AnalysisResult> {
  try {
    return await analyzePath(localPath, opts);
  } catch (err) {
    if (!(err instanceof AnalyzerPathUnavailableError)) throw err;
    if (!pathFallbackWarned) {
      pathFallbackWarned = true;
      console.error(
        '[analyze] analyzer cannot read controller staging paths; using URL downloads ' +
        '(slower, and stem caching still requires shared state)',
      );
    }
    const urlOpts = { ...opts };
    delete urlOpts.complete;
    delete urlOpts.stems_dir;
    return analyze(songId, urlOpts);
  }
}

export function shutdown(): void {
  try { proc?.stdin.end(); } catch { /* ignore */ }
  try { proc?.kill(); } catch { /* ignore */ }
  proc = null; ready = false; booting = null;
}
