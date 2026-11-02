// get() never counts Navidrome: refresh() performs the expensive album walk. A reset is not a
// scan trigger. Share concurrent refreshes and persist the result to library-count.json.
// #1570.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { config } from '../config.js';
import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import { vocalActivityWanted, audioEmbeddingWanted } from './analyze.js';
import { activeModelLabel, EMBED_TEXT_VERSION } from './embeddings.js';
import { dimensionStatus } from './coverage-status.js';

// analyzer.isAvailable() can do a 5s sidecar probe and caches no negative
// result, so memoise it rather than re-probe on every poll.
const ANALYSIS_PROBE_TTL_MS = 60 * 1000; // 1 min

interface CoverageCache {
  total: number;
  scannedAt: string | null;
  scanning: boolean;
  // Why the last count failed; null when it succeeded or none has run.
  scanError: string | null;
}

const cache: CoverageCache = {
  total: 0, scannedAt: null, scanning: false, scanError: null,
};
let inflight: Promise<void> | null = null;

// Only total + scannedAt persist; scanning/scanError describe this process.
const COUNT_FILE = `${config.stateDir}/library-count.json`;

interface StoredCount {
  version: 1;
  total: number;
  scannedAt: string;
}

// A missing, corrupt or nonsensical file reads as "never counted"; never throws.
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
    console.warn(`[library-coverage] could not persist count: ${err?.message || err}`);
  }
}

loadStoredCount();

// Consulted only by walk paths, never by get().
export function hasCount(): boolean {
  return cache.scannedAt != null;
}

// Last known acoustic-analysis backend state; null until first probed. `*Error`
// says why a capability is false when the model is installed but failed to load.
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

// The library.db half of the snapshot, kept while db.changeToken() matches:
// an unchanged token means no connection has committed, so every count is
// still exact (#1937). No TTL — a write anywhere, the tagger child included,
// changes the token, so this is never staler than a fresh read. The token is
// read before the counts, so a commit landing between them forces the next
// call to recount. labelOnlyVectorCount() stays outside: it keeps its own
// 5-minute TTL, which a snapshot held on an idle library would outlast.
interface DbCounts {
  tagged: number;
  analysed: number;
  audioEmbedded: number;
  vocalAnalyzed: number;
  embeddedMeta: ReturnType<typeof db.getEmbeddingMeta>;
  embeddedVectors: number;
  analysisFailed: number;
}
let dbCounts: { token: string; value: DbCounts } | null = null;

function readDbCounts(): DbCounts {
  const token = db.changeToken();
  if (dbCounts && dbCounts.token === token) return dbCounts.value;
  const value: DbCounts = {
    tagged: library.countTagged(),
    analysed: db.analysedCount(),
    audioEmbedded: db.audioVectorCount(),
    vocalAnalyzed: db.vocalAnalyzedCount(),
    embeddedMeta: db.getEmbeddingMeta(),
    embeddedVectors: db.vectorCount(),
    analysisFailed: db.analysisFailedCount(),
  };
  dbCounts = { token, value };
  return value;
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

// Non-blocking; callers poll get() until `scanning` flips false. A failure lands
// on `scanError` and leaves the previous total and scannedAt in place.
export function refresh() {
  if (!inflight) inflight = doScan().catch(err => {
    cache.scanError = err?.message || String(err);
    console.error('[library-coverage] scan failed:', cache.scanError);
  });
  return inflight;
}

// API snapshot. Never starts a scan; total/percent are null until someone has
// asked for a count, meaning "not counted yet" rather than 100%.
export async function get() {
  await library.load();
  // First call probes definitively (<=5s); later calls refresh in background.
  if (analysisAvail == null) await refreshAnalysisAvail();
  else if (analysisAvailStale() && !analysisProbeInflight) refreshAnalysisAvail();
  const {
    tagged, analysed, audioEmbedded, vocalAnalyzed, embeddedMeta, embeddedVectors, analysisFailed,
  } = readDbCounts();
  const total = cache.scannedAt ? cache.total : null;
  // Floored so 100% means complete, and capped because the numerator is live
  // while the denominator is the last walk, so they drift apart by design (#1570).
  const pctOf = (n: number) =>
    total != null && total > 0 ? Math.min(100, Math.floor((n / total) * 100)) : null;
  const percent = pctOf(tagged);
  const analysedPercent = pctOf(analysed);
  const audioEmbeddedPercent = pctOf(audioEmbedded);
  const vocalAnalyzedPercent = pctOf(vocalAnalyzed);
  // Model the vectors were built with vs what settings would embed with now;
  // a difference blocks the next tag run.
  const currentEmbeddingModel = activeModelLabel();
  const embeddingStale = !!(
    embeddedMeta && currentEmbeddingModel && embeddedMeta.model !== currentEmbeddingModel
  );
  // Embed-text shape, separate from embeddingStale (#1246): a soft advisory
  // that never blocks a tag run.
  const embeddingFormatStale = !!(
    embeddedMeta && (embeddedMeta.textFormat ?? 1) < EMBED_TEXT_VERSION
  );
  // Label-text-only share (#1246); null rather than a misleading 0 when empty.
  const labelOnlyVectors = embeddedVectors > 0 ? db.labelOnlyVectorCount() : null;
  // Collapse the nullable per-dimension signals into one status enum each so
  // surfaces don't re-derive them; the raw fields stay for back-compat.
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
    // null = the last count worked, or none has run.
    scanError: cache.scanError,
    // env ANALYZE_VOCAL_ACTIVITY or settings.audio.vocalActivity; drives whether
    // the UI shows the vocal coverage row (#646).
    vocalWanted: vocalActivityWanted(),
    // When false, acoustic coverage stays 0 by design.
    analysisAvailable: analysisAvail ? analysisAvail.available : null,
    analysisBackend: analysisAvail ? analysisAvail.backend : null,
    // null = unknown.
    audioAnalysisAvailable: analysisAvail ? analysisAvail.audioCapable : null,
    // Optimistic on an unknown text tower, like the picker's searchBySound tool;
    // the route 503s cleanly if wrong.
    soundSearchAvailable: audioEmbedded > 0 && analyzer.textEmbeddingAvailable() !== false,
    vocalAnalysisAvailable: analysisAvail ? analysisAvail.vocalCapable : null,
    // Verbatim load-failure reason; null in every other case.
    audioAnalysisError: analysisAvail ? analysisAvail.audioError : null,
    vocalAnalysisError: analysisAvail ? analysisAvail.vocalError : null,
    // Tracks dropped from every analysis scope after repeated failures.
    analysisFailed,
    // null model = never embedded.
    embeddedModel: embeddedMeta?.model ?? null,
    embeddedDim: embeddedMeta?.dim ?? null,
    currentEmbeddingModel,
    embeddingStale,
    // embeddedVectors rides along so labelOnly can be shown as a share.
    embeddingFormatStale,
    embeddedTextFormat: embeddedMeta?.textFormat ?? null,
    currentTextFormat: EMBED_TEXT_VERSION,
    embeddedVectors,
    labelOnlyVectors,
    audioStatus,
    vocalStatus,
  };
}
