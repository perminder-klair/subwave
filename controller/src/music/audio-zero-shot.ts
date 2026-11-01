// One zero-shot pass over the stored CLAP audio vectors: embed a vocabulary's
// prompts, score the vectors that need it, calibrate, then label. Audio moods
// and sound descriptors share it and differ only in vocabulary, storage and how
// labels are chosen. Missing vectors, backend capability, or failed requests log
// and skip.

import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import {
  computeBaselines,
  moodPassAction,
  moodStateHashFor,
  prunedBaselines,
  type MoodBaselines,
} from './audio-calibration.js';
import type { TaggerEventKind } from './tagger-progress.js';

export interface ScoreRow {
  id: string;
  scores: Record<string, number>;
}

export interface ZeroShotStats {
  scored: number;
  scope: number;
  skipped: string | null; // reason when the pass didn't run (null = ran/empty)
  relabelled?: number;    // labels re-derived from stored cosines
  calibrated?: boolean;
}

export interface ZeroShotSpec {
  tag: string; // the per-batch console prefix
  logEvent: (kind: TaggerEventKind, text: string) => void;
  version: number; // rides the stored state beside the vocabulary hash
  vocabHash(): string;
  // Snapshotted once per pass, so prompts and the scoring loop stay
  // index-aligned.
  vocab(): { labels: string[]; prompts: string[] };
  readState(): string | null;
  writeState(hash: string): void;
  idsNeedingScores(): string[];
  writeScores(rows: ScoreRow[]): void;
  iterateScores(): Iterable<ScoreRow>;
  pageScores(afterId: string, limit: number): { items: ScoreRow[]; lastId: string | null };
  writeLabels(rows: Array<{ id: string; labels: string[] }>): void;
  select(scores: Record<string, number>, baselines: MoodBaselines | null): string[];
  say: {
    relabelled(count: number, calibrated: boolean): string;
    towerFailed: string;
    noTower: string;
    scoring(count: number, vocabChanged: boolean): string;
    scored(count: number, calibrated: boolean): string;
  };
}

function dot(a: Float32Array, b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// Per-label baselines from every score map on disk. null = library too small to
// calibrate; callers pass that straight to the vocabulary's selection.
function loadBaselines(spec: ZeroShotSpec): MoodBaselines | null {
  const baselines = computeBaselines(
    (function* () {
      for (const row of spec.iterateScores()) yield row.scores;
    })(),
  );
  // Pruned, not gated: a label scored on too few tracks is dropped so a
  // degenerate sd can't let it dominate selection.
  return prunedBaselines(baselines);
}

// Re-derive labels for every scored track from the cosines already on disk. No
// analyzer round-trip: a calibration change invalidates the labels, not the
// scores, and the CLAP text tower is opt-in (ANALYZER_HEAVY).
// PAGED, not streamed: better-sqlite3 refuses a write while a read cursor is
// open on the same connection, and this loop writes as it walks.
export function relabelAllFromStoredScores(
  spec: ZeroShotSpec,
  baselines: MoodBaselines | null,
): number {
  const PAGE = 500;
  let done = 0;
  let cursor = '';
  for (;;) {
    const { items, lastId } = spec.pageScores(cursor, PAGE);
    if (lastId == null) break;
    spec.writeLabels(
      items.map(({ id, scores }) => ({ id, labels: spec.select(scores, baselines) })),
    );
    done += items.length;
    cursor = lastId;
  }
  return done;
}

// Score every track that needs it. Incremental by default (vector present,
// labels NULL); a vocabulary/prompt change re-scores the whole vector-carrying
// set. Cheap when there is nothing to do.
export async function runZeroShotPass(spec: ZeroShotSpec): Promise<ZeroShotStats> {
  if (db.audioVectorCount() === 0) {
    return { scored: 0, scope: 0, skipped: 'no audio vectors' };
  }

  const hash = spec.vocabHash();
  const stored = spec.readState();
  // Two reasons to redo work, at very different cost: a vocabulary change
  // invalidates the cosines (full CLAP re-score), a calibration change only the
  // labels (re-derive from disk).
  const action = moodPassAction(stored, hash, spec.version);
  const vocabChanged = action === 'rescore';
  const ids = vocabChanged ? db.audioVectorIds() : spec.idsNeedingScores();

  // Nothing new to score, but a pending relabel still has to run (no analyzer
  // needed).
  if (ids.length === 0) {
    if (action !== 'relabel') return { scored: 0, scope: 0, skipped: null };
    const baselines = loadBaselines(spec);
    const relabelled = relabelAllFromStoredScores(spec, baselines);
    spec.writeState(moodStateHashFor(hash, !!baselines, spec.version));
    spec.logEvent('success', spec.say.relabelled(relabelled, !!baselines));
    return { scored: 0, scope: 0, skipped: null, relabelled, calibrated: !!baselines };
  }

  // One round-trip for the whole vocabulary; the first call after a cold boot
  // may lazy-load or download the CLAP text tower.
  const { labels, prompts } = spec.vocab();
  // coldRetry off: at this deadline a timeout means a broken backend, not a
  // cold one, and retrying would just stall the pass for another 10 minutes.
  const vecs = await analyzer.embedTexts(prompts, { timeoutMs: 10 * 60_000, coldRetry: false });
  if (!vecs || vecs.length !== labels.length) {
    // A backend that advertises the text tower but failed the call is a runtime
    // fault (#996), not a lean build; "enable ANALYZER_HEAVY" would send the
    // operator the wrong way.
    if (analyzer.textEmbeddingAvailable() === true) {
      spec.logEvent('warning', spec.say.towerFailed);
      return { scored: 0, scope: ids.length, skipped: 'text embedding failed' };
    }
    spec.logEvent('info', spec.say.noTower);
    return { scored: 0, scope: ids.length, skipped: 'no text tower' };
  }

  spec.logEvent('info', spec.say.scoring(ids.length, vocabChanged));

  // Phase 1, score. Cosines only: selection is centred on baselines drawn from
  // the whole library, which on a full re-score are a property of the scores
  // being written right now. Score maps are held only on an incremental pass
  // (bounded by the new tracks); a full re-score relabels from disk in phase 3.
  const relabelAll = vocabChanged || action === 'relabel';
  const scoredRows: ScoreRow[] = [];
  let scored = 0;
  let batch: ScoreRow[] = [];
  for (const id of ids) {
    const v = db.getAudioVector(id);
    if (!v) continue;
    const scores: Record<string, number> = {};
    for (let i = 0; i < labels.length; i++) {
      // Both sides are L2-normalised, so the dot IS the cosine. 3 decimals
      // keeps the stored JSON small.
      scores[labels[i]] = Math.round(dot(v, vecs[i]) * 1000) / 1000;
    }
    batch.push({ id, scores });
    if (!relabelAll) scoredRows.push({ id, scores });
    scored += 1;
    if (batch.length >= 500) {
      spec.writeScores(batch);
      batch = [];
      console.log(`[${spec.tag}] ${scored}/${ids.length}`);
    }
  }
  spec.writeScores(batch);

  // Phase 2, calibrate.
  const baselines = loadBaselines(spec);

  // Phase 3, label. A full re-score relabels everything (every track's axis just
  // moved); an incremental pass labels only what it scored, since a handful of
  // new tracks cannot shift a library-wide distribution.
  let relabelled = 0;
  if (relabelAll) {
    relabelled = relabelAllFromStoredScores(spec, baselines);
  } else {
    let batchLabels: Array<{ id: string; labels: string[] }> = [];
    for (const { id, scores } of scoredRows) {
      batchLabels.push({ id, labels: spec.select(scores, baselines) });
      relabelled += 1;
      if (batchLabels.length >= 500) {
        spec.writeLabels(batchLabels);
        batchLabels = [];
      }
    }
    spec.writeLabels(batchLabels);
  }

  spec.writeState(moodStateHashFor(hash, !!baselines, spec.version));
  spec.logEvent('success', spec.say.scored(scored, !!baselines));
  return { scored, scope: ids.length, skipped: null, relabelled, calibrated: !!baselines };
}
