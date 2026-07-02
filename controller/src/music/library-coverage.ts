// Library coverage — total Navidrome song count vs tagged tracks, plus
// acoustic-analysis coverage (tracks with bpm/key/intro) against that same
// total.
// `total` requires walking iterateAllSongs() once (one Subsonic call per
// 500-album batch) which is too slow to do per request. We cache the count
// and refresh in the background; the cache is considered stale after 6 h or
// after a manual refresh. Concurrent /coverage requests share the in-flight
// scan via a single promise.

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import { vocalActivityWanted } from './analyze.js';
import { activeModelLabel } from './embeddings.js';

const STALE_MS = 6 * 60 * 60 * 1000; // 6 h
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
let analysisAvail: { available: boolean; backend: string; audioCapable: boolean | null; vocalCapable: boolean | null; checkedAt: number } | null = null;
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
        checkedAt: Date.now(),
      };
    } catch {
      analysisAvail = { available: false, backend: 'none', audioCapable: null, vocalCapable: null, checkedAt: Date.now() };
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

function isStale() {
  if (!cache.scannedAt) return true;
  return Date.now() - new Date(cache.scannedAt).getTime() > STALE_MS;
}

// Snapshot for the API. Triggers a refresh if the cache is stale or empty.
// Returns total=null/percent=null until the first scan completes — the UI
// uses that as the "scanning…" cue rather than guessing 100%.
export async function get() {
  await library.load();
  if (isStale() && !cache.scanning) refresh();
  // First call: probe definitively (≤5 s) so the UI gets a real answer rather
  // than "checking…" for a whole poll cycle. Later calls refresh in the
  // background and serve the last-known value.
  if (analysisAvail == null) await refreshAnalysisAvail();
  else if (analysisAvailStale() && !analysisProbeInflight) refreshAnalysisAvail();
  const tagged = library.allTaggedIds().length;
  const analysed = db.analysedCount();
  const audioEmbedded = db.audioVectorCount();
  const vocalAnalyzed = db.vocalAnalyzedCount();
  const total = cache.scannedAt ? cache.total : null;
  const percent =
    total != null && total > 0 ? Math.round((tagged / total) * 100) : null;
  const analysedPercent =
    total != null && total > 0 ? Math.round((analysed / total) * 100) : null;
  const audioEmbeddedPercent =
    total != null && total > 0 ? Math.round((audioEmbedded / total) * 100) : null;
  const vocalAnalyzedPercent =
    total != null && total > 0 ? Math.round((vocalAnalyzed / total) * 100) : null;
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
    // Whether the backend can emit Demucs vocal-activity ranges. false here with
    // vocal activity enabled means the sidecar was built without Demucs — the UI
    // turns this into a "rebuild with WITH_DEMUCS=1" warning, and the analysis
    // pass skips vocal backfill so it doesn't churn the whole library. null = unknown.
    vocalAnalysisAvailable: analysisAvail ? analysisAvail.vocalCapable : null,
    // Text-embedding index provenance + staleness. `embeddingStale` = the model
    // the library was embedded with differs from the currently-configured one, so
    // the next tag run would be blocked until a re-embed. null model = never
    // embedded yet (no staleness).
    embeddedModel: embeddedMeta?.model ?? null,
    embeddedDim: embeddedMeta?.dim ?? null,
    currentEmbeddingModel,
    embeddingStale,
  };
}
