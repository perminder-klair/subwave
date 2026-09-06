// Library coverage — total Navidrome song count vs tagged tracks, plus
// acoustic-analysis coverage (tracks with bpm/key/intro) against that same
// total.
//
// `total` requires walking iterateAllSongs(), which is ONE getAlbum call per
// album — a few thousand sequential Navidrome requests on a 29k-track library.
// That is far too expensive to ride a page view, so get() never starts it:
// the scan runs only when something explicitly asks (refresh()), and get()
// serves the last-known count stamped with `scannedAt` so the caller can show
// its age. Exactly three things trigger a walk: the operator's own "count
// library" press (POST /library/coverage/refresh), and the two ends of a tagger
// run, which is walking the catalogue anyway — at START only when nothing has
// ever been counted (hasCount(), so the first run's meter isn't stuck at "—"),
// and at exit. The GET carries no `?refresh=1`: counting is a command, and a
// read that can start a walk is what something eventually polls by accident.
// A library RESET is deliberately not a trigger — it wipes library.db, not
// Navidrome, so the total it would recompute cannot have changed.
//
// Before #1570 a stale-after-6h check inside get() kicked the walk from the
// admin Library page's own mount poll, so opening that page hammered Navidrome
// with a scan nobody asked for. Never reintroduce a scan on the read path.
// Concurrent callers share the in-flight scan via a single promise.
//
// The count therefore PERSISTS to state/library-count.json. Once nothing
// recounts unattended, an in-memory-only cache would blank the total — and with
// it every percentage on the panel — on each controller restart (an upgrade, a
// settings change that needs one, a multi-station profile switch), leaving the
// operator to notice and press the button again. Persisting it is also what
// makes `scannedAt` mean what the UI says: without a stored stamp the age can
// never read older than process uptime, so "counted 3d ago" could not happen.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import { vocalActivityWanted, audioEmbeddingWanted } from './analyze.js';
import { activeModelLabel, EMBED_TEXT_VERSION } from './embeddings.js';
import { dimensionStatus } from './coverage-status.js';

// Acoustic-analysis backend availability is probed separately: analyzer
// .isAvailable() can do a 5 s sidecar HTTP probe and doesn't cache a negative
// result, so we memoise it on a short TTL rather than re-probe on every poll.
const ANALYSIS_PROBE_TTL_MS = 60 * 1000; // 1 min

interface CoverageCache {
  total: number;
  scannedAt: string | null;
  scanning: boolean;
  // Why the last count failed, or null when the last one succeeded / none has
  // run. The scan is fire-and-forget behind an operator button, so without this
  // a failed count is indistinguishable from one that never happened: the toast
  // says "counting…", `scanning` flips back to false, and the only diagnostic
  // is the controller log. Cleared when a scan starts and on success, so it
  // only ever describes the most recent attempt.
  scanError: string | null;
}

const cache: CoverageCache = {
  total: 0, scannedAt: null, scanning: false, scanError: null,
};
let inflight: Promise<void> | null = null;

// --- persisted count -------------------------------------------------------
// Only `total` + `scannedAt` are stored. `scanning`/`scanError` describe THIS
// process's attempt and must not survive a restart — a stored `scanning: true`
// from a killed container would show a spinner for a scan nobody is running.
const COUNT_FILE = `${config.stateDir}/library-count.json`;

interface StoredCount {
  version: 1;
  total: number;
  scannedAt: string;
}

// A missing file is "never counted"; a corrupt or nonsensical one degrades to
// the same, never throwing into a caller — a bad side-file must not break the
// Library page, it must only cost the operator one button press.
function loadStoredCount(): void {
  try {
    if (!existsSync(COUNT_FILE)) return;
    const parsed = JSON.parse(readFileSync(COUNT_FILE, 'utf8')) as Partial<StoredCount>;
    const total = parsed?.total;
    const scannedAt = parsed?.scannedAt;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return;
    if (typeof scannedAt !== 'string' || Number.isNaN(new Date(scannedAt).getTime())) return;
    cache.total = Math.floor(total);
    cache.scannedAt = scannedAt;
  } catch (err: any) {
    console.warn(`[library-coverage] could not read stored count: ${err?.message || err}`);
  }
}

function persistCount(): void {
  if (!cache.scannedAt) return;
  try {
    const store: StoredCount = { version: 1, total: cache.total, scannedAt: cache.scannedAt };
    const tmp = `${COUNT_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, COUNT_FILE);
  } catch (err: any) {
    // A count we can't persist is still a count this process can serve — warn
    // and carry on rather than failing the scan the operator asked for.
    console.warn(`[library-coverage] could not persist count: ${err?.message || err}`);
  }
}

loadStoredCount();

// Whether a count has ever landed. Lets an explicit operator command that is
// about to walk the catalogue anyway (a tagger run) fill a never-counted
// library, without anything on the READ path consulting it.
export function hasCount(): boolean {
  return cache.scannedAt != null;
}

// Last known acoustic-analysis backend state. `null` until first probed.
// `audioCapable` mirrors analyzer.audioEmbeddingAvailable() — whether the
// backend can emit CLAP "sounds-like" embeddings (null = unknown).
// `audioError` / `vocalError` carry WHY a capability is false when the model is
// installed but failed to load — the difference between "you need the heavy
// image" and "this host couldn't download the weights".
let analysisAvail: {
  available: boolean;
  backend: string;
  audioCapable: boolean | null;
  vocalCapable: boolean | null;
  audioError: string | null;
  vocalError: string | null;
  checkedAt: number;
} | null = null;
let analysisProbeInflight: Promise<void> | null = null;

function refreshAnalysisAvail() {
  if (analysisProbeInflight) return analysisProbeInflight;
  analysisProbeInflight = (async () => {
    try {
      const available = await analyzer.isAvailable();
      await analyzer.refreshCapabilities();
      analysisAvail = {
        available,
        backend: analyzer.backendLabel(),
        audioCapable: analyzer.audioEmbeddingAvailable(),
        vocalCapable: analyzer.vocalActivityAvailable(),
        audioError: analyzer.audioEmbeddingError(),
        vocalError: analyzer.vocalActivityError(),
        checkedAt: Date.now(),
      };
    } catch {
      analysisAvail = {
        available: false, backend: 'none',
        audioCapable: null, vocalCapable: null,
        audioError: null, vocalError: null,
        checkedAt: Date.now(),
      };
    } finally {
      analysisProbeInflight = null;
    }
  })();
  return analysisProbeInflight;
}

function analysisAvailStale() {
  return !analysisAvail || Date.now() - analysisAvail.checkedAt > ANALYSIS_PROBE_TTL_MS;
}

async function doScan() {
  cache.scanning = true;
  cache.scanError = null;
  try {
    let count = 0;
    for await (const _song of subsonic.iterateAllSongs()) count++;
    cache.total = count;
    cache.scannedAt = new Date().toISOString();
    persistCount();
  } finally {
    cache.scanning = false;
    inflight = null;
  }
}

// Kick off a scan if one isn't running. Non-blocking — callers read the
// current snapshot from get() and poll until scanning flips false. A failure
// is RECORDED, not just logged: this runs behind an operator button whose only
// other feedback is the total appearing, so a silent failure reads to them as
// nothing having happened. A failed re-count deliberately leaves the previous
// total and its `scannedAt` in place — a stale number with a visible age beats
// blanking the panel because Navidrome was briefly unreachable.
export function refresh() {
  if (!inflight) inflight = doScan().catch(err => {
    cache.scanError = err?.message || String(err);
    console.error('[library-coverage] scan failed:', cache.scanError);
  });
  return inflight;
}

// Snapshot for the API. Deliberately read-only: it never starts a scan (see
// the header). `total`/`percent` are null until someone has asked for a count,
// which the UI reads as "not counted yet" rather than guessing 100%.
export async function get() {
  await library.load();
  // First call: probe definitively (≤5 s) so the UI gets a real answer rather
  // than "checking…" for a whole poll cycle. Later calls refresh in the
  // background and serve the last-known value.
  if (analysisAvail == null) await refreshAnalysisAvail();
  else if (analysisAvailStale() && !analysisProbeInflight) refreshAnalysisAvail();
  const tagged = library.countTagged();
  const analysed = db.analysedCount();
  const audioEmbedded = db.audioVectorCount();
  const vocalAnalyzed = db.vocalAnalyzedCount();
  const total = cache.scannedAt ? cache.total : null;
  // Floor, not round: "100%" must mean truly complete. Rounding showed 100% at
  // 99.5%+ (e.g. 999/1000), which reads as done when a track still needs work —
  // and pushed coverage-status.ts to 'complete' one track early. Floor keeps the
  // meter at 99% until the last track lands; count===total is the only exact 100.
  // Capped at 100 as well as floored. The two sides of every ratio come from
  // DIFFERENT places — the numerator is a live library.db count, the
  // denominator the last Navidrome walk — so they drift apart by design now
  // that nothing recounts unattended (#1570): tracks pulled from the music
  // server stay in library.db until a reconcile, and the total only moves when
  // someone asks. Uncapped, that renders as "2943% tagged", which reads as a
  // broken meter rather than a stale count. The progress bars already clamped
  // their aria-valuenow, so only the printed figure was exposed. `scannedAt` is
  // what tells the operator the denominator may be old.
  const pctOf = (n: number) =>
    total != null && total > 0 ? Math.min(100, Math.floor((n / total) * 100)) : null;
  const percent = pctOf(tagged);
  const analysedPercent = pctOf(analysed);
  const audioEmbeddedPercent = pctOf(audioEmbedded);
  const vocalAnalyzedPercent = pctOf(vocalAnalyzed);
  // Embedding-index provenance: the model the vectors were built with vs what the
  // current settings would embed with (same activeModelLabel() format on both
  // sides, so no prefix/default drift). When they differ, a tag run hits a hard
  // dim/model mismatch in library-db.migrate — the UI turns this into a one-click
  // "re-embed" prompt instead of a cryptic tagger-log failure.
  const embeddedMeta = db.getEmbeddingMeta();
  const currentEmbeddingModel = activeModelLabel();
  const embeddingStale = !!(
    embeddedMeta && currentEmbeddingModel && embeddedMeta.model !== currentEmbeddingModel
  );
  // Embed-text SHAPE, kept strictly separate from `embeddingStale` above
  // (#1246). A model/dim change makes the stored vectors unusable and BLOCKS
  // the next tag run; an older text format does not — those vectors still
  // embed the same head line and still answer KNN. Folding the two together
  // would fire that panel's red "tagging is blocked" banner over an advisory,
  // so this gets its own soft signal and its own copy.
  const embeddingFormatStale = !!(
    embeddedMeta && (embeddedMeta.textFormat ?? 1) < EMBED_TEXT_VERSION
  );
  // How much of the index is label-text only — the measure of the #1246
  // failure. Zero embedded tracks means no index at all, which the embedding*
  // fields above already say; report null rather than a misleading 0.
  const embeddedVectors = db.vectorCount();
  const labelOnlyVectors = embeddedVectors > 0 ? db.labelOnlyVectorCount() : null;
  // Collapse the four nullable per-dimension signals into one status enum each
  // (see coverage-status.ts). Single source of truth for the "sounds-like" and
  // vocal rows so the panel — and the native app next — render off the enum
  // instead of re-deriving incapable/starved/gap from raw booleans. The raw
  // fields below stay on the payload for back-compat.
  const analysisReachable = analysisAvail ? analysisAvail.available : null;
  const audioStatus = dimensionStatus({
    enabled: audioEmbeddingWanted(),
    analysisAvailable: analysisReachable,
    capable: analysisAvail ? analysisAvail.audioCapable : null,
    loadError: analysisAvail ? analysisAvail.audioError : null,
    analysed,
    count: audioEmbedded,
    percent: audioEmbeddedPercent,
  });
  const vocalStatus = dimensionStatus({
    enabled: vocalActivityWanted(),
    analysisAvailable: analysisReachable,
    capable: analysisAvail ? analysisAvail.vocalCapable : null,
    loadError: analysisAvail ? analysisAvail.vocalError : null,
    analysed,
    count: vocalAnalyzed,
    percent: vocalAnalyzedPercent,
  });
  return {
    tagged,
    analysed,
    audioEmbedded,
    vocalAnalyzed,
    total,
    percent,
    analysedPercent,
    audioEmbeddedPercent,
    vocalAnalyzedPercent,
    scannedAt: cache.scannedAt,
    scanning: cache.scanning,
    // Why the last count failed (null = the last one worked, or none has run).
    // The panel turns this into a visible error beside the total; without it an
    // unreachable Navidrome looks identical to a library nobody has counted.
    scanError: cache.scanError,
    // Whether vocal-activity analysis is wanted (env ANALYZE_VOCAL_ACTIVITY or
    // settings.audio.vocalActivity). Drives whether the UI shows the vocal
    // coverage row at all — hidden by default for the common case (#646).
    vocalWanted: vocalActivityWanted(),
    // Whether an acoustic-analysis backend (tts-heavy sidecar / local librosa
    // venv) is reachable. When false, acoustic coverage stays 0 by design —
    // the UI surfaces this rather than showing a misleading 0%.
    analysisAvailable: analysisAvail ? analysisAvail.available : null,
    analysisBackend: analysisAvail ? analysisAvail.backend : null,
    // Whether the backend can emit CLAP "sounds-like" embeddings. false here
    // with sounds-like enabled means the sidecar was built without CLAP — the
    // UI turns this into a "rebuild with WITH_CLAP=1" warning. null = unknown.
    audioAnalysisAvailable: analysisAvail ? analysisAvail.audioCapable : null,
    // Whether the natural-language "sounds like…" search (/library/search-sound)
    // can serve right now: stored audio vectors exist AND the backend hasn't
    // reported the CLAP text tower absent. Same optimistic-on-null gate as the
    // picker's searchBySound tool — the route itself 503s cleanly if wrong.
    soundSearchAvailable: audioEmbedded > 0 && analyzer.textEmbeddingAvailable() !== false,
    // Whether the backend can emit Demucs vocal-activity ranges. false here with
    // vocal activity enabled means the sidecar was built without Demucs — the UI
    // turns this into a "rebuild with WITH_DEMUCS=1" warning, and the analysis
    // pass skips vocal backfill so it doesn't churn the whole library. null = unknown.
    vocalAnalysisAvailable: analysisAvail ? analysisAvail.vocalCapable : null,
    // Why the capability above is false, when the model is installed and its
    // LOAD failed — the reason string the analyzer reported, verbatim. null in
    // every other case (a lean image included), so the panel can render the
    // 'load-failed' status with the actual cause instead of generic advice.
    audioAnalysisError: analysisAvail ? analysisAvail.audioError : null,
    vocalAnalysisError: analysisAvail ? analysisAvail.vocalError : null,
    // Tracks dropped from every analysis scope after repeated failures. A
    // non-zero count is the cue to open GET /library/analysis-failures — before
    // this existed those tracks were invisible, and the pass reported "all
    // tracks current" over the top of them.
    analysisFailed: db.analysisFailedCount(),
    // Text-embedding index provenance + staleness. `embeddingStale` = the model
    // the library was embedded with differs from the currently-configured one, so
    // the next tag run would be blocked until a re-embed. null model = never
    // embedded yet (no staleness).
    embeddedModel: embeddedMeta?.model ?? null,
    embeddedDim: embeddedMeta?.dim ?? null,
    currentEmbeddingModel,
    embeddingStale,
    // Embed-text shape (#1246) — a SOFT advisory, never a block. `embeddedVectors`
    // rides along so the panel can express labelOnly as a share without a second
    // round trip, and so "0 of 0" can be told from "0 of 20,000".
    embeddingFormatStale,
    embeddedTextFormat: embeddedMeta?.textFormat ?? null,
    currentTextFormat: EMBED_TEXT_VERSION,
    embeddedVectors,
    labelOnlyVectors,
    // Per-dimension coverage status enums (coverage-status.ts). The panel renders
    // the "sounds-like" and vocal rows from these + the optimistic enable toggle;
    // the raw *AnalysisAvailable / *EmbeddedPercent fields above are retained.
    audioStatus,
    vocalStatus,
  };
}
