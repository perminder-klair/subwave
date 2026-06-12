// Acoustic-analysis pass — fills bpm / musical_key / intro_ms for tracks that
// lack them (or were analysed by an older ANALYSIS_VERSION). Resumable and
// batched like the mood tagger: interrupt it and re-run, it picks up where it
// left off. Shared by two entry points — a phase of `npm run tag`
// (music/tag-library.ts) and the standalone `npm run analyze`
// (music/analyze-library.ts) — so the logic lives in exactly one place.
//
// The heavy DSP runs in music/analyzer.ts's backend (tts-heavy sidecar or a
// local librosa venv). When no backend is available this is a clean no-op, so
// it's always safe to call as a tagger phase.

import { rm } from 'node:fs/promises';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { reportProgress } from './tagger-progress.js';

export interface AnalyzeOptions {
  limit?: number;        // cap tracks this run (default: all that need it)
  reAnalyze?: boolean;   // drop existing analysis first, redo everything
  // Widen the scope to tracks that have bpm/key but no CLAP audio vector yet
  // (analysed before audio embeddings were enabled). Only meaningful when the
  // backend actually emits embeddings; defaults from ANALYZE_AUDIO_EMBEDDING.
  audioBackfill?: boolean;
}

// Audio embeddings are on when EITHER the env says so (env wins on, never
// off) or the operator flipped the admin toggle (settings.audio.embeddings —
// the discoverable path; see /admin/library). Both entry points (server-spawned
// runs and the standalone CLIs) call settings.load() before this runs.
function audioBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_AUDIO_EMBEDDING || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.embeddings === true;
  } catch {
    return false;
  }
}

export interface AnalyzeStats {
  available: boolean;
  backend: string;
  analyzed: number;
  failed: number;
  scope: number;
  // How many of the analysed tracks also got a CLAP audio vector this run.
  // 0 when the backend has no CLAP model loaded (ANALYZE_AUDIO_EMBEDDING off).
  audioEmbedded: number;
}

// Model label recorded in audio_embedding_meta for provenance. The worker owns
// the actual model; this is just what the controller stamps alongside the
// vectors it stores. Env-overridable so a model swap is self-documenting.
const AUDIO_MODEL_LABEL = process.env.CLAP_MODEL || 'laion-clap';

export async function runAnalysisPass(opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
  if (!(await analyzer.isAvailable())) {
    console.log('[analyze] no analysis backend (tts-heavy sidecar / local librosa venv) — skipping');
    return { available: false, backend: 'none', analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0 };
  }
  const backend = analyzer.backendLabel();
  console.log(`[analyze] backend: ${backend}`);

  if (opts.reAnalyze) {
    db.clearAnalysis();
    console.log('[analyze] --re-analyze: cleared existing analysis');
  }

  const cap = opts.limit && opts.limit > 0 ? opts.limit : undefined;
  const bpmIds = db.needsAnalysisIds(cap);
  let ids = bpmIds;

  // Audio backfill: also target already-analysed tracks that lack a CLAP audio
  // vector, so enabling embeddings on a previously-analysed library fills it in
  // without a full --re-analyze. Re-running analysis on these recomputes bpm/key
  // (same values, harmless) and stores the new audio vector from the same call.
  const audioBackfill = opts.audioBackfill ?? audioBackfillDefault();
  if (audioBackfill) {
    const seen = new Set(bpmIds);
    const audioIds = db.unanalysedAudioIds(cap).filter(id => !seen.has(id));
    ids = cap ? [...bpmIds, ...audioIds].slice(0, cap) : [...bpmIds, ...audioIds];
    if (audioIds.length > 0) {
      console.log(`[analyze] audio backfill: +${ids.length - bpmIds.length} already-analysed tracks missing an audio vector`);
    }
  }

  if (ids.length === 0) {
    console.log('[analyze] nothing to analyse — all tracks current');
    return { available: true, backend, analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0 };
  }
  console.log(`[analyze] ${ids.length} tracks to analyse`);
  reportProgress({ phase: 'analyze', label: 'Analysing audio', done: 0, total: ids.length });

  let analyzed = 0;
  let failed = 0;
  let audioEmbedded = 0;
  // Stamp the audio-embedding provenance row once, on the first vector written
  // this run. Cheap idempotent guard so we don't touch the meta table per track.
  let audioMetaStamped = false;
  const audioModelLabel = AUDIO_MODEL_LABEL;

  // One-ahead prefetch pipeline: the controller downloads track i+1's audio
  // (network) while the backend computes track i (CPU), so the two overlap.
  // The backend stays single-threaded — we only hide fetch latency. Each
  // download resolves to a temp path on the shared volume; on download failure
  // we fall back to the url path for that one id so it still gets analysed.
  type Prefetch = Promise<string>;
  let inflight: Prefetch | null = ids.length > 0 ? analyzer.downloadCapped(ids[0]) : null;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const downloadPromise = inflight;
    // Kick off the NEXT download before awaiting this one's analysis so the
    // fetch overlaps the compute.
    inflight = i + 1 < ids.length ? analyzer.downloadCapped(ids[i + 1]) : null;

    let localPath: string | null = null;
    try {
      try {
        localPath = downloadPromise ? await downloadPromise : null;
      } catch (err: any) {
        // Prefetch failed — fall back to the url path for this one track.
        console.error(`[analyze] ${id} prefetch failed (${err?.message || err}); using url path`);
        localPath = null;
      }
      // embed:true makes the backend lazy-load CLAP even when its own env
      // doesn't have ANALYZE_AUDIO_EMBEDDING (the admin-toggle path); omitted
      // when audio is off so the backend keeps its env-driven default.
      const embed = audioBackfill ? true : undefined;
      const a = localPath
        ? await analyzer.analyzePath(localPath, { embed })
        : await analyzer.analyze(id, { embed });
      db.upsertTrackAnalysis(id, {
        bpm: a.bpm,
        musicalKey: a.musicalKey,
        introMs: a.introMs,
        confidence: a.confidence,
      });
      // Opportunistically store the CLAP audio vector whenever the backend
      // carried one. Independent of the bpm/key write above: a track analysed
      // before CLAP was enabled simply gets its vector on the next pass once
      // unanalysedAudioIds re-targets it. The first vector written stamps the
      // audio-embedding provenance row.
      if (a.audioEmbedding && a.audioEmbedding.length === db.AUDIO_EMBEDDING_DIM) {
        try {
          db.upsertTrackAudioVector(id, a.audioEmbedding);
          if (!audioMetaStamped) {
            db.setAudioEmbeddingMeta(audioModelLabel, db.AUDIO_EMBEDDING_DIM);
            audioMetaStamped = true;
          }
          audioEmbedded += 1;
        } catch (err: any) {
          console.error(`[analyze] ${id} audio-vector write failed: ${err?.message || err}`);
        }
      }
      analyzed += 1;
    } catch (err: any) {
      failed += 1;
      // Leave the row NULL so the next run retries it; don't stamp a version.
      console.error(`[analyze] ${id} failed: ${err?.message || err}`);
    } finally {
      // Drop this track's temp file (best-effort) regardless of outcome.
      if (localPath) await rm(localPath, { force: true }).catch(() => {});
    }
    if ((i + 1) % 25 === 0 || i + 1 === ids.length) {
      console.log(`[analyze] ${i + 1}/${ids.length} (ok=${analyzed} fail=${failed})`);
      reportProgress({
        phase: 'analyze',
        label: 'Analysing audio',
        done: i + 1,
        total: ids.length,
        errors: failed || undefined,
      });
    }
  }

  // Best-effort sweep of the staging dir in case a prefetch left an orphan
  // (e.g. a download that resolved after its analyze slot already errored).
  await rm(`${config.stateDir}/analyze-tmp`, { recursive: true, force: true }).catch(() => {});

  console.log(
    `[analyze] done — analyzed=${analyzed} failed=${failed}` +
      (audioEmbedded > 0 ? ` audio-embedded=${audioEmbedded}` : ''),
  );
  return { available: true, backend, analyzed, failed, scope: ids.length, audioEmbedded };
}
