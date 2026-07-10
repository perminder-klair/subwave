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
import { runAudioMoodPass } from './audio-moods.js';
import { shouldPrefetchAnalyzerAudio } from './analyzer-handoff.js';
import { reportProgress, makeEventLogger } from './tagger-progress.js';

// Structured status events for the panel, mirrored to the terse `[analyze] …`
// console line. Shared by the tagger's analyze phase and the standalone CLI.
const logEvent = makeEventLogger('analyze');

export interface AnalyzeOptions {
  limit?: number;        // cap tracks this run (default: all that need it)
  reAnalyze?: boolean;   // drop existing analysis first, redo everything
  // Re-scan mode: a --re-analyze redoes ONLY the already-analysed population
  // (captured before the clear), never the un-analysed remainder. The raw
  // standalone `npm run analyze --re-analyze` leaves this off and redoes the
  // whole library as documented.
  rescan?: boolean;
  // Widen the scope to tracks that have bpm/key but no CLAP audio vector yet
  // (analysed before audio embeddings were enabled). Only meaningful when the
  // backend actually emits embeddings; defaults from ANALYZE_AUDIO_EMBEDDING.
  audioBackfill?: boolean;
  // Widen the scope to tracks with no vocal-activity ranges yet (vocal_ranges_json
  // NULL). The Demucs pass is expensive and opt-in; defaults from
  // ANALYZE_VOCAL_ACTIVITY / settings.audio.vocalActivity.
  vocalBackfill?: boolean;
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

// Vocal-activity backfill default — same precedence as audio: env wins on,
// else the admin toggle (settings.audio.vocalActivity).
function vocalBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_VOCAL_ACTIVITY || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.vocalActivity === true;
  } catch {
    return false;
  }
}

// Whether vocal-activity analysis is *wanted* — env ANALYZE_VOCAL_ACTIVITY wins
// on, else settings.audio.vocalActivity. Exposed so /library/coverage can decide
// whether to surface the vocal coverage row (hidden by default; #646).
export function vocalActivityWanted(): boolean {
  return vocalBackfillDefault();
}

// Whether CLAP "sounds-like" audio embeddings are *wanted* — env
// ANALYZE_AUDIO_EMBEDDING wins on, else settings.audio.embeddings. The audio
// twin of vocalActivityWanted(); /library/coverage feeds it into the per-dimension
// status enum so the panel doesn't have to re-derive the enable precedence.
export function audioEmbeddingWanted(): boolean {
  return audioBackfillDefault();
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
  // How many tracks got vocal-activity ranges this run (incl. instrumentals,
  // stored as []). 0 when vocal activity is off / demucs absent.
  vocalAnalyzed: number;
}

// Model label recorded in audio_embedding_meta for provenance. The worker owns
// the actual model; this is just what the controller stamps alongside the
// vectors it stores. Env-overridable so a model swap is self-documenting.
const AUDIO_MODEL_LABEL = process.env.CLAP_MODEL || 'laion-clap';

// Best-effort wrapper — a mood-scoring failure must never fail (or re-run) the
// analysis pass itself; the next pass simply retries the un-scored remainder.
async function scoreAudioMoods(): Promise<void> {
  try {
    await runAudioMoodPass();
  } catch (err: any) {
    console.error(`[audio-moods] pass failed (non-fatal): ${err?.message || err}`);
  }
}

export async function runAnalysisPass(opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
  if (!(await analyzer.isAvailable())) {
    console.log('[analyze] no analysis backend (tts-heavy sidecar / local librosa venv) — skipping');
    return { available: false, backend: 'none', analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  const backend = analyzer.backendLabel();
  logEvent('info', `Audio engine: ${backend}`);

  // Resolve the vocal (Demucs) decision up front: a --re-analyze that is NOT
  // redoing vocal preserves existing vocal_ranges rather than wiping them (they
  // wouldn't be rebuilt this pass). Only run vocal when the backend can actually
  // produce it (a sidecar without Demucs reports vocalActivityAvailable===false).
  const vocalWanted = opts.vocalBackfill ?? vocalBackfillDefault();
  const vocalBackfill = vocalWanted && analyzer.vocalActivityAvailable() !== false;

  // A re-scan re-analyse is scoped to the tracks that were ALREADY analysed —
  // snapshot them before the clear wipes the bpm marker. A raw --re-analyze
  // leaves reAnalyzeScope null and redoes the whole library (needsAnalysisIds
  // returns everything once the version markers are cleared).
  let reAnalyzeScope: string[] | null = null;
  if (opts.reAnalyze) {
    if (opts.rescan) reAnalyzeScope = db.analysedIds();
    db.clearAnalysis({ keepVocal: !vocalBackfill });
    console.log(
      `[analyze] --re-analyze: cleared existing analysis${vocalBackfill ? '' : ' (kept vocal ranges)'}` +
        (reAnalyzeScope ? ` — re-scan scope: ${reAnalyzeScope.length} already-analysed tracks` : ''),
    );
  }

  const cap = opts.limit && opts.limit > 0 ? opts.limit : undefined;
  const bpmIds = reAnalyzeScope
    ? (cap ? reAnalyzeScope.slice(0, cap) : reAnalyzeScope)
    : db.needsAnalysisIds(cap);
  let ids = bpmIds;

  // Audio backfill: also target already-analysed tracks that lack a CLAP audio
  // vector, so enabling embeddings on a previously-analysed library fills it in
  // without a full --re-analyze. Re-running analysis on these recomputes bpm/key
  // (same values, harmless) and stores the new audio vector from the same call.
  // `audioBackfill` stays the "CLAP wanted + producible" signal (drives the
  // per-track embed flag below); the widening is gated separately on
  // !reAnalyzeScope. A re-scan re-analyse already has a FIXED scope (the
  // previously-analysed set) and re-embeds CLAP for those via embed:true — so it
  // must NOT widen, or it'd pull the whole library back in (every track looks
  // vector-less right after the clear).
  // ...and ONLY when the backend can actually emit CLAP vectors. A lean sidecar
  // (WITH_CLAP=0) never fills the vector column, so widening would re-analyse
  // every already-analysed track on every run for a guaranteed no-vector — the
  // same churn the vocal gate below prevents. `false` = definitively not built
  // → skip; `null` (local backend / not yet probed) keeps today's behaviour.
  const audioWanted = opts.audioBackfill ?? audioBackfillDefault();
  const audioBackfill = audioWanted && analyzer.audioEmbeddingAvailable() !== false;
  if (audioBackfill && !reAnalyzeScope) {
    const seen = new Set(bpmIds);
    const audioIds = db.unanalysedAudioIds(cap).filter(id => !seen.has(id));
    ids = cap ? [...bpmIds, ...audioIds].slice(0, cap) : [...bpmIds, ...audioIds];
    if (audioIds.length > 0) {
      console.log(`[analyze] audio backfill: +${ids.length - bpmIds.length} already-analysed tracks missing an audio vector`);
    }
  } else if (audioWanted && !reAnalyzeScope) {
    console.log('[analyze] audio backfill skipped — backend has no CLAP (set ANALYZER_HEAVY=1 to enable sounds-like vectors)');
  }

  // Vocal backfill: same idea for tracks missing vocal-activity ranges. The
  // Demucs separation is the expensive part, so this only widens the scope when
  // the operator opted in (env/admin toggle); the `vocal:true` flag below then
  // forces the backend to run it for this pass.
  // ...but ONLY when the backend can actually produce vocal ranges. A sidecar
  // built without Demucs (WITH_DEMUCS=0) reports vocalActivityAvailable()===false;
  // its vocal column then stays NULL forever, so backfilling would re-scan the
  // WHOLE library on every run for a guaranteed no-op (the churn behind the
  // "275/7093" report). `false` = definitively not built → skip; `null` (local
  // backend / not yet probed) keeps today's behaviour. isAvailable() above has
  // already probed the sidecar, so the capability is current here.
  // (vocalWanted / vocalBackfill resolved up front — see the clear above.)
  // Widening is suppressed under a fixed re-scan scope for the same reason as
  // audio above; the per-track vocal:true flag below still re-runs Demucs for the
  // in-scope tracks, so vocal ranges are rebuilt without dragging in the remainder.
  if (vocalBackfill && !reAnalyzeScope) {
    const seen = new Set(ids);
    const vocalIds = db.needsVocalIds(cap).filter(id => !seen.has(id));
    const before = ids.length;
    ids = cap ? [...ids, ...vocalIds].slice(0, cap) : [...ids, ...vocalIds];
    if (ids.length > before) {
      console.log(`[analyze] vocal backfill: +${ids.length - before} tracks missing vocal-activity ranges`);
    }
  } else if (vocalWanted && !reAnalyzeScope) {
    // Only warn when widening was actually attempted (not under a fixed re-scan
    // scope, where the per-track vocal flag handles the rebuild and capability is
    // surfaced in the admin UI instead).
    console.log('[analyze] vocal backfill skipped — backend has no Demucs (build tts-heavy WITH_DEMUCS=1 to enable vocal ranges)');
  }

  if (ids.length === 0) {
    console.log('[analyze] nothing to analyse — all tracks current');
    // Audio-mood scoring can still have work (vectors from past passes that
    // predate the scorer, or a changed vocabulary) — run it before returning.
    await scoreAudioMoods();
    return { available: true, backend, analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  logEvent('info', `Analysing audio for ${ids.length.toLocaleString('en-GB')} tracks…`);
  reportProgress({ phase: 'analyze', label: 'Analysing audio', done: 0, total: ids.length });

  let analyzed = 0;
  let failed = 0;
  let audioEmbedded = 0;
  let vocalAnalyzed = 0;
  // Stamp the audio-embedding provenance row once, on the first vector written
  // this run. Cheap idempotent guard so we don't touch the meta table per track.
  let audioMetaStamped = false;
  const audioModelLabel = AUDIO_MODEL_LABEL;

  // One-ahead prefetch pipeline: the controller downloads track i+1's audio
  // (network) while the backend computes track i (CPU), so the two overlap.
  // The backend stays single-threaded — we only hide fetch latency. Each
  // download resolves to a temp path on the shared volume; on download failure
  // we fall back to the url path for that one id so it still gets analysed.
  // One-ahead prefetch, eagerly reduced to a SETTLED result so a rejection can
  // never float as an unhandled rejection in the window between kicking the
  // download off and awaiting it next iteration. downloadCapped now rejects on
  // every stale library entry (file missing on disk) — common — and Node's
  // default --unhandled-rejections=throw crashed the whole pass when a one-ahead
  // prefetch rejected during the previous track's compute window. The .then(_,_)
  // attaches handlers immediately, so the rejection is always owned.
  type Prefetch = Promise<{ path: string; complete: boolean } | { err: any }>;
  const prefetch = (songId: string): Prefetch =>
    analyzer.downloadCapped(songId).then((r) => r, (err) => ({ err }));
  const prefetchAudio = shouldPrefetchAnalyzerAudio(config.analyzer.handoff);
  let inflight: Prefetch | null = prefetchAudio && ids.length > 0 ? prefetch(ids[0]) : null;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const downloadPromise = inflight;
    // Kick off the NEXT download before awaiting this one's analysis so the
    // fetch overlaps the compute.
    inflight = prefetchAudio && i + 1 < ids.length ? prefetch(ids[i + 1]) : null;

    let localPath: string | null = null;
    let localComplete: boolean | undefined;
    try {
      const settled = downloadPromise ? await downloadPromise : null;
      if (settled && 'err' in settled) {
        const err: any = settled.err;
        // A non-audio response (stale library entry — file missing on disk) is
        // not retryable via the url path, so don't mask it behind the sidecar's
        // url fetch; let the per-track handler record the real reason.
        if (err instanceof analyzer.NonAudioResponseError) throw err;
        // Otherwise a transient fetch failure — fall back to the url path.
        console.error(`[analyze] ${id} prefetch failed (${err?.message || err}); using url path`);
        localPath = null;
      } else {
        localPath = settled?.path ?? null;
        localComplete = settled && 'complete' in settled ? settled.complete : undefined;
      }
      // embed:true makes the backend lazy-load CLAP even when its own env
      // doesn't have ANALYZE_AUDIO_EMBEDDING (the admin-toggle path); omitted
      // when audio is off so the backend keeps its env-driven default.
      const embed = audioBackfill ? true : undefined;
      // vocal:true forces the Demucs pass for this track (admin/backfill path),
      // mirroring embed; omitted when vocal activity is off.
      const vocal = vocalBackfill ? true : undefined;
      const a = localPath
        ? await analyzer.analyzePath(localPath, { embed, vocal, complete: localComplete })
        : await analyzer.analyze(id, { embed, vocal });
      db.upsertTrackAnalysis(id, {
        bpm: a.bpm,
        musicalKey: a.musicalKey,
        introMs: a.introMs,
        confidence: a.confidence,
        loudnessLufs: a.loudnessLufs,
        peakDb: a.peakDb,
        sections: a.sections,
        pace: a.paceCurve,
        beats: a.beats,
        bars: a.bars,
        keyRanges: a.keyRanges,
        vocalRanges: a.vocalRanges,
        outro: a.outro,
      });
      if (a.vocalRanges != null) vocalAnalyzed += 1;
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

  // Zero-shot audio moods over the vectors this pass (and past passes) wrote —
  // one CLAP text-tower round-trip + in-process cosines (music/audio-moods.ts).
  // No-ops in seconds when there's nothing new and skips cleanly on backends
  // without the text tower.
  await scoreAudioMoods();

  logEvent(
    'success',
    `Audio analysed — ${analyzed.toLocaleString('en-GB')} tracks` +
      (audioEmbedded > 0 ? `, ${audioEmbedded.toLocaleString('en-GB')} sounds-like` : '') +
      (vocalAnalyzed > 0 ? `, ${vocalAnalyzed.toLocaleString('en-GB')} vocal` : '') +
      (failed > 0 ? ` · ${failed.toLocaleString('en-GB')} failed` : ''),
  );
  return { available: true, backend, analyzed, failed, scope: ids.length, audioEmbedded, vocalAnalyzed };
}
