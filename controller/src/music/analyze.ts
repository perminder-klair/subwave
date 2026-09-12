// Acoustic-analysis pass — fills bpm / musical_key / intro_ms for tracks that
// lack them, resumably. Shared by the `npm run tag` phase and `npm run analyze`.
// The DSP lives in music/analyzer.ts; with no backend this is a clean no-op.

import { readFile, rm } from 'node:fs/promises';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import * as stemCacheStore from './stem-cache.js';
import * as subsonic from './source.js';
import * as settings from '../settings.js';
import { config } from '../config.js';
import { deriveVocalFromLyrics, clipRangesToTail, type LyricVocalResult } from './lyric-vocal.js';
import { runAudioMoodPass } from './audio-moods.js';
import { runPropagatedEnergyPass } from './propagated-energy.js';
import { reportProgress, makeEventLogger } from './tagger-progress.js';
import { quietGateDecision, type QuietState } from './analyze-quiet-pure.js';
import { dispatchAnalysis, type DispatchOutcome } from './analyze-dispatch.js';
import {
  analysisModeForTrack,
  backfillDecision,
  failureCountsAgainstTrack,
  SYSTEMIC_FAILURE_RUN,
} from './analyze-capability.js';
import { probeListenerCount } from '../broadcast/listeners.js';

// Status events for the panel, mirrored to the `[analyze] …` console line.
const logEvent = makeEventLogger('analyze');

export interface AnalyzeOptions {
  limit?: number;        // cap tracks this run (default: all that need it)
  reAnalyze?: boolean;   // drop existing analysis first, redo everything
  // Re-scan: --re-analyze redoes ONLY the already-analysed population (captured
  // before the clear), never the remainder. Off for the standalone entry point.
  rescan?: boolean;
  // Widen to tracks with bpm/key but no CLAP vector; defaults from
  // ANALYZE_AUDIO_EMBEDDING.
  audioBackfill?: boolean;
  // Widen to tracks with vocal_ranges_json NULL. Demucs is expensive and opt-in;
  // defaults from ANALYZE_VOCAL_ACTIVITY / settings.audio.vocalActivity.
  vocalBackfill?: boolean;
}

// Env wins ON, never off; else the admin toggle (settings.audio.embeddings).
function audioBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_AUDIO_EMBEDDING || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.embeddings === true;
  } catch {
    return false;
  }
}

// Same precedence as audio: env wins on, else settings.audio.vocalActivity.
function vocalBackfillDefault(): boolean {
  const v = (process.env.ANALYZE_VOCAL_ACTIVITY || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  try {
    return settings.get()?.audio?.vocalActivity === true;
  } catch {
    return false;
  }
}

// Read by /library/coverage to decide whether to show the vocal row (#646).
export function vocalActivityWanted(): boolean {
  return vocalBackfillDefault();
}

// The audio twin of vocalActivityWanted(), so the panel doesn't re-derive it.
export function audioEmbeddingWanted(): boolean {
  return audioBackfillDefault();
}

// Quiet-times gate (#1099) — same env-wins-on precedence as the toggles above,
// but re-read from DISK on every check so a mid-scan flip takes effect in both
// directions (#1102). Any parse failure falls back to the cached settings.
interface QuietConfig {
  enabled: boolean;
  minutes: number;
}

async function readQuietConfig(): Promise<QuietConfig> {
  const v = (process.env.ANALYZE_QUIET_ONLY || '').toLowerCase();
  const envOn = v === '1' || v === 'true' || v === 'yes';
  let enabled = envOn;
  let minutes = 10;
  let audio: any = null;
  try {
    audio = JSON.parse(await readFile(`${config.stateDir}/settings.json`, 'utf8'))?.audio;
  } catch {
    try {
      audio = settings.get()?.audio;
    } catch {
      audio = null;
    }
  }
  if (!enabled) enabled = audio?.analyzeQuietOnly === true;
  const m = audio?.analyzeQuietMinutes;
  if (Number.isFinite(m) && m >= 1 && m <= 120) minutes = Math.floor(m);
  return { enabled, minutes };
}

// How often the paused pass re-checks Icecast (one status fetch, no history).
const QUIET_POLL_MS = 30_000;

interface QuietGate {
  state: QuietState;
  paused: boolean; // for one-per-transition logging, not decision logic
}

// Block until the gate allows the next track. Sits BETWEEN tracks, so only the
// next compute waits. Unbounded by design (Stop button / admin toggle).
async function waitForQuiet(gate: QuietGate, progress: { done: number; total: number }): Promise<void> {
  for (;;) {
    const quiet = await readQuietConfig();
    // Skip the probe while off; the pure helper still resets the quiet clock.
    const count = quiet.enabled ? await probeListenerCount() : null;
    const d = quietGateDecision(gate.state, {
      enabled: quiet.enabled,
      count,
      now: Date.now(),
      quietAfterMs: quiet.minutes * 60_000,
    });
    gate.state = d.state;
    if (d.proceed) {
      if (gate.paused) {
        gate.paused = false;
        logEvent('info', 'Stream is quiet — resuming analysis');
        // The per-track reporter only fires every 25 tracks, so restore now.
        reportProgress({ phase: 'analyze', label: 'Analysing audio', done: progress.done, total: progress.total });
      }
      return;
    }
    // An unknown count never reaches here: the gate fails open.
    const why = count && count > 0 ? `${count} listening` : 'waiting out the quiet window';
    if (!gate.paused) {
      gate.paused = true;
      logEvent(
        'info',
        `Analysis paused — ${why}; resumes after ${quiet.minutes} min with no listeners`,
      );
    }
    reportProgress({
      phase: 'analyze',
      label: `Waiting for quiet (${why})`,
      done: progress.done,
      total: progress.total,
    });
    await new Promise((r) => setTimeout(r, QUIET_POLL_MS));
  }
}

export interface AnalyzeStats {
  available: boolean;
  backend: string;
  analyzed: number;
  failed: number;
  scope: number;
  // 0 when the backend has no CLAP model loaded.
  audioEmbedded: number;
  // Includes instrumentals (stored as []). 0 when off or demucs is absent.
  vocalAnalyzed: number;
}

// Provenance label stamped into audio_embedding_meta; the worker owns the model.
const AUDIO_MODEL_LABEL = process.env.CLAP_MODEL || 'laion-clap';

// Best-effort: a mood failure must never fail the pass; the next one retries.
async function scoreAudioMoods(): Promise<void> {
  try {
    await runAudioMoodPass();
  } catch (err: any) {
    console.error(`[audio-moods] pass failed (non-fatal): ${err?.message || err}`);
  }
  // Must run AFTER the mood pass, which writes the cosines it calibrates
  // against. Separately wrapped so a failure here doesn't cost the mood labels.
  try {
    runPropagatedEnergyPass();
  } catch (err: any) {
    console.error(`[audio-energy] pass failed (non-fatal): ${err?.message || err}`);
  }
}

export async function runAnalysisPass(opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
  if (!(await analyzer.isAvailable())) {
    // The only two things resolveBackend() consults, named by their env vars.
    console.log('[analyze] no analysis backend (ANALYZE_URL sidecar / ANALYZE_PYTHON venv) — skipping');
    return { available: false, backend: 'none', analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  const backend = analyzer.backendLabel();
  logEvent('info', `Audio engine: ${backend}`);

  // Resolved up front so a --re-analyze not redoing vocal preserves existing
  // vocal_ranges rather than wiping what it won't rebuild.
  const vocalWanted = opts.vocalBackfill ?? vocalBackfillDefault();
  const vocalDecision = backfillDecision({
    dimension: 'vocal',
    wanted: vocalWanted,
    capable: analyzer.vocalActivityAvailable(),
    error: analyzer.vocalActivityError(),
    backend,
  });
  const vocalBackfill = vocalDecision.widen;
  // Stem cache: shares Demucs' separation with vocal detection, so the spend is
  // disk, LRU-swept below. Same three-way capability question as audio/vocal.
  const stemDecision = backfillDecision({
    dimension: 'stem',
    wanted: settings.get()?.audio?.stemCache === true,
    capable: analyzer.vocalActivityAvailable(),
    error: analyzer.vocalActivityError(),
    backend,
  });
  const stemCache = stemDecision.widen;

  // Snapshot the already-analysed ids BEFORE the clear wipes the bpm marker.
  // A raw --re-analyze leaves the scope null and redoes the whole library.
  let reAnalyzeScope: string[] | null = null;
  if (opts.reAnalyze) {
    if (opts.rescan) reAnalyzeScope = db.analysedIds();
    db.clearAnalysis({ keepVocal: !vocalBackfill, clearStems: stemCache });
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

  // Audio backfill: also target analysed tracks lacking a CLAP vector, so
  // embeddings fill in without a full --re-analyze. Two gates: never under a
  // fixed re-scan scope, and only when the backend can emit CLAP vectors
  // (`null`, meaning unknown, still widens).
  const audioWanted = opts.audioBackfill ?? audioBackfillDefault();
  const audioDecision = backfillDecision({
    dimension: 'audio',
    wanted: audioWanted,
    capable: analyzer.audioEmbeddingAvailable(),
    error: analyzer.audioEmbeddingError(),
    backend,
  });
  const audioBackfill = audioDecision.widen;
  if (audioBackfill && !reAnalyzeScope) {
    const seen = new Set(bpmIds);
    const audioIds = db.unanalysedAudioIds(cap).filter(id => !seen.has(id));
    ids = cap ? [...bpmIds, ...audioIds].slice(0, cap) : [...bpmIds, ...audioIds];
    if (audioIds.length > 0) {
      console.log(`[analyze] audio backfill: +${ids.length - bpmIds.length} already-analysed tracks missing an audio vector`);
    }
  } else if (audioDecision.notice && !reAnalyzeScope) {
    // Warn on a broken model (operator-clearable), info when it was never built.
    logEvent(analyzer.audioEmbeddingError() ? 'warning' : 'info', audioDecision.notice);
  }

  // Vocal backfill: same idea, same two gates, for tracks missing vocal-activity
  // ranges. Tail widening also re-targets tracks whose outro predates tail vocal
  // detection, only on an explicit `=== true` — old sidecars never report the
  // flag and a stale image must keep the head-only scope.
  const includeTailMissing = analyzer.tailVocalAvailable() === true;
  if (vocalBackfill && !reAnalyzeScope) {
    const seen = new Set(ids);
    const vocalIds = db.needsVocalIds(cap, includeTailMissing).filter(id => !seen.has(id));
    const before = ids.length;
    ids = cap ? [...ids, ...vocalIds].slice(0, cap) : [...ids, ...vocalIds];
    if (ids.length > before) {
      console.log(`[analyze] vocal backfill: +${ids.length - before} tracks missing vocal-activity ranges`);
    }
  } else if (vocalDecision.notice && !reAnalyzeScope) {
    // Only when widening was actually attempted.
    logEvent(analyzer.vocalActivityError() ? 'warning' : 'info', vocalDecision.notice);
  }

  // Stem backfill: the fourth widening. `stemCache` already carries the Demucs
  // gate; suppressed under a fixed re-scan scope like the others. Capped at what
  // the budget holds, and the cap is ANNOUNCED. That same headroom figure gates
  // EVERY stem write in the loop below (#1257), decremented per NET-NEW dir.
  let stemSlotsLeft = 0;
  let existingStemDirs: Set<string> = new Set();
  if (stemCache) {
    stemSlotsLeft = await stemCacheStore.headroomTracks();
    existingStemDirs = await stemCacheStore.cachedTrackIdSet();
  }
  if (stemCache && !reAnalyzeScope) {
    // The loop spends stemSlotsLeft in ids order and the earlier widenings'
    // tracks run FIRST, draining slots before this slice is reached. Reserve
    // them up front, or the announcement over-promises.
    const reserved = ids.filter(id => !existingStemDirs.has(id)).length;
    const backfillSlots = Math.max(0, stemSlotsLeft - reserved);
    if (backfillSlots <= 0) {
      console.log(
        stemSlotsLeft <= 0
          ? `[analyze] stem backfill skipped — cache is at its ${settings.get()?.audio?.stemCacheGb ?? 15} GB budget ` +
              '(raise it in Settings → Transitions to cache more tracks)'
          : `[analyze] stem backfill skipped — the ${reserved} ride-along stem writes already queued this pass ` +
              `claim the budget's remaining ~${stemSlotsLeft} track slots`,
      );
    } else {
      const seen = new Set(ids);
      // Priority-ordered (#1622 FR 14): the budget always binds on a real
      // library, so this slice IS which tracks ever get stems. The ranking and
      // the never-starve reasoning live in music/stem-priority.ts; the like
      // signals it reads are resolved here because library-db must not import
      // the likes store.
      const needing = db.needsStemsIds(undefined, stemCacheStore.likeSignals())
        .filter(id => !seen.has(id));
      // Under --limit, only the slots the bpm/CLAP/vocal scopes haven't already
      // spent are available — sizing off the raw cap would log stem tracks a
      // final slice then silently drops, the exact "reads as finished"
      // truncation the announcement exists to avoid.
      const room = cap ? Math.min(Math.max(0, cap - ids.length), backfillSlots) : backfillSlots;
      const stemIds = needing.slice(0, room);
      if (stemIds.length > 0) {
        ids = [...ids, ...stemIds];
        const left = needing.length - stemIds.length;
        console.log(
          `[analyze] stem backfill: +${stemIds.length} tracks with no cached stems` +
            (left > 0 ? ` (${left} left for later passes — budget holds ~${backfillSlots} more)` : ''),
        );
      }
    }
  } else if (stemDecision.notice && !reAnalyzeScope) {
    // Same warn/info split as audio and vocal above.
    logEvent(analyzer.vocalActivityError() ? 'warning' : 'info', stemDecision.notice);
  }

  // Only ids pulled in solely by the CLAP widening may take the fast path;
  // vocal and stem work applies to every id, so those runs stay full.
  const fullAnalysisIds = new Set(bpmIds);
  if (vocalBackfill || stemCache) {
    for (const id of ids) fullAnalysisIds.add(id);
  }

  // Say what the scope leaves out: "all tracks current" is also true of a
  // library whose files can never be analysed.
  const excludedFailures = db.analysisFailedCount();
  if (excludedFailures > 0) {
    logEvent(
      'warning',
      `${excludedFailures} track${excludedFailures === 1 ? '' : 's'} excluded after ` +
        `${db.MAX_ANALYSIS_FAILURES} failed attempts — see Library → analysis failures for the reasons`,
    );
  }

  if (ids.length === 0) {
    console.log('[analyze] nothing to analyse — all tracks current');
    // Mood scoring can still have work (older vectors, changed vocabulary).
    await scoreAudioMoods();
    return { available: true, backend, analyzed: 0, failed: 0, scope: 0, audioEmbedded: 0, vocalAnalyzed: 0 };
  }
  logEvent('info', `Analysing audio for ${ids.length.toLocaleString('en-GB')} tracks…`);
  reportProgress({ phase: 'analyze', label: 'Analysing audio', done: 0, total: ids.length });

  let analyzed = 0;
  let failed = 0;
  let orderedDone = 0;
  // Failures since the last success in THIS pass: bad file vs bad pass.
  let consecutiveFailures = 0;
  // Failure stamps held back until the pass proves it may hand them out: a
  // success flushes the buffer, the systemic guard tripping discards it.
  let pendingFailureStamps: Array<{ id: string; reason: string }> = [];
  const flushFailureStamps = () => {
    for (const f of pendingFailureStamps) {
      try {
        db.recordAnalysisFailure(f.id, f.reason);
      } catch (stampErr: any) {
        // Never let bookkeeping end the pass.
        console.error(`[analyze] ${f.id} failure stamp failed: ${stampErr?.message || stampErr}`);
      }
    }
    pendingFailureStamps = [];
  };
  let audioEmbedded = 0;
  let vocalAnalyzed = 0;
  // Only the quiet-clock state lives here, so it carries across tracks.
  const quietGate: QuietGate = { state: { quietSince: null }, paused: false };
  {
    const quiet = await readQuietConfig();
    if (quiet.enabled) {
      logEvent(
        'info',
        `Quiet-times gate on — analysis only runs once the stream has had no listeners for ${quiet.minutes} min`,
      );
    }
  }
  // Stamp the provenance row once, on the first vector written this run.
  let audioMetaStamped = false;
  const audioModelLabel = AUDIO_MODEL_LABEL;
  // One announcement when the stem budget gate first closes mid-pass.
  let stemGateAnnounced = false;

  // Concurrent sidecar jobs stage only AFTER admission, so a quiet-time pause
  // never keeps downloading work that has not started.
  type Prefetch = Promise<{ path: string; complete: boolean } | { err: any }>;
  const prefetch = (songId: string): Prefetch =>
    analyzer.downloadCapped(songId).then((r) => r, (err) => ({ err }));

  interface TrackWorkResult {
    audioEmbedded: boolean;
    vocalAnalyzed: boolean;
  }

  const allocateStems = (id: string): string | undefined => {
    const trackStemDecision = stemCacheStore.stemWriteDecision({
      cacheOn: stemCache,
      slotsLeft: stemSlotsLeft,
      hasExistingDir: existingStemDirs.has(id),
    });
    if (trackStemDecision.consumesSlot) stemSlotsLeft -= 1;
    if (stemCache && !trackStemDecision.want && !stemGateAnnounced) {
      stemGateAnnounced = true;
      console.log(
        `[analyze] stem cache budget reached mid-pass — stems skipped for the remaining net-new tracks ` +
          '(raise audio.stemCacheGb in Settings → Transitions to cache more)',
      );
    }
    return trackStemDecision.want ? stemCacheStore.dirFor(id) : undefined;
  };

  const runTrack = async (
    id: string,
    index: number,
    downloadPromise?: Prefetch,
    admittedStems?: { dir: string | undefined },
  ): Promise<TrackWorkResult> => {
    const embeddingOnly = analysisModeForTrack(id, fullAnalysisIds, audioBackfill) === 'embedding-only';
    let localPath: string | null = null;
    let localComplete: boolean | undefined;

    try {
      const settled = await (downloadPromise ?? prefetch(id));
      if ('err' in settled) {
        const err: any = settled.err;
        // A non-audio response (stale library entry) is not retryable by url.
        if (err instanceof analyzer.NonAudioResponseError) throw err;
        // Otherwise a transient fetch failure — fall back to the url path.
        console.error(`[analyze] ${id} prefetch failed (${err?.message || err}); using url path`);
      } else {
        localPath = settled.path;
        localComplete = settled.complete;
      }
      // embed:true lazy-loads CLAP on the backend; omitted when audio is off so
      // it keeps its env-driven default.
      const embed = audioBackfill ? true : undefined;
      // Lyric-first vocal ranges (#1125), before spending a Demucs separation.
      let lyricVocal: LyricVocalResult | null = null;
      if (vocalBackfill) {
        try {
          lyricVocal = deriveVocalFromLyrics(await subsonic.getStructuredLyrics(id));
        } catch {
          lyricVocal = null;
        }
      }
      // The concurrent path reserved headroom at admission; serial spends here.
      const stems_dir = admittedStems ? admittedStems.dir : allocateStems(id);
      // A lyric-decided track skips Demucs unless stem caching needs it anyway.
      const vocal = vocalBackfill ? (lyricVocal && !stems_dir ? false : true) : undefined;
      const a = localPath
        ? await analyzer.analyzePathWithUrlFallback(id, localPath, {
            embed,
            vocal,
            complete: localComplete,
            stems_dir,
            embedding_only: embeddingOnly || undefined,
          })
        : await analyzer.analyze(id, {
            embed,
            vocal,
            stems_dir,
            embedding_only: embeddingOnly || undefined,
          });
      let storedVocal = false;
      if (!embeddingOnly) {
        // Lyrics win over the worker's vocal output: a synced onset beats the
        // energy heuristic the worker returns once Demucs is skipped.
        const vocalRanges = lyricVocal ? lyricVocal.vocalRanges : a.vocalRanges;
        let outro = a.outro;
        if (lyricVocal && outro) {
          const durMs = (Number(db.getTrack(id)?.durationSec) || 0) * 1000;
          const windowStartMs = durMs > 0 ? Math.min(outro.startMs, durMs - 20_000) : outro.startMs;
          outro = {
            ...outro,
            vocalRanges: clipRangesToTail(lyricVocal.vocalRanges, windowStartMs, durMs > 0 ? durMs : null),
          };
        }
        db.upsertTrackAnalysis(id, {
          bpm: a.bpm,
          musicalKey: a.musicalKey,
          introMs: lyricVocal?.introMs != null ? lyricVocal.introMs : a.introMs,
          confidence: a.confidence,
          loudnessLufs: a.loudnessLufs,
          peakDb: a.peakDb,
          sections: a.sections,
          pace: a.paceCurve,
          beats: a.beats,
          bars: a.bars,
          keyRanges: a.keyRanges,
          vocalRanges,
          outro,
          leadSilenceMs: a.leadSilenceMs,
          tailSilenceMs: a.tailSilenceMs,
          tailStartMs: a.tailStartMs,
          stemsAttempted: a.stemsCached !== null,
        });
        storedVocal = vocalRanges != null;
        // Surface the tail-vocal stuck case rather than retargeting it forever.
        if (a.outro == null && (lyricVocal != null || (vocal && a.vocalRanges != null))) {
          const prior = db.getTrack(id);
          if (prior?.outro && prior.outro.vocalRanges == null) {
            console.log(`[analyze] ${id}: tail vocals not computable (incomplete download; stored outro predates tail detection) — stays in the vocal backfill scope`);
          }
        }
      }
      let storedAudio = false;
      if (a.audioEmbedding && a.audioEmbedding.length === db.AUDIO_EMBEDDING_DIM) {
        try {
          db.upsertTrackAudioVector(id, a.audioEmbedding);
          if (!audioMetaStamped) {
            db.setAudioEmbeddingMeta(audioModelLabel, db.AUDIO_EMBEDDING_DIM);
            audioMetaStamped = true;
          }
          storedAudio = true;
        } catch (err: any) {
          console.error(`[analyze] ${id} audio-vector write failed: ${err?.message || err}`);
        }
      }
      return { audioEmbedded: storedAudio, vocalAnalyzed: storedVocal };
    } finally {
      // Best-effort, regardless of outcome.
      if (localPath) await rm(localPath, { force: true }).catch(() => {});
    }
  };

  const commitOutcome = async (
    outcome: DispatchOutcome<TrackWorkResult>,
    id: string,
    index: number,
  ): Promise<void> => {
    if (outcome.status === 'fulfilled') {
      analyzed += 1;
      if (outcome.value.audioEmbedded) audioEmbedded += 1;
      if (outcome.value.vocalAnalyzed) vocalAnalyzed += 1;
      // A success proves the buffered failures were about their files.
      flushFailureStamps();
      consecutiveFailures = 0;
    } else {
      failed += 1;
      consecutiveFailures += 1;
      const err: any = outcome.reason;
      const reason = String(err?.message || err);
      console.error(`[analyze] ${id} failed: ${reason}`);
      if (failureCountsAgainstTrack(consecutiveFailures)) {
        pendingFailureStamps.push({ id, reason });
      } else if (consecutiveFailures === SYSTEMIC_FAILURE_RUN + 1) {
        logEvent(
          'warning',
          `${SYSTEMIC_FAILURE_RUN + 1} tracks in a row failed to analyse — treating this as a fault ` +
            'in the pass rather than the files (is the music backend reachable?), so these failures ' +
            'are not counted against any track until one analyses successfully again',
        );
        pendingFailureStamps = [];
      }
    }
    const done = index + 1;
    orderedDone = done;
    if (done % 25 === 0 || done === ids.length) {
      console.log(`[analyze] ${done}/${ids.length} (ok=${analyzed} fail=${failed})`);
      reportProgress({
        phase: 'analyze',
        label: 'Analysing audio',
        done,
        total: ids.length,
        errors: failed || undefined,
      });
    }
  };

  const requestedConcurrency = config.analyzer.concurrency;
  const effectiveConcurrency = backend === 'sidecar' ? requestedConcurrency : 1;
  if (backend === 'local' && requestedConcurrency > 1) {
    logEvent(
      'info',
      `ANALYZE_CONCURRENCY=${requestedConcurrency} applies to HTTP sidecars; local ANALYZE_PYTHON remains single-flight`,
    );
  }

  if (effectiveConcurrency === 1) {
    // One-ahead prefetch, rejections settled immediately so none floats as an
    // unhandled rejection during the compute window.
    let inflight: Prefetch | null = prefetch(ids[0]);
    for (let i = 0; i < ids.length; i++) {
      await waitForQuiet(quietGate, { done: i, total: ids.length });
      const current = inflight;
      inflight = i + 1 < ids.length ? prefetch(ids[i + 1]) : null;
      let outcome: DispatchOutcome<TrackWorkResult>;
      try {
        outcome = { status: 'fulfilled', value: await runTrack(ids[i], i, current ?? undefined) };
      } catch (reason) {
        outcome = { status: 'rejected', reason };
      }
      await commitOutcome(outcome, ids[i], i);
    }
  } else {
    logEvent('info', `Analyzer concurrency: ${effectiveConcurrency} in-flight sidecar jobs`);
    const admittedStems = new Map<number, { dir: string | undefined }>();
    await dispatchAnalysis(ids, {
      concurrency: effectiveConcurrency,
      beforeStart: async (index) => {
        await waitForQuiet(quietGate, { done: orderedDone, total: ids.length });
        // Reserve the pass-wide stem budget in source order, before the race.
        admittedStems.set(index, { dir: allocateStems(ids[index]) });
      },
      run: (id, index) => runTrack(id, index, undefined, admittedStems.get(index)),
      onOutcome: (outcome, id, index) => {
        admittedStems.delete(index);
        return commitOutcome(outcome, id, index);
      },
    });
  }

  // A trailing failure run shorter than the systemic threshold never met a
  // success, but nothing proved the pass unhealthy either, so those stamps land.
  flushFailureStamps();

  // Best-effort sweep of the staging dir in case a prefetch left an orphan.
  await rm(`${config.stateRoot}/analyze-tmp`, { recursive: true, force: true }).catch(() => {});

  // Keep the stem cache inside the operator's byte budget after a pass that
  // may have written hundreds of new stem dirs (lowest stem-priority first —
  // NOT oldest first, or this pass's best writes would be the first evicted;
  // the hourly cleanup cron sweeps too, this just settles the bill promptly).
  if (stemCache) {
    const swept = await stemCacheStore.sweep().catch(() => null);
    if (swept && swept.removed > 0) {
      console.log(`[analyze] stem cache sweep: evicted ${swept.removed} track dirs (${Math.round(swept.freedBytes / 1024 ** 2)} MB)`);
    }
    // The only place a stuck-over-budget cache reaches the event log (#1257).
    if (swept && swept.overBudgetBytes > 0) {
      logEvent(
        'warning',
        `Stem cache is ${(swept.overBudgetBytes / 1024 ** 3).toFixed(1)} GB over its ${settings.get()?.audio?.stemCacheGb ?? 15} GB budget and the sweep could not evict down to it` +
          (swept.failedDirs ? ` (${swept.failedDirs} dir delete(s) failed — check ownership/permissions on state/stems)` : ''),
      );
    }
  }

  // Zero-shot audio moods over the vectors this and past passes wrote; no-op
  // when there is nothing new or the backend has no text tower.
  await scoreAudioMoods();

  // The worker degrades silently when Demucs fails to load: every track reads
  // "ok" with vocal_ranges omitted, re-targeting the same tracks forever (#996).
  if (vocalBackfill && analyzed > 0 && vocalAnalyzed === 0) {
    logEvent(
      'warning',
      'Vocal backfill stored no vocal-activity ranges — Demucs likely failed to load at runtime; check the analyzer container logs for "Demucs load failed"',
    );
  }

  logEvent(
    'success',
    `Audio analysed — ${analyzed.toLocaleString('en-GB')} tracks` +
      (audioEmbedded > 0 ? `, ${audioEmbedded.toLocaleString('en-GB')} sounds-like` : '') +
      (vocalAnalyzed > 0 ? `, ${vocalAnalyzed.toLocaleString('en-GB')} vocal` : '') +
      (failed > 0 ? ` · ${failed.toLocaleString('en-GB')} failed` : ''),
  );
  return { available: true, backend, analyzed, failed, scope: ids.length, audioEmbedded, vocalAnalyzed };
}
