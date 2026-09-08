'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { Sparkles, Activity, Play, Square, Terminal, Loader2, Moon, RefreshCw } from 'lucide-react';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { relTime } from '../../lib/format';
import { Btn, Eyebrow } from './ui';
import { Input } from '../ui/input';
import { cn } from '../../lib/cn';
import LibraryTaggingModal from './LibraryTaggingModal';
import SceneVocabSection from './library/SceneVocabSection';

export interface Coverage {
  tagged: number;
  analysed: number;
  // Tracks with a CLAP audio (sounds-like) embedding. Gated on ANALYZE_AUDIO_EMBEDDING.
  audioEmbedded?: number;
  // Tracks with Demucs vocal-activity ranges. Only surfaced when vocalWanted (#646).
  vocalAnalyzed?: number;
  total: number | null;
  percent: number | null;
  analysedPercent: number | null;
  audioEmbeddedPercent?: number | null;
  vocalAnalyzedPercent?: number | null;
  // Vocal analysis wanted via env ANALYZE_VOCAL_ACTIVITY or settings.audio.vocalActivity.
  vocalWanted?: boolean;
  scannedAt: string | null;
  scanning: boolean;
  // Why the last count failed; null = it worked, or none has run. Optional so an older controller reads as "no failure".
  scanError?: string | null;
  // null = still probing; false = no analysis backend (sidecar/librosa) running.
  analysisAvailable?: boolean | null;
  analysisBackend?: string | null;
  // false = engine up but on an image without the CLAP stack; null = still probing.
  audioAnalysisAvailable?: boolean | null;
  // Audio vectors stored + CLAP text tower not reported absent. Absent on old controllers.
  soundSearchAvailable?: boolean;
  // false = engine up but built without Demucs (WITH_DEMUCS=0).
  vocalAnalysisAvailable?: boolean | null;
  // `embeddingStale` = the library was embedded with a different model than the one configured; a tag run is BLOCKED until a re-embed.
  embeddedModel?: string | null;
  embeddedDim?: number | null;
  currentEmbeddingModel?: string | null;
  embeddingStale?: boolean;
  // Embed-text SHAPE, separate from model staleness (#1246). Advisory only; never blocks a run.
  // `labelOnlyVectors` counts embedded tracks with NO musical signal in their text. Absent on old controllers.
  embeddingFormatStale?: boolean;
  embeddedTextFormat?: number | null;
  currentTextFormat?: number | null;
  embeddedVectors?: number | null;
  labelOnlyVectors?: number | null;
  // Why a capability is false when the model is INSTALLED and its load failed.
  // null/absent otherwise, including a lean image. Paired with the 'load-failed' status.
  audioAnalysisError?: string | null;
  vocalAnalysisError?: string | null;
  // Tracks dropped from every analysis scope after repeated failures.
  analysisFailed?: number;
  // Backend-computed (controller/src/music/coverage-status.ts): the single source of truth for the sounds-like + vocal rows.
  audioStatus?: DimensionStatus;
  vocalStatus?: DimensionStatus;
}

// Mirrors controller/src/music/coverage-status.ts.
export type DimensionStatus =
  | 'off'
  | 'pending-engine'
  | 'pending-heavy'
  | 'load-failed'
  | 'incapable'
  | 'ready'
  | 'partial'
  | 'complete';

// One row of GET /library/analysis-failures.
export interface AnalysisFailure {
  id: string;
  title: string | null;
  artist: string | null;
  error: string | null;
  failedAt: string | null;
  attempts: number;
  excluded: boolean;
}

// Mirrors controller/src/music/tagger-progress.ts.
export interface TaggerProgress {
  phase: 'walk' | 'enrich' | 'embed' | 'seed' | 'propagate' | 'learn' | 'analyze' | 'done';
  label: string;
  done?: number;
  total?: number; // absent → indeterminate (e.g. the Navidrome walk)
  round?: number; // active-learn round
  errors?: number;
  llm?: { legs: Record<string, number> };
  // Cumulative ms per phase, attached to the terminal 'done' event.
  timings?: Record<string, number>;
  updatedAt: string;
}

// Relayed from the tagger child. The child DECLARES what a line means, so the
// panel renders by kind rather than regex-scraping console strings.
export interface TaggerEvent {
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  at: string;
}

// Outcome of the last finished run. 'stopped' (Stop button / restart kill) shows nothing.
export interface TaggerLastRun {
  mode: 'tag' | 'analyze' | 'reconcile';
  outcome: 'ok' | 'failed' | 'stopped';
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface TaggerState {
  running?: boolean;
  pid?: number;
  startedAt?: string;
// Raw console lines interleaved with structured events, chronological. Capped at 100 server-side.
  lastLog?: (string | TaggerEvent)[];
  // All three run through the same single-flight child slot.
  mode?: 'tag' | 'analyze' | 'reconcile' | null;
  progress?: TaggerProgress | null;
  lastRun?: TaggerLastRun | null;
}

// Rides along on /settings, so it needs no extra request on any tab.
export interface LibraryStatsLite {
  total: number;
  byMood: Record<string, number>;
  byEnergy: Record<string, number>;
  byGenre: Record<string, number>;
  withEmbedding: number;
  updatedAt: string | null;
}

export type Batch = '100' | '500' | '5000' | '10000' | 'all';

// Mirrors controller/src/broadcast/dj-budget.ts.
export type BudgetMode = 'normal' | 'soft' | 'hard';

export type RescanOpts = {
  reseed?: boolean;
  reEnrich?: boolean;
  reAnalyze?: boolean;
  upgrade?: boolean;
  // false → --no-vocal (redo bpm/key + sounds-like, keep existing vocal ranges).
  vocal?: boolean;
  // After rebuilding vectors, forward-tag the untagged remainder in the same run. Only honoured when reseed is the sole pass.
  thenTag?: boolean;
};

// An unchecked box sends `false`, which the controller maps to a skip flag.
export type TagSteps = {
  reconcile: boolean;
  enrich: boolean;
  tagMoods: boolean;
  analyze: boolean;
  // Only honoured when analyze is on and vocal is enabled in settings.
  vocal: boolean;
};

export function num(n: number | null | undefined): string {
  return n != null ? n.toLocaleString('en-GB') : '—';
}

interface TaggingPanelProps {
  coverage: Coverage | null;
  libStats: LibraryStatsLite | null;
  tagger: TaggerState | null;
  batch: Batch;
  setBatch: (b: Batch) => void;
  busy: boolean;
  logOpen: boolean;
  setLogOpen: (fn: (o: boolean) => boolean) => void;
  onStart: (steps?: TagSteps) => void;
  onStop: () => void;
  onRescan: (opts: RescanOpts) => void;
  // Walk Navidrome and prune library entries for tracks that no longer exist.
  onReconcile: () => void;
  // Count the library — the only expensive read on this page, and the operator asks for it (#1570).
  onCountLibrary: () => void;
  countingLibrary: boolean;
  // Wipes ALL tagging data and starts fresh, behind a typed confirmation.
  onReset: () => void;
  // sounds-like (CLAP) controls — null until the first settings poll lands.
  audioEnabled: boolean | null;
  onToggleAudio: () => void;
  onAnalyzeAudio: () => void;
  // Vocal-activity (Demucs) controls — parallel to the sounds-like pair (#646).
  onToggleVocal: () => void;
  onVocalBackfill: () => void;
  // null until the first settings poll lands.
  vocalEnabled: boolean | null;
  // Quiet-times gate (#1099): analysis pauses while listeners are tuned in.
  quietEnabled: boolean | null;
  quietMinutes: number | null;
  onToggleQuiet: () => void;
  // Persist a new idle window (minutes, 1–120) — committed on blur/Enter.
  onQuietMinutes: (minutes: number) => void;
  // null until the first slow poll lands.
  budgetMode: BudgetMode | null;
  // Which provider the mood/energy LLM calls vs. the embedding calls bill to (#1162).
  llmLabel: string | null;
  embedLabel: string | null;
  // Per-track analysis failures. Fetched on demand rather than polled.
  failures: AnalysisFailure[] | null;
  onLoadFailures: () => void;
  onClearFailures: () => void;
}

const PHASE_HINT: Record<TaggerProgress['phase'], string> = {
  walk: 'Reading the track list from Navidrome.',
  enrich: 'Fetching Last.fm tags and lyrics that help the DJ understand each track.',
  embed: 'Computing similarity vectors so tags can spread between similar tracks.',
  seed: 'The DJ is deciding mood & energy for a representative set of tracks.',
  propagate: 'Spreading tags from tagged tracks to their closest sonic neighbours.',
  learn: 'The DJ is re-checking tracks the automatic spread wasn’t confident about.',
  analyze: 'Measuring tempo and key, and fingerprinting how each track sounds.',
  done: 'Wrapping up.',
};

// Keys match the tagger's timings map, which includes non-user-facing 'setup'/'walk'.
const PHASE_LABEL: Record<string, string> = {
  setup: 'setup',
  walk: 'scan',
  enrich: 'enrich',
  embed: 'embed',
  seed: 'seed-tag',
  propagate: 'spread',
  learn: 're-tag',
  analyze: 'acoustics',
};

// Execution order, used to decide which phases are behind/ahead of the live one. Excludes 'done'.
const PIPELINE: TaggerProgress['phase'][] = [
  'walk', 'enrich', 'embed', 'seed', 'propagate', 'learn', 'analyze',
];

// Only the phases a given run mode can reach.
function stepsForMode(mode: TaggerState['mode']): TaggerProgress['phase'][] {
  if (mode === 'analyze') return ['analyze'];
  if (mode === 'reconcile') return ['walk'];
  return PIPELINE;
}

// ms → compact "2m 5s" / "40s" for the breakdown line.
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

// Mirror of controller/src/music/coverage-status.ts `isBackfillable`.
function canBackfill(s: DimensionStatus | undefined): boolean {
  return (
    s != null &&
    s !== 'pending-heavy' &&
    s !== 'load-failed' &&
    s !== 'pending-engine' &&
    s !== 'complete'
  );
}

// Coarser than fmtDur: a live ETA wobbles, so round to 5s buckets under a minute, whole minutes above.
function fmtEta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${Math.max(5, Math.round(s / 5) * 5)}s left`;
  return `~${Math.round(s / 60)}m left`;
}

// Keyed on the kind the child declared; the friendly wording rides the event `text`.
const EVENT_STYLE: Record<TaggerEvent['kind'], { emoji: string; cls: string }> = {
  error: { emoji: '⚠️', cls: 'text-vermilion font-semibold' },
  warning: { emoji: '⚠', cls: 'text-vermilion' },
  success: { emoji: '✓', cls: 'text-emerald-500 font-semibold' },
  info: { emoji: '', cls: 'text-muted' },
};

// For the RAW (non-event) lines only: exit status and prefix-stripping.
function beautifyLog(raw: string): { text: string; cls: string } {
  if (/^\[exit 0\]/.test(raw))
    return { text: '✓  Finished', cls: 'text-emerald-500 font-semibold' };
  if (/^\[exit/.test(raw))
    return {
      text: `⏹  Stopped (${raw.replace(/^\[exit\s*|\]\s*$/g, '')})`,
      cls: 'text-vermilion font-semibold',
    };
  const s = raw.replace(/^\[(tag|analyze|stats|scheduler|error)\]\s*/, '');
  return { text: s, cls: 'text-muted' };
}

export default function TaggingPanel(p: TaggingPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [modalIntent, setModalIntent] = useState<'reembed' | null>(null);
  // Keyed on the run's finishedAt so a NEW failure re-shows the banner.
  const [dismissedFailAt, setDismissedFailAt] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const moodFillRef = useRef<HTMLSpanElement>(null);
  const acousticFillRef = useRef<HTMLSpanElement>(null);
  const audioFillRef = useRef<HTMLSpanElement>(null);
  const vocalFillRef = useRef<HTMLSpanElement>(null);
  const runFillRef = useRef<HTMLSpanElement>(null);
  // Pinned at phase entry so the rate is a stable phase-average; reset by the effect below.
  const etaRef = useRef<{ phase: string; round: number | null; done: number; at: number } | null>(null);

  const tagged = p.coverage?.tagged ?? p.libStats?.total ?? null;
  const total = p.coverage?.total ?? null;
  const analysed = p.coverage?.analysed ?? null;
  const audioEmbedded = p.coverage?.audioEmbedded ?? null;
  const vocalAnalyzed = p.coverage?.vocalAnalyzed ?? null;
  const pct = p.coverage?.percent ?? null;
  const apct = p.coverage?.analysedPercent ?? null;
  const audpct = p.coverage?.audioEmbeddedPercent ?? null;
  const vpct = p.coverage?.vocalAnalyzedPercent ?? null;
  // Audio embeddings only exist once at least one is written; until then the row reads "not enabled".
  const audioOn = (audioEmbedded ?? 0) > 0;
  // Backend resolves env-vs-settings precedence.
  const vocalWanted = p.coverage?.vocalWanted === true;
  // Drive the button + layout off the OPTIMISTIC settings prop so a toggle applies at once.
  const vocalOptedIn = p.vocalEnabled ?? vocalWanted;

  // Out-of-range or unparsable values snap back to the persisted setting.
  const commitQuietMinutes = (el: HTMLInputElement) => {
    const v = Math.floor(Number(el.value));
    if (!Number.isFinite(v) || v < 1 || v > 120) {
      el.value = String(p.quietMinutes ?? 10);
      return;
    }
    if (v !== p.quietMinutes) p.onQuietMinutes(v);
  };
  const vocalOn = (vocalAnalyzed ?? 0) > 0;
  // On a virgin library the per-dimension Backfill buttons stay hidden.
  const anyWorkDone = (tagged ?? 0) > 0 || (analysed ?? 0) > 0 || audioOn || vocalOn;
  const remaining = total != null && tagged != null ? Math.max(0, total - tagged) : null;
  const running = !!p.tagger?.running;
  const scanning = !!p.coverage?.scanning;
  // A first count still in flight: `total` is null but a number is coming.
  const awaitingFirstCount = scanning && total == null;
  // `total` is the ONE figure here that isn't live: it is the last count.
  const countedAt = p.coverage?.scannedAt ?? null;
  const countLabel = scanning ? 'Counting…' : countedAt ? 'Re-count' : 'Count library';
  // A count that FAILED is not a count that never happened, so say so.
  const countError = !scanning ? (p.coverage?.scanError ?? null) : null;
  const analysisOff = p.coverage?.analysisAvailable === false;
  // 'pending-heavy' = lean/older engine that can't do this dimension.
  const audioStatus = p.coverage?.audioStatus;
  const vocalStatus = p.coverage?.vocalStatus;

  // How you GET the heavy analyzer depends on the backend.
  const analyzerIsLocal = p.coverage?.analysisBackend === 'local';
  const heavyUpgradeShort = analyzerIsLocal
    ? 'Needs the heavy build (subwave-aio-heavy, or heavy Python deps on a dev venv).'
    : 'Needs the heavy analyzer (ANALYZER_HEAVY=1).';
  const heavyUpgradeBox = analyzerIsLocal ? (
    <>
      On the all-in-one image, switch this container&rsquo;s image to{' '}
      <code>ghcr.io/perminder-klair/subwave-aio-heavy</code> (or{' '}
      <code>-aio-cuda</code> on an NVIDIA host) and recreate it; on a dev{' '}
      <code>ANALYZE_PYTHON</code> venv, install the heavy Python deps. Analysis
      then kicks in automatically, nothing to re-enable here.{' '}
      <b>
        <code>ANALYZER_HEAVY</code> does nothing here
      </b>{' '}
      — it is a docker-compose setting that picks the analyzer service&rsquo;s
      image, and there is no analyzer service on this backend. The heavy image is
      amd64-only.
    </>
  ) : (
    <>
      Set <code>ANALYZER_HEAVY=1</code> in <code>.env</code> and recreate the
      analyzer (<code>docker compose up -d analyzer</code>) — analysis then kicks
      in automatically, nothing to re-enable here. The heavy image is amd64-only.
    </>
  );

  // For a model that IS installed and failed to load, distinct from 'pending-heavy'.
  const restartHint =
    p.coverage?.analysisBackend === 'sidecar'
      ? 'restart the analyzer'
      : analyzerIsLocal
        ? 'restart the controller (this install runs the analyzer in-process — there is no separate analyzer to restart)'
        : 'restart the analyzer, or the controller if it runs the analyzer in-process';
  const loadFailure = p.coverage?.audioAnalysisError
    ? { model: 'CLAP', what: 'sounds-like fingerprinting', error: p.coverage.audioAnalysisError, restart: restartHint }
    : p.coverage?.vocalAnalysisError
      ? { model: 'Demucs', what: 'vocal separation', error: p.coverage.vocalAnalysisError, restart: restartHint }
      : null;
  // Tracks the analysis pass has given up on; the list behind it is fetched on demand.
  const failureCount = p.coverage?.analysisFailed ?? 0;
  const [failuresOpen, setFailuresOpen] = useState(false);

  // Forced open while a run is in flight; reverts to the manual choice when it finishes.
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const analysisRunning = !!p.tagger?.running && p.tagger?.mode === 'analyze';
  const showAnalysis = analysisOpen || analysisRunning;
  // One-line status so coverage stays glanceable while collapsed.
  const analysisSummary = analysisOff
    ? 'engine off'
    : [
        `bpm/key ${apct != null ? `${apct}%` : '…'}`,
        audioOn && audpct != null
          ? `sounds-like ${audpct}%`
          : p.audioEnabled
            ? (audioStatus === 'pending-heavy' ? 'sounds-like waiting' : 'sounds-like on')
            : 'sounds-like off',
        vocalOptedIn
          ? (vocalOn && vpct != null
              ? `vocal ${vpct}%`
              : vocalStatus === 'pending-heavy' ? 'vocal waiting' : 'vocal on')
          : 'vocal off',
      ].join(' · ');
  // A dim/model mismatch would fail the tag run, so this drives a blocking
  // one-click re-embed prompt rather than a cryptic tagger error.
  const embeddingStale = p.coverage?.embeddingStale === true;
  const moodCount = p.libStats ? Object.keys(p.libStats.byMood || {}).length : 0;
  const lastTag = p.libStats?.updatedAt
    ? new Date(p.libStats.updatedAt).toLocaleString('en-GB')
    : '—';

  // Embeddings present but no vectors → likely a model swap dropped them.
  const embeddingMissing =
    (tagged ?? 0) > 0 && p.libStats != null && p.libStats.withEmbedding === 0;

  // Similarity-signal advisory (#1246). Only shown when label-only dominates.
  const labelOnly = p.coverage?.labelOnlyVectors ?? null;
  const embeddedVectors = p.coverage?.embeddedVectors ?? null;
  const labelOnlyShare =
    labelOnly != null && embeddedVectors != null && embeddedVectors > 0
      ? labelOnly / embeddedVectors
      : null;
  const similarityThin = labelOnlyShare != null && labelOnlyShare >= 0.5;
  // An older text format only matters once there IS something better to embed.
  const embeddingFormatStale =
    p.coverage?.embeddingFormatStale === true &&
    labelOnlyShare != null &&
    labelOnlyShare < 1;

  // Comes from the tagger child, so it survives page reloads and runs started elsewhere.
  const progress = running ? (p.tagger?.progress ?? null) : null;
  const runPct = progress?.total
    ? Math.min(100, Math.round(((progress.done ?? 0) / progress.total) * 100))
    : null;
  const runIndeterminate = !!progress && progress.total == null && progress.phase !== 'done';
  const legEntries = progress?.llm ? Object.entries(progress.llm.legs) : [];

  // Each stage is done/active/pending by its position relative to the live phase.
  const stepList = progress
    ? (() => {
        const curIdx =
          progress.phase === 'done' ? PIPELINE.length : PIPELINE.indexOf(progress.phase);
        return stepsForMode(p.tagger?.mode).map(ph => {
          const i = PIPELINE.indexOf(ph);
          const state = curIdx > i ? 'done' : curIdx === i ? 'active' : 'pending';
          return { ph, state } as const;
        });
      })()
    : [];

  // In state, not a render-time derivation, because it needs Date.now().
  const [etaMs, setEtaMs] = useState<number | null>(null);
  // Re-pin the baseline whenever the phase or active-learn round changes.
  useEffect(() => {
    if (!progress || progress.phase === 'done') {
      etaRef.current = null;
      setEtaMs(null);
      return;
    }
    const b = etaRef.current;
    if (!b || b.phase !== progress.phase || b.round !== (progress.round ?? null)) {
      // Fresh phase — hold off on an estimate until the next poll gives a rate.
      etaRef.current = {
        phase: progress.phase,
        round: progress.round ?? null,
        done: progress.done ?? 0,
        at: Date.now(),
      };
      setEtaMs(null);
      return;
    }
    if (progress.total == null || progress.done == null) {
      setEtaMs(null);
      return;
    }
    const elapsed = Date.now() - b.at;
    const advanced = progress.done - b.done;
    const remaining = progress.total - progress.done;
    setEtaMs(
      elapsed >= 10_000 && advanced > 0 && remaining > 0
        ? (remaining / advanced) * elapsed
        : null,
    );
  }, [progress]);

  // broadcast/tagger.ts keeps the child's final 'done' event post-exit.
  const lastTimings =
    !running && p.tagger?.progress?.phase === 'done' ? p.tagger.progress.timings : undefined;
  const lastTimingEntries = lastTimings
    ? Object.entries(lastTimings)
        .filter(([, ms]) => ms > 0)
        .sort((a, b) => b[1] - a[1])
    : [];

  // A signal exit (Stop / restart-kill) is 'stopped' and shows nothing.
  const lastRun = p.tagger?.lastRun ?? null;
  const showFailBanner =
    !running && lastRun?.outcome === 'failed' && lastRun.finishedAt !== dismissedFailAt;
  const failModeLabel =
    lastRun?.mode === 'analyze' ? 'analysis' : lastRun?.mode === 'reconcile' ? 'reconcile' : 'tagging';

  useDynamicStyle(moodFillRef, { width: pct != null ? `${Math.min(100, pct)}%` : '0%' });
  useDynamicStyle(acousticFillRef, {
    width: !analysisOff && apct != null ? `${Math.min(100, apct)}%` : '0%',
  });
  useDynamicStyle(audioFillRef, {
    width: audioOn && audpct != null ? `${Math.min(100, audpct)}%` : '0%',
  });
  useDynamicStyle(vocalFillRef, {
    width: vocalOn && vpct != null ? `${Math.min(100, vpct)}%` : '0%',
  });
  useDynamicStyle(runFillRef, { width: runPct != null ? `${runPct}%` : null });

  useEffect(() => {
    if (p.logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [p.logOpen, p.tagger?.lastLog?.length]);

  const openModal = (intent: 'reembed' | null = null) => {
    setModalIntent(intent);
    setModalOpen(true);
  };

  return (
    <section className="card">
      <div className="border-b border-ink p-4 sm:p-6">
        <Eyebrow className="text-vermilion">library · tagging</Eyebrow>
        <h1 className="lib-hero-title">
          {pct != null ? (
            <>
              Your DJ knows <span className="pct mono-num">{pct}%</span> of your library.
            </>
          ) : (
            <>Manage the music your station plays.</>
          )}
        </h1>
        <p className="lib-hero-sub">
          The DJ reads each track&rsquo;s <b>mood</b> and <b>energy</b> to pick the right song for
          the moment. New tracks need tagging before they go on air.
        </p>
      </div>

      <div className="border-b border-ink">
        <div className="p-4 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 text-[11px] font-bold tracking-[0.16em] text-ink uppercase">
              <Sparkles size={14} /> Mood &amp; energy tagged
            </span>
            <span className="mono-num text-[13px] font-bold">{pct != null ? `${pct}%` : '—'}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
            <span className="lib-cov-big mono-num">{num(tagged)}</span>
            <span className="text-[13px] text-muted">
              / {total != null ? num(total) : scanning ? 'counting…' : '—'} tracks
            </span>
            <Btn
              sm
              onClick={p.onCountLibrary}
              // Also gated on `running`: a tag run already walks Navidrome.
              disabled={scanning || p.countingLibrary || running}
              title={running
                ? 'A tagging run is already walking Navidrome — it refreshes the total when it finishes.'
                : 'Counts every track in Navidrome — one request per album, so it takes a while on a big library. Nothing else on this page needs it.'}
            >
              <RefreshCw size={11} className={scanning ? 'animate-spin' : undefined} />{' '}
              {countLabel}
            </Btn>
          </div>
          <div
            className="lib-bar mt-3"
            role="progressbar"
            aria-label="Mood and energy tagging coverage"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(pct != null ? { 'aria-valuenow': Math.min(100, pct) } : {})}
          >
            <span ref={moodFillRef} />
          </div>
          <div className="mt-2.5 text-[11px] text-muted">
            {remaining != null && remaining > 0 ? (
              <>
                <b className="mono-num text-ink">{num(remaining)}</b> tracks still need tags
              </>
            ) : (
              remaining === 0
                ? 'Every track is tagged'
                : scanning
                  ? 'Counting your library…'
                  : 'Library not counted yet'
            )}{' '}
            · <span className="mono-num">{moodCount}</span> moods in use · last tag {lastTag}
            {countedAt && ` · counted ${relTime(countedAt)} ago`}
          </div>
          {countError && (
            <div className="mt-2 text-[11px] text-[var(--danger)]">
              Couldn&rsquo;t count the library: {countError}
              {countedAt ? ' — showing the previous count.' : ''}
            </div>
          )}
          {embeddingStale && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-[11px] text-ink">
              <span>
                <b>Embedding model changed — tagging is blocked.</b> Your library is embedded with{' '}
                <code>{p.coverage?.embeddedModel}</code>
                {p.coverage?.embeddedDim ? ` (${p.coverage.embeddedDim}-d)` : ''}, but you&rsquo;ve
                selected <code>{p.coverage?.currentEmbeddingModel}</code>. Re-embedding rebuilds{' '}
                {total != null ? (
                  <>all <b className="mono-num">{num(total)}</b> vectors</>
                ) : (
                  'every vector'
                )}{' '}
                at the new model (not just tagged tracks) — your mood tags are kept.
              </span>
              <button
                type="button"
                className="font-bold text-vermilion underline-offset-2 hover:underline"
                onClick={() => openModal('reembed')}
              >
                Re-embed now →
              </button>
            </div>
          )}
          {similarityThin && !embeddingStale && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-ink">
              <span>
                <b>Similarity is running on labels, not music.</b>{' '}
                <b className="mono-num">{num(labelOnly ?? 0)}</b> of{' '}
                <b className="mono-num">{num(embeddedVectors ?? 0)}</b> embedded tracks carry no
                Last.fm tags, lyrics or measured sound, so all the index has to compare them on is
                artist and album wording — which makes one artist&rsquo;s catalogue look like its
                own closest match. Run acoustic analysis (no API key needed), and add a Last.fm API
                key in Settings for crowd tags.
                {embeddingFormatStale && (
                  <>
                    {' '}
                    Your vectors also predate the sound descriptors, so re-embed once the analysis
                    has run to fold them in.
                  </>
                )}
              </span>
            </div>
          )}
          {embeddingFormatStale && !similarityThin && !embeddingStale && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-ink">
              <span>
                <b>Your similarity vectors predate the sound descriptors.</b> Tracks now carry
                measured sound (tempo, key, audio moods) that wasn&rsquo;t part of the text when
                they were embedded, so similarity is still comparing the old label-heavy text.
                Re-embed to fold the measured sound in.
              </span>
              <button
                type="button"
                className="font-bold text-vermilion underline-offset-2 hover:underline"
                onClick={() => openModal('reembed')}
              >
                Re-embed now →
              </button>
            </div>
          )}
          {embeddingMissing && !embeddingStale && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-ink">
              <span>
                <b>Embeddings missing.</b> Your embedding model may have changed. Re-embed to
                restore similarity-based picks.
              </span>
              <button
                type="button"
                className="font-bold text-vermilion underline-offset-2 hover:underline"
                onClick={() => openModal('reembed')}
              >
                Set up a re-embed →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Disclosure state is not persisted — a fresh load starts collapsed. */}
      <div className="border-b border-ink px-4 py-3.5 sm:px-6">
        <button
          type="button"
          className={cn(
            'inline-flex cursor-pointer flex-wrap items-center gap-1.5 text-[11px] font-bold',
            showAnalysis ? 'text-ink' : 'text-muted hover:text-ink',
          )}
          aria-expanded={showAnalysis}
          onClick={() => setAnalysisOpen(!showAnalysis)}
          disabled={analysisRunning}
          title={analysisRunning ? 'Analysis is running — shown until it finishes' : undefined}
        >
          <Activity size={13} /> Acoustic analysis
          <span className="caption mono-num font-normal !tracking-[0.04em] text-muted !normal-case">
            — {analysisSummary}
          </span>
          <span aria-hidden>{showAnalysis ? '▾' : '▸'}</span>
        </button>
      </div>
      {showAnalysis && (
      <div className="flex flex-col gap-3 border-b border-ink px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <span className="caption flex items-center gap-2">
            <Activity size={13} /> Acoustic analysis · bpm / key
          </span>
          <span className="lib-opt-tag">optional</span>
          <span
            className="lib-minibar"
            role="progressbar"
            aria-label="Acoustic analysis (bpm / key) coverage"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(!analysisOff && apct != null ? { 'aria-valuenow': Math.min(100, apct) } : {})}
          >
            <span ref={acousticFillRef} />
          </span>
          <span className="caption mono-num !tracking-[0.04em]">
            {analysisOff ? (
              'engine off'
            ) : (
              <>
                {num(analysed)} / {num(total)} · {apct != null ? `${apct}%` : '…'}
              </>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-dashed border-separator-strong pt-3">
          <span className="caption flex items-center gap-2">
            <Activity size={13} /> Audio fingerprint · sounds-like
          </span>
          <span className="lib-opt-tag">optional</span>
          <span
            className="lib-minibar"
            role="progressbar"
            aria-label="Audio fingerprint (sounds-like) coverage"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(audioOn && audpct != null ? { 'aria-valuenow': Math.min(100, audpct) } : {})}
          >
            <span ref={audioFillRef} />
          </span>
          <span className="caption mono-num !tracking-[0.04em]">
            {analysisOff ? (
              'engine off'
            ) : audioStatus === 'load-failed' ? (
              'engine has CLAP but it failed to load'
            ) : audioStatus === 'pending-heavy' ? (
              p.audioEnabled ? 'waiting for the heavy analyzer' : 'off · needs the heavy analyzer'
            ) : audioOn ? (
              <>
                {num(audioEmbedded)} / {num(total)} · {audpct != null ? `${audpct}%` : '…'}
              </>
            ) : audioStatus === 'incapable' && p.audioEnabled ? (
              'engine can’t fingerprint — needs the heavy analyzer'
            ) : p.audioEnabled ? (
              'enabled, not yet analysed'
            ) : (
              'off'
            )}
          </span>
          {!analysisOff && (
            <span className="ml-auto flex items-center gap-2">
              {p.audioEnabled && anyWorkDone && canBackfill(audioStatus) && (
                <Btn
                  sm
                  tone="accent"
                  onClick={p.onAnalyzeAudio}
                  disabled={p.busy || running}
                  title="Fingerprint the tracks still missing a “sounds-like” vector — without redoing bpm/key."
                >
                  <Play size={12} /> Backfill
                </Btn>
              )}
              <Btn
                sm
                onClick={p.onToggleAudio}
                disabled={p.busy || running}
                title={
                  p.audioEnabled
                    ? 'Pause fingerprinting newly-added tracks. Existing “sounds-like” data stays and keeps driving picks.'
                    : audioStatus === 'pending-heavy'
                      ? `${heavyUpgradeShort} You can enable now — fingerprinting starts automatically once it’s up.`
                      : 'Start fingerprinting new tracks for “sounds-like” picks (~1-2s each on the analysis engine).'
                }
              >
                {p.audioEnabled ? 'Pause' : 'Enable'}
              </Btn>
            </span>
          )}
          {!analysisOff && (
            <span className="caption basis-full !tracking-[0.04em] !normal-case">
              {p.audioEnabled
                ? 'Auto-fingerprints new tracks for “sounds-like” picks (~1-2s each). Pausing stops new analysis only — existing fingerprints stay and keep driving picks.'
                : 'Fingerprints how each track sounds for “sounds-like” picks (~1-2s each on the analysis engine).'}
            </span>
          )}
        </div>
        {/* Collapsed to a single "off · Enable" line until opted in (#646). */}
        {(vocalOptedIn || !analysisOff) && (
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-dashed border-separator-strong pt-3">
            <span className="caption flex items-center gap-2">
              <Activity size={13} /> Vocal activity · instrumental detection
            </span>
            <span className="lib-opt-tag">optional</span>
            {vocalOptedIn ? (
              <>
                <span
                  className="lib-minibar"
                  role="progressbar"
                  aria-label="Vocal activity (instrumental detection) coverage"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  {...(vocalOn && vpct != null ? { 'aria-valuenow': Math.min(100, vpct) } : {})}
                >
                  <span ref={vocalFillRef} />
                </span>
                <span className="caption mono-num !tracking-[0.04em]">
                  {analysisOff ? (
                    'engine off'
                  ) : vocalStatus === 'load-failed' ? (
                    'engine has Demucs but it failed to load'
                  ) : vocalStatus === 'pending-heavy' ? (
                    'waiting for the heavy analyzer'
                  ) : vocalOn ? (
                    <>
                      {num(vocalAnalyzed)} / {num(total)} · {vpct != null ? `${vpct}%` : '…'}
                    </>
                  ) : vocalStatus === 'incapable' ? (
                    'engine can’t separate vocals — needs the heavy analyzer'
                  ) : (
                    'enabled, not yet analysed'
                  )}
                </span>
                {!analysisOff && (
                  <span className="ml-auto flex items-center gap-2">
                    {anyWorkDone && canBackfill(vocalStatus) && (
                      <Btn
                        sm
                        tone="accent"
                        onClick={p.onVocalBackfill}
                        disabled={p.busy || running}
                        title="Separate vocals for the tracks still missing it — without redoing bpm/key."
                      >
                        <Play size={12} /> Backfill
                      </Btn>
                    )}
                    <Btn
                      sm
                      onClick={p.onToggleVocal}
                      disabled={p.busy || running}
                      title="Pause Demucs separation on newly-added tracks. Existing vocal data stays and keeps being used."
                    >
                      Pause
                    </Btn>
                  </span>
                )}
                {!analysisOff && (
                  <span className="caption basis-full !tracking-[0.04em] !normal-case">
                    Auto-separates vocals on new tracks (Demucs, ~10-30s each — CPU-heavy). Pausing
                    stops new analysis only — existing data stays and keeps being used.
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="caption mono-num !tracking-[0.04em]">
                  {vocalStatus === 'pending-heavy' ? 'off · needs the heavy analyzer' : 'off'}
                </span>
                <span className="ml-auto">
                  <Btn
                    sm
                    onClick={p.onToggleVocal}
                    disabled={p.busy || running}
                    title={
                      vocalStatus === 'pending-heavy'
                        ? `${heavyUpgradeShort} You can enable now — separation starts automatically once it’s up.`
                        : 'Start Demucs vocal separation on new tracks (~10-30s each — CPU-heavy).'
                    }
                  >
                    Enable
                  </Btn>
                </span>
                <span className="caption basis-full !tracking-[0.04em] !normal-case">
                  Separates vocals so the DJ can talk before lyrics (Demucs, ~10-30s/track —
                  CPU-heavy). Off by default.
                  {vocalStatus === 'pending-heavy' && ` ${heavyUpgradeShort}`}
                </span>
              </>
            )}
          </div>
        )}
        {/* Quiet-times gate (#1099) — a pass-level control, engine-independent. */}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-dashed border-separator-strong pt-3">
          <span className="caption flex items-center gap-2">
            <Moon size={13} /> Quiet times · analyse only while idle
          </span>
          <span className="lib-opt-tag">optional</span>
          <span className="caption mono-num !tracking-[0.04em]">
            {p.quietEnabled == null
              ? '…'
              : p.quietEnabled
                ? `on · after ${p.quietMinutes ?? 10} min with no listeners`
                : 'off'}
          </span>
          <span className="ml-auto flex items-center gap-2">
            {p.quietEnabled ? (
              <label className="caption flex items-center gap-1.5 !normal-case">
                idle
                <Input
                  className="mono-num h-7 w-16 px-2 text-xs"
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  key={p.quietMinutes ?? 'unset'}
                  defaultValue={p.quietMinutes ?? 10}
                  disabled={p.busy}
                  aria-label="Minutes with no listeners before analysis resumes"
                  onBlur={(e) => commitQuietMinutes(e.currentTarget)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  }}
                />
                min
              </label>
            ) : null}
            <Btn
              sm
              onClick={p.onToggleQuiet}
              disabled={p.busy || p.quietEnabled == null}
              title={
                p.quietEnabled
                  ? 'Let analysis run while listeners are tuned in (the default).'
                  : 'Pause analysis runs while anyone is listening — frees the CPU/GPU for the live station. Applies to manual runs too; a waiting run shows “Waiting for quiet”.'
              }
            >
              {p.quietEnabled ? 'Disable' : 'Enable'}
            </Btn>
          </span>
          <span className="caption basis-full !tracking-[0.04em] !normal-case">
            {p.quietEnabled
              ? 'Analysis runs pause while anyone is listening and resume once the stream has been idle this long. Applies to manual runs too — turn this off to analyse regardless.'
              : 'Pause analysis while anyone is listening, so bulk scans never compete with the live station for CPU/GPU. Off by default.'}
          </span>
        </div>
        {audioStatus === 'pending-heavy' && p.audioEnabled ? (
          <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case">
            <b>Sounds-like is enabled — fingerprinting starts once your analyzer can do it.</b> The
            default analyzer is the lean image (bpm/key only); CLAP needs the heavy build.{' '}
            {heavyUpgradeBox}{' '}
            <a href="/manual/analysis" className="font-bold text-vermilion underline-offset-2 hover:underline">
              Manual → Acoustic analysis
            </a>
          </div>
        ) : null}
        {vocalStatus === 'pending-heavy' && p.vocalEnabled ? (
          <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case">
            <b>Vocal-activity is enabled — separation starts once your analyzer can do it.</b> Demucs
            needs the heavy build. {heavyUpgradeBox}{' '}
            <a href="/manual/analysis" className="font-bold text-vermilion underline-offset-2 hover:underline">
              Manual → Acoustic analysis
            </a>
          </div>
        ) : null}
      </div>
      )}

      {/* Scene vocabulary (#1577) — self-contained. */}
      <SceneVocabSection />

      {showFailBanner && (
        <div className="mx-4 mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-[11px] text-ink sm:mx-6">
          <span>
            <b>The last {failModeLabel} run failed.</b>
            {lastRun?.error ? <> {lastRun.error}</> : ' Check the log for what went wrong.'}
          </span>
          <button
            type="button"
            className="font-bold text-vermilion underline-offset-2 hover:underline"
            onClick={() => p.setLogOpen(() => true)}
          >
            View log →
          </button>
          <button
            type="button"
            className="ml-auto text-muted hover:text-ink"
            onClick={() => setDismissedFailAt(lastRun!.finishedAt)}
          >
            Dismiss
          </button>
        </div>
      )}

      {loadFailure && (
        <div className="mx-4 mt-6 border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case sm:mx-6">
          <b>
            Your analyzer has {loadFailure.model}, but it failed to load — so{' '}
            {loadFailure.what} can&rsquo;t run.
          </b>{' '}
          This is not the lean/heavy image split; switching images won&rsquo;t help. The usual cause
          is the model weights, which the heavy analyzer downloads from huggingface.co the first time
          it needs them — a host with no outbound reach fails there every time.
          <div className="mt-1.5 font-mono text-[10px] break-words text-muted">{loadFailure.error}</div>
          <div className="mt-1.5">
            Fix the cause, then {loadFailure.restart} to retry — the failure is remembered until you
            do, which is what stops the pass re-analysing tracks it can&rsquo;t fill.{' '}
            <a href="/manual/analysis" className="font-bold text-vermilion underline-offset-2 hover:underline">
              Manual → Acoustic analysis
            </a>
          </div>
        </div>
      )}

      {failureCount > 0 && (
        <div className="mx-4 mt-6 border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case sm:mx-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              <b>
                {num(failureCount)} track{failureCount === 1 ? '' : 's'} failed analysis too many
                times
              </b>{' '}
              and {failureCount === 1 ? 'is' : 'are'} no longer being retried, so coverage will never
              reach 100%.
            </span>
            <button
              type="button"
              className="font-bold text-vermilion underline-offset-2 hover:underline"
              onClick={() => {
                if (!failuresOpen) p.onLoadFailures();
                setFailuresOpen(o => !o);
              }}
            >
              {failuresOpen ? 'Hide' : 'Show which →'}
            </button>
            <button
              type="button"
              className="ml-auto text-muted hover:text-ink"
              onClick={p.onClearFailures}
              title="Forget the failure history so the next analysis run tries these tracks again."
            >
              Retry all
            </button>
          </div>
          {failuresOpen && (
            <div className="mt-2 max-h-64 overflow-y-auto border-t border-dashed border-separator-strong pt-2">
              {p.failures == null ? (
                <span className="text-muted">Loading&hellip;</span>
              ) : p.failures.length === 0 ? (
                <span className="text-muted">Nothing recorded.</span>
              ) : (
                p.failures.map(f => (
                  <div key={f.id} className="border-b border-dashed border-separator-strong py-1.5 last:border-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <b>{f.title || f.id}</b>
                      {f.artist && <span className="text-muted">{f.artist}</span>}
                      <span className="mono-num ml-auto text-[10px] text-muted">
                        {f.attempts}x{f.excluded ? ' · given up' : ' · still retrying'}
                      </span>
                    </div>
                    <div className="font-mono text-[10px] break-words text-muted">{f.error}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {!running ? (
        <div className="flex flex-wrap items-center gap-4 p-4 sm:p-6">
          <div className="min-w-0 flex-1 text-[13px] sm:min-w-[220px]">
            {awaitingFirstCount ? (
              <>Counting your library&hellip; a big one takes a few minutes.</>
            ) : remaining != null && remaining > 0 ? (
              <>
                <b>{num(remaining)}</b> tracks are waiting. Tag them and they become DJ-ready.
              </>
            ) : remaining === 0 ? (
              <>Library fully tagged. Run a re-scan below if you&rsquo;ve changed the model.</>
            ) : (
              <>Start tagging new tracks so the DJ can play them.</>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Btn lg tone="accent" onClick={() => openModal()} disabled={p.busy || awaitingFirstCount}>
              {awaitingFirstCount ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Checking library…
                </>
              ) : (
                <>
                  <Play size={13} /> Start tagging
                </>
              )}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3.5">
            <span className="flex items-center gap-2.5 text-[13px] font-bold">
              <span className="lib-livedot" />
              {progress ? (
                <>
                  {progress.label}
                  {progress.round != null && ` · round ${progress.round}`}
                  {progress.done != null && (
                    <span className="mono-num">
                      &nbsp;· {num(progress.done)}
                      {progress.total != null && <> / {num(progress.total)}</>}
                    </span>
                  )}
                </>
              ) : p.tagger?.mode === 'analyze' ? (
                'Audio analysis in progress…'
              ) : p.tagger?.mode === 'reconcile' ? (
                'Reconciling with Navidrome…'
              ) : (
                'Tagging in progress…'
              )}
            </span>
            <span className="caption mono-num !tracking-[0.04em]">
              {runPct != null && `${runPct}% · `}
              {etaMs != null && `${fmtEta(etaMs)} · `}
              {p.tagger?.pid ? `pid ${p.tagger.pid}` : ''}
              {p.tagger?.startedAt
                ? ` · started ${new Date(p.tagger.startedAt).toLocaleTimeString('en-GB')}`
                : ''}
            </span>
            <Btn sm tone="danger" onClick={p.onStop} disabled={p.busy}>
              <Square size={11} /> Stop
            </Btn>
          </div>
          {/* Without this, a bar that resets to 0% each phase reads as "starting over". */}
          {stepList.length > 0 && (
            <div className="lib-steps">
              {stepList.map((s, i) => (
                <Fragment key={s.ph}>
                  {i > 0 && <span className="lib-step-sep" aria-hidden>›</span>}
                  <span className={cn('lib-step', s.state)}>
                    <span className="lib-step-dot" aria-hidden>{s.state === 'done' ? '✓' : ''}</span>
                    {PHASE_LABEL[s.ph] ?? s.ph}
                  </span>
                </Fragment>
              ))}
            </div>
          )}
          {(runPct != null || runIndeterminate) && (
            <div
              className={cn('lib-bar !h-1.5', runIndeterminate && 'indet')}
              role="progressbar"
              aria-label="Tagging run progress"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(!runIndeterminate && runPct != null ? { 'aria-valuenow': runPct } : {})}
            >
              <span ref={runFillRef} />
            </div>
          )}
          {(legEntries.length > 1 || (progress?.errors ?? 0) > 0) && (
            <div className="caption mono-num !tracking-[0.04em]">
              {legEntries.length > 1 && (
                <>dual-LLM · {legEntries.map(([m, n]) => `${m} ${num(n)}`).join(' · ')}</>
              )}
              {legEntries.length > 1 && (progress?.errors ?? 0) > 0 && ' · '}
              {(progress?.errors ?? 0) > 0 && (
                <span className="text-vermilion">{num(progress!.errors)} failed</span>
              )}
            </div>
          )}
          <div className="caption !tracking-[0.04em] !normal-case">
            {(progress && PHASE_HINT[progress.phase]) ||
              (p.tagger?.mode === 'analyze'
                ? 'The analysis engine is listening to each track: measuring tempo and key, and fingerprinting how it sounds.'
                : p.tagger?.mode === 'reconcile'
                  ? 'Checking every track against Navidrome and removing entries for files that no longer exist.'
                  : 'The DJ is listening to each new track and deciding its mood & energy.')}{' '}
            You can keep browsing. This runs in the background.
          </div>
        </div>
      )}

      {lastTimingEntries.length > 0 && (
        <div className="border-t border-dashed border-separator-strong px-4 py-3 text-[11px] text-muted sm:px-6">
          <span className="font-bold text-ink">Last run</span>
          <span className="!normal-case">
            {' · '}
            {lastTimingEntries
              .map(([ph, ms]) => `${PHASE_LABEL[ph] ?? ph} ${fmtDur(ms)}`)
              .join(' · ')}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-dashed border-separator-strong px-4 py-3 sm:px-6">
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-bold',
            p.logOpen ? 'text-ink' : 'text-muted hover:text-ink',
          )}
          onClick={() => p.setLogOpen(o => !o)}
        >
          <Terminal size={13} /> {p.logOpen ? 'Hide log' : 'View log'}
        </button>
      </div>

      {p.logOpen && (
        <pre
          ref={logRef}
          aria-live="polite"
          className="term term-crt m-0 max-h-56 overflow-y-auto !border-t !border-l-0 border-separator-strong"
        >
          {(p.tagger?.lastLog ?? []).length
            ? (p.tagger?.lastLog ?? []).map((line, i) => {
                // Structured events render by kind; raw strings fall back.
                if (typeof line === 'object' && line !== null) {
                  const st = EVENT_STYLE[line.kind] ?? EVENT_STYLE.info;
                  return (
                    <div key={i} className={cn('whitespace-pre-wrap', st.cls)}>
                      {st.emoji ? `${st.emoji}  ` : ''}
                      {line.text}
                    </div>
                  );
                }
                const f = beautifyLog(String(line));
                return (
                  <div key={i} className={cn('whitespace-pre-wrap', f.cls)}>
                    {f.text}
                  </div>
                );
              })
            : 'No log output yet — start a tagging run to watch the booth think.'}
        </pre>
      )}

      <LibraryTaggingModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        intent={modalIntent}
        batch={p.batch}
        setBatch={p.setBatch}
        busy={p.busy || running}
        remaining={remaining}
        libraryTotal={total}
        analysisOff={analysisOff}
        vocalWanted={vocalOptedIn}
        // Only true when the dimension is on AND the engine can do it.
        soundsLikeActive={!analysisOff && audioStatus !== 'pending-heavy' && !!p.audioEnabled}
        budgetMode={p.budgetMode}
        llmLabel={p.llmLabel}
        embedLabel={p.embedLabel}
        onStart={p.onStart}
        onReconcile={p.onReconcile}
        onRescan={p.onRescan}
        onReset={p.onReset}
      />
    </section>
  );
}
