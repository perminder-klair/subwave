// Library coverage — total Navidrome song count vs tagged tracks, plus
// acoustic-analysis coverage (tracks with bpm/key/intro) against that same
// total.
//
// `total` requires walking iterateAllSongs(), which is ONE getAlbum call per
// album — a few thousand sequential Navidrome requests on a 29k-track library.
// That is far too expensive to ride a page view, so get() never starts it:
// the scan runs only when something explicitly asks (refresh()), and get()
// serves the last-known count stamped with `scannedAt` so the caller can show
// its age. Triggers today are the operator's own "count library" press
// (POST /library/coverage/refresh, GET /library/coverage?refresh=1) and the
// two runs that have just walked the catalogue anyway — a finished tagger run
// and a library reset.
//
// Before #1570 a stale-after-6h check inside get() kicked the walk from the
// admin Library page's own mount poll, so opening that page hammered Navidrome
// with a scan nobody asked for. Never reintroduce a scan on the read path.
// Concurrent callers share the in-flight scan via a single promise.

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
}

const cache: CoverageCache = { total: 0, scannedAt: null, scanning: false };
let inflight: Promise<void> | null = null;

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
  try {
    let count = 0;
    for await (const _song of subsonic.iterateAllSongs()) count++;
    cache.total = count;
    cache.scannedAt = new Date().toISOString();
  } finally {
    cache.scanning = false;
    inflight = null;
  }
}

// Kick off a scan if one isn't running. Non-blocking — callers read the
// current snapshot from get() and poll until scanning flips false.
export function refresh() {
  if (!inflight) inflight = doScan().catch(err => {
    console.error('[library-coverage] scan failed:', err.message);
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
  const percent =
    total != null && total > 0 ? Math.floor((tagged / total) * 100) : null;
  const analysedPercent =
    total != null && total > 0 ? Math.floor((analysed / total) * 100) : null;
  const audioEmbeddedPercent =
    total != null && total > 0 ? Math.floor((audioEmbedded / total) * 100) : null;
  const vocalAnalyzedPercent =
    total != null && total > 0 ? Math.floor((vocalAnalyzed / total) * 100) : null;
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
