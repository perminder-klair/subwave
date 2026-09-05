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
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import * as subsonic from './subsonic.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { envInt } from '../util/env.js';

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
  // Dead-air gaps at the file's edges (ms), measured against an ABSOLUTE dBFS
  // floor — not the relative gates behind introMs / outro.startMs, which ask
  // where the MUSIC starts and stops and would read a quiet intro or a long
  // ring-out as silence. null = not measured (backend predates the feature,
  // the edge window was entirely silent so the gap outlasts it, or — for the
  // tail — the analysed file was not proven complete). Consumers treat null as
  // "no silence signal, trim nothing".
  leadSilenceMs: number | null;
  tailSilenceMs: number | null;
  // Where the trailing gap OPENS, absolute ms from byte zero. Same measurement
  // as tailSilenceMs, expressed as the cue point itself so the controller never
  // reconstructs it as (tagged duration - gap) — the tag and the decoded file
  // disagree often enough to move the cut. null whenever tailSilenceMs is.
  tailStartMs: number | null;
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

// Coerce an edge-silence field to a non-negative whole-ms count or null. A
// negative or non-finite value is a broken measurement, not a zero-length gap:
// null keeps the "no signal, trim nothing" path rather than stamping a cue
// point derived from nonsense.
function parseSilenceMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.round(v);
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
// fetch paths read the same envelope. Read through `envInt` (warn and fall
// back) rather than parseInt: a non-numeric value used to yield NaN, and both
// comparisons against NaN are false — the cap silently stopped applying AND
// every download was flagged incomplete, which turns outro analysis off
// library-wide with nothing logged (#1549).
const ANALYZE_MAX_BYTES = envInt('ANALYZE_MAX_BYTES', 12 * 1024 * 1024, { min: 1 });
// Where the controller stages pre-fetched audio. Lives under the shared
// state dir (mounted at the same /var/sub-wave path in both the controller and
// the tts-heavy sidecar), so the path string the controller writes resolves to
// the same file inside the sidecar — that's what makes the path handoff work.
const ANALYZE_TMP_DIR = `${config.stateRoot}/analyze-tmp`;

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
  // Capabilities the worker advertised at ready but LOST once the model was
  // actually asked to load — {audio_embedding?: why, vocal_activity?: why}.
  // Rides on EVERY message (analyze_worker.emit), because the failure mode it
  // exists for answers ok=true with the field merely absent.
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
// from the worker's ready line when it boots (authoritative — includes hard
// load failures), or by the one-shot find_spec probe below when the doctor asks
// before any analysis has run. null = not yet known. Without this the AIO image
// (local backend) could never answer "can you do CLAP?" and the doctor guessed
// — issue #966's false "you're on the lean image" warning on subwave-aio-heavy.
let _localAudioCapable: boolean | null = null;
let _localVocalCapable: boolean | null = null;
let _localTailVocalCapable: boolean | null = null;
let _localTextCapable: boolean | null = null;
// Local twins of _sidecarAudioError / _sidecarVocalError — see there.
let _localAudioError: string | null = null;
let _localVocalError: string | null = null;

// Apply a worker-reported capability loss to the local flags. The reported
// failure BEATS the ready line, which is a find_spec probe run before any model
// was asked to load: on the heavy image "torch is importable" is true and stays
// true no matter how the weight download goes. Downward only — a worker never
// gains a capability by failing at one.
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
          // The ready line knows about a pre-warm load failure the find_spec
          // probe can't see, so it overwrites — EXCEPT where we've already
          // watched the model fail to load. A worker that died and respawned
          // announces itself with a clean find_spec probe (its own
          // _embed_failed went with the process), and letting that raise the
          // flag back to true is the local twin of the sidecar's recycle bug:
          // the backfill re-widens to the same doomed track set every pass.
          if (typeof msg.audio_embedding_capable === 'boolean' && _localAudioError === null) _localAudioCapable = msg.audio_embedding_capable;
          if (typeof msg.vocal_activity_capable === 'boolean' && _localVocalError === null) _localVocalCapable = msg.vocal_activity_capable;
          if (typeof msg.tail_vocal_capable === 'boolean' && _localVocalError === null) _localTailVocalCapable = msg.tail_vocal_capable;
          if (typeof msg.text_embedding_capable === 'boolean' && _localAudioError === null) _localTextCapable = msg.text_embedding_capable;
        }
        // On EVERY message, the ready line included (a pre-warm failure is
        // reported there): a capability the worker has lost since it announced
        // itself. Applied after the ready assignments so the loss always wins.
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
  // The track's baseline analysis is already current; compute only its CLAP
  // vector. Wire-named because both backends receive the options verbatim.
  embedding_only?: boolean;
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
// WHY a capability is false, when the reason is a failed model LOAD rather than
// a lean build. Null for every other case, a lean image included — a lean image
// is a build choice, not a fault, and the two need opposite advice.
//
// Sourced from /health ONLY, unlike the local backend which reads it off the
// worker's own responses: the sidecar already remembers the failure across its
// idle worker respawn (server.py capability_errors), so /health is the single
// place that fact lives and a second write path here could only disagree with
// it. Cost is one probe cycle of latency — a failure that lands mid-pass is
// acted on by the NEXT pass, which is also when it could first matter.
let _sidecarAudioError: string | null = null;
let _sidecarVocalError: string | null = null;
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

// WHY the CLAP capability is false, when the cause is a model that failed to
// LOAD rather than an image built without it. null in every other case — a lean
// build is a choice, not a fault. This is the difference between "switch to the
// heavy image" and "this host can't reach huggingface.co", which a bare
// `capable: false` cannot express and which #1300 bug 3 shows people acting on.
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

// A deadline that expired mid-request, as opposed to a refused connection or a
// capability 404/500 (which fail fast and mean "not available", not "still
// working"). fetchWithTimeout aborts with a DOMException named 'AbortError';
// the local stdio path rejects with a "timed out" Error.
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  const message = (err as { message?: unknown } | null)?.message;
  return name === 'AbortError' || (typeof message === 'string' && message.includes('timed out'));
}

// Embed a batch of texts through the CLAP TEXT tower — 512-d L2-normalised
// vectors in the SAME space as the stored track audio vectors, so cosine
// against them is meaningful (CLAP is contrastive audio–text). Used for
// natural-language "sounds like ..." search and zero-shot mood scoring.
// Returns null whenever the capability is absent (no backend, lean build, old
// sidecar without /embed-text, worker without torch) — callers degrade to
// their non-text behaviour, never throw. `timeoutMs` lets interactive callers
// (a picker tool mid-pick) use a shorter deadline than a bulk pass.
//
// One retry on TIMEOUT only: with the idle model release (#1204) an interactive
// call can land on a cold worker whose CLAP reload eats the whole deadline. The
// backend keeps loading after we stop waiting — the request is already queued
// behind its single-flight lock — so a second wait usually lands on a warm
// model. Non-timeout failures (refused, 404, 500) stay single-shot: fast,
// definitive "not available" signals. Bulk callers pass `coldRetry: false` —
// a 10-minute timeout means real trouble, not a cold model.
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
      // 404 = pre-text-tower sidecar, 500 = lean build (no torch) — both mean
      // "no text embeddings", not an error worth surfacing per call.
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

// --- Transition render (feature: stem-blend transitions) --------------------

// What the render op needs to align and mix — straight from library.db, the
// worker never re-detects. Wire-shaped (snake keys pass through verbatim).
// `gain_db` is the dB the station itself would apply to that side (the same
// figure the drain stamps as liq_amplify — music/loudness.ts) and is what the
// worker mixes with. `lufs` is the pre-#1240 input, kept on the wire so an
// older analyzer image still renders from its own maths.
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

// Mix a pre-rendered transition WAV from two tracks' cached stems. Returns
// null on ANY miss or failure (stems absent, degenerate grids, old sidecar
// without the endpoint, timeout) — the caller falls back to a plain
// pair-aware crossfade; the worker's own log carries the reason. Note the
// render itself needs only numpy+soundfile, so it works on the LEAN image
// too as long as the stems were cached by a heavy backend earlier.
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
  } catch (err) {
    // Drop the staging file on EVERY failure. `createWriteStream` truncates
    // `dest` into existence the moment the pipeline starts, so three of the
    // throws below it leave a file the caller never learns about: a pipeline
    // rejection, the `read === 0` guard, and the small-file non-audio backstop.
    // Only the SUCCESS path hands a path back, and the caller only ever cleans
    // up paths it was handed — runAnalysisPass's one-ahead prefetch reduces a
    // rejection to `{err}` and drops the filename on the floor — so nothing
    // else can reach these.
    //
    // Blanket rather than per-throw on purpose: the two guards ABOVE the
    // pipeline (`!res.ok`, the content-type check) create no file, `force`
    // makes removing a path that was never created a no-op, and enumerating
    // which throws happen to be past the `createWriteStream` line is exactly
    // the distinction a later edit would get wrong. Best-effort — a cleanup
    // that itself fails must not replace the real error. The cap path is NOT
    // a failure: `capped()` returns normally, so this never runs on it.
    await rm(dest, { force: true }).catch(() => {});
    throw err;
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

let pathFallbackWarned = false;

// Prefer the one-ahead shared-path handoff, but degrade a sidecar that cannot
// see the controller's state mount to its existing URL input. Only the
// sidecar's machine-readable path-unavailable response earns the retry: a
// decode/model failure is real analysis work failing and must not be doubled.
// `complete` describes the controller's staged file, while `stems_dir` is a
// controller-local output path; neither is valid when the sidecar downloads
// its own temporary copy.
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
