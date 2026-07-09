'use client';

// The "Your DJ knows X%" tagging panel at the top of /admin/library —
// coverage hero, the primary Start-tagging action, live structured run
// progress, and the progressive-disclosure Maintenance & advanced drawer
// (which also houses the optional acoustic + audio-fingerprint passes).
// Extracted from LibraryPanel.tsx; the browse/search/untagged experience
// stays over there.

import { Fragment, useEffect, useRef, useState } from 'react';
import { Sparkles, Activity, Play, Square, Terminal, Loader2 } from 'lucide-react';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { Btn, Eyebrow } from './ui';
import { cn } from '../../lib/cn';
import LibraryTaggingModal from './LibraryTaggingModal';

// ---------------------------------------------------------------------------
// shared types (also consumed by LibraryPanel)
// ---------------------------------------------------------------------------
export interface Coverage {
  tagged: number;
  analysed: number;
  // Tracks with a CLAP audio (sounds-like) embedding. Same analysis backend,
  // gated on ANALYZE_AUDIO_EMBEDDING — 0 when that's off even if bpm/key runs.
  audioEmbedded?: number;
  // Tracks with Demucs vocal-activity ranges (vocal_ranges_json NOT NULL). Only
  // surfaced when vocalWanted; hidden by default for the common case (#646).
  vocalAnalyzed?: number;
  total: number | null;
  percent: number | null;
  analysedPercent: number | null;
  audioEmbeddedPercent?: number | null;
  vocalAnalyzedPercent?: number | null;
  // Vocal analysis is wanted via env ANALYZE_VOCAL_ACTIVITY or
  // settings.audio.vocalActivity — drives whether the vocal coverage row shows.
  vocalWanted?: boolean;
  scannedAt: string | null;
  scanning: boolean;
  // null = still probing; false = no analysis backend (sidecar/librosa) running.
  analysisAvailable?: boolean | null;
  analysisBackend?: string | null;
  // Whether the backend can emit CLAP "sounds-like" embeddings. false = engine
  // is up but on an image without the CLAP stack (an older tts-heavy) — drives
  // the active "pull the latest image" warning. null = unknown / still probing.
  audioAnalysisAvailable?: boolean | null;
  // Whether the natural-language "sounds like…" search can serve right now
  // (audio vectors stored + CLAP text tower not reported absent). Gates the
  // Search tab's mode toggle in LibraryPanel. Absent on old controllers.
  soundSearchAvailable?: boolean;
  // Whether the backend can emit Demucs vocal-activity ranges. false = engine
  // up but built without the Demucs stack (sidecar WITH_DEMUCS=0) — drives the
  // "rebuild with WITH_DEMUCS=1" warning when vocal activity is enabled.
  vocalAnalysisAvailable?: boolean | null;
  // Text-embedding index provenance. `embeddingStale` = the library was embedded
  // with a different model than the one currently configured, so a tag run is
  // blocked until a re-embed — drives the one-click "re-embed" prompt below.
  embeddedModel?: string | null;
  embeddedDim?: number | null;
  currentEmbeddingModel?: string | null;
  embeddingStale?: boolean;
  // Backend-computed per-dimension status enums (controller/src/music/coverage-
  // status.ts) — the single source of truth for the sounds-like + vocal rows,
  // replacing the frontend's incapable/starved/gap derivations. The panel pairs
  // these with the optimistic enable prop for enabled-vs-disabled wording.
  audioStatus?: DimensionStatus;
  vocalStatus?: DimensionStatus;
}

// Mirrors controller/src/music/coverage-status.ts.
export type DimensionStatus =
  | 'off'
  | 'pending-engine'
  | 'pending-heavy'
  | 'incapable'
  | 'ready'
  | 'partial'
  | 'complete';

// Mirrors controller/src/music/tagger-progress.ts — the structured sentinel
// the tagger child emits and /settings relays.
export interface TaggerProgress {
  phase: 'walk' | 'enrich' | 'embed' | 'seed' | 'propagate' | 'learn' | 'analyze' | 'done';
  label: string;
  done?: number;
  total?: number; // absent → indeterminate (e.g. the Navidrome walk)
  round?: number; // active-learn round
  errors?: number;
  llm?: { legs: Record<string, number> };
  // Cumulative ms per phase, attached to the terminal 'done' event so the panel
  // can show where the last run spent its time.
  timings?: Record<string, number>;
  updatedAt: string;
}

// A structured log event relayed from the tagger child (music/tagger-progress.ts
// EVENT_PREFIX channel). The child DECLARES what a line means so the panel renders
// by kind — no more regex-scraping console strings to guess intent/failure.
export interface TaggerEvent {
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  at: string;
}

// Outcome of the last finished run — drives the idle failure banner. 'stopped'
// (Stop button / a controller-restart kill) is operator-context and shows nothing.
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
  // Raw console lines interleaved with structured events, in chronological order
  // (broadcast/tagger.ts relays both). Capped at 100 server-side.
  lastLog?: (string | TaggerEvent)[];
  // 'tag' (tag-library), 'analyze' (the acoustic/audio-embedding pass), or
  // 'reconcile' (walk Navidrome + prune orphaned rows) — all run through the
  // same single-flight child slot.
  mode?: 'tag' | 'analyze' | 'reconcile' | null;
  progress?: TaggerProgress | null;
  lastRun?: TaggerLastRun | null;
}

// libraryStats rides along on /settings — gives moods-in-use, last-tag time,
// and withEmbedding (used to nudge a re-embed after a model swap) without an
// extra request and regardless of which tab is active.
export interface LibraryStatsLite {
  total: number;
  byMood: Record<string, number>;
  byEnergy: Record<string, number>;
  byGenre: Record<string, number>;
  withEmbedding: number;
  updatedAt: string | null;
}

export type Batch = '100' | '500' | '5000' | '10000' | 'all';

// Daily-token-budget tier, mirrors controller/src/broadcast/dj-budget.ts. Drives
// the Tagging modal's pre-run "budget nearly/already used" warning.
export type BudgetMode = 'normal' | 'soft' | 'hard';

export type RescanOpts = {
  reseed?: boolean;
  reEnrich?: boolean;
  reAnalyze?: boolean;
  upgrade?: boolean;
  // Whether a Re-analyse-acoustics pass also redoes the slow Demucs vocal pass.
  // false → --no-vocal (re-do bpm/key + sounds-like, keep existing vocal ranges).
  vocal?: boolean;
  // Reseed-only "re-embed, then continue tagging": after rebuilding vectors,
  // forward-tag the untagged remainder in the same run (drops the re-scan's
  // --rescan on the backend). Only honoured when reseed is the sole pass.
  thenTag?: boolean;
};

// Forward-run step toggles from the modal's Run tab. All default true except
// `vocal` (the Demucs pass is ~90% of the acoustics cost, so it's opt-in per
// run); an unchecked box sends `false`, which the controller maps to a skip
// flag (enrich→--skip-enrich, tagMoods→--skip-tag, analyze→--skip-analyze,
// reconcile→--no-prune). Only-reconcile is routed to onReconcile instead.
export type TagSteps = {
  reconcile: boolean;
  enrich: boolean;
  tagMoods: boolean;
  analyze: boolean;
  // Per-run Demucs vocal pass — only sent/honoured when analyze is on and vocal
  // is enabled in settings; lets a run do bpm/key + CLAP without the slow Demucs.
  vocal: boolean;
};

export function num(n: number | null | undefined): string {
  return n != null ? n.toLocaleString('en-GB') : '—';
}

// ---------------------------------------------------------------------------
// tagging panel — merged coverage + tagger, framed for humans
// ---------------------------------------------------------------------------
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
  // Wipe ALL tagging data (tags, embeddings, acoustics, enrichment) and start
  // fresh — backs the modal's Reset tab, behind a typed confirmation.
  onReset: () => void;
  // sounds-like (CLAP) controls — null until the first settings poll lands.
  audioEnabled: boolean | null;
  onToggleAudio: () => void;
  onAnalyzeAudio: () => void;
  // Vocal-activity (Demucs) controls — parallel to the sounds-like pair (#646).
  onToggleVocal: () => void;
  onVocalBackfill: () => void;
  // Whether vocal-activity (Demucs) analysis is enabled — null until the first
  // settings poll lands. Drives the "build WITH_DEMUCS=1" warning when on but
  // the backend can't produce vocal ranges.
  vocalEnabled: boolean | null;
  // Daily-token-budget tier from /settings — null until the first slow poll lands.
  // Forwarded to the modal for its pre-run spend warning.
  budgetMode: BudgetMode | null;
}

// One friendly sentence per pipeline phase — shown under the live progress so
// the operator knows what the run is actually doing right now.
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

// Short labels for the post-run phase breakdown (keys match the tagger's
// timings map, which includes 'setup'/'walk' that aren't user-facing phases).
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

// The tag pipeline in execution order — the stepper's canonical sequence, and
// the ordering used to decide which phases are behind/ahead of the live one.
// Excludes 'done' (a terminal marker, not a stage).
const PIPELINE: TaggerProgress['phase'][] = [
  'walk', 'enrich', 'embed', 'seed', 'propagate', 'learn', 'analyze',
];

// The stepper only renders the phases a given run mode can actually reach: an
// analyze run is acoustics-only, a reconcile run is a bare Navidrome scan, and a
// tag run walks the whole pipeline. Not every tag run hits every phase (steps
// can be deselected / re-scans skip forward work) — the caller marks phases
// BEFORE the live one as done, so a skipped phase simply never lights up active
// and is swept into "done" once a later phase starts, rather than sticking as a
// permanent "pending".
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

// Mirror of controller/src/music/coverage-status.ts `isBackfillable` — whether a
// backfill/analyze would help IF the dimension is enabled (headroom, no hard
// block). The panel ANDs it with the optimistic enable prop so the button toggles
// the instant the operator clicks Enable, ahead of the next /coverage poll.
function canBackfill(s: DimensionStatus | undefined): boolean {
  return s != null && s !== 'pending-heavy' && s !== 'pending-engine' && s !== 'complete';
}

// Coarser than fmtDur — a live ETA wobbles as the sampled rate drifts, so we
// round hard (5s buckets under a minute, whole minutes above) to keep it calm:
// "~40s left" / "~4m left".
function fmtEta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${Math.max(5, Math.round(s / 5) * 5)}s left`;
  return `~${Math.round(s / 60)}m left`;
}

// Presentation for a structured event, keyed on the kind the child declared.
// (The old 20-rule LOG_RULES regex table + keyword failure heuristic are gone —
// the friendly wording now lives at the tagger call sites and rides the event
// `text`; the panel just tints and tags by kind.)
const EVENT_STYLE: Record<TaggerEvent['kind'], { emoji: string; cls: string }> = {
  error: { emoji: '⚠️', cls: 'text-vermilion font-semibold' },
  warning: { emoji: '⚠', cls: 'text-vermilion' },
  success: { emoji: '✓', cls: 'text-emerald-500 font-semibold' },
  info: { emoji: '', cls: 'text-muted' },
};

// A MUCH slimmer beautifier for the RAW (non-event) lines that remain — the
// verbose per-batch progress console output and the synthetic [exit] marker.
// Handles only: exit status, [llm-debug-raw]/JSON-body suppression, and
// prefix-stripping. No LOG_RULES, no keyword failure scan.
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
  // Intent carried into the modal when opened from a contextual prompt — the
  // "embeddings missing" nudge jumps straight to a pre-ticked re-embed.
  const [modalIntent, setModalIntent] = useState<'reembed' | null>(null);
  // Dismiss-state for the last-run failure banner, keyed on the run's
  // finishedAt so a NEW failure (different timestamp) re-shows it.
  const [dismissedFailAt, setDismissedFailAt] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const moodFillRef = useRef<HTMLSpanElement>(null);
  const acousticFillRef = useRef<HTMLSpanElement>(null);
  const audioFillRef = useRef<HTMLSpanElement>(null);
  const vocalFillRef = useRef<HTMLSpanElement>(null);
  const runFillRef = useRef<HTMLSpanElement>(null);
  // ETA baseline: the {done, at} captured when the current phase (or active-learn
  // round) began. Pinned at phase entry so the rate is a stable phase-average
  // rather than a jittery instantaneous window; reset by the effect below.
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
  // Audio embeddings only exist once at least one is written; until then the
  // row reads "not enabled" rather than a misleading 0% (CLAP is opt-in).
  const audioOn = (audioEmbedded ?? 0) > 0;
  // Vocal row is hidden unless the operator opted in (env or settings) — the
  // common case never sees it. Backend resolves env-vs-settings precedence.
  const vocalWanted = p.coverage?.vocalWanted === true;
  // The Pause/Enable button + meter-vs-collapsed layout must react to a toggle
  // immediately, so drive them off the optimistic settings prop (p.vocalEnabled,
  // flipped on click in LibraryPanel) — mirroring how the audio row uses
  // p.audioEnabled. vocalWanted (from the polled /coverage, 60s cadence) only
  // lags, so it just fills the gap before /settings first loads. The modal's
  // per-run vocal checkboxes get this same optimistic value — coverage-driven,
  // they stayed invisible until a repoll/refresh after enabling. Only the
  // analysis-state bits (vocalStatus) stay coverage-driven.
  const vocalOptedIn = p.vocalEnabled ?? vocalWanted;
  const vocalOn = (vocalAnalyzed ?? 0) > 0;
  // Whether ANY tagging/analysis work has ever landed. On a completely virgin
  // library the honest affordance is the primary Start-tagging run, so the
  // per-dimension Backfill buttons stay hidden until there's an actual gap to
  // fill (some work done, this dimension behind) instead of sitting next to a
  // 0-of-N meter looking like a duplicate of the modal's "Analyze acoustics".
  const anyWorkDone = (tagged ?? 0) > 0 || (analysed ?? 0) > 0 || audioOn || vocalOn;
  const remaining = total != null && tagged != null ? Math.max(0, total - tagged) : null;
  const running = !!p.tagger?.running;
  // The first library count (walking Navidrome for a total) is in flight — size
  // still unknown. This is distinct from a *failed* scan, where `scanning` is
  // back to false but `total` stays null; only an active count should show the
  // "checking…" affordance and gate the Start button. A failed/never-run scan
  // falls through to "Library size unknown" rather than a forever-"updating".
  const scanning = !!p.coverage?.scanning;
  const libraryCounting = scanning && total == null;
  const analysisOff = p.coverage?.analysisAvailable === false;
  // Per-dimension status enums from the backend (coverage-status.ts) — the single
  // source of truth that replaced the four-nullable-boolean incapable/starved/gap
  // derivations. 'pending-heavy' = today's `*Incapable` (lean/older engine that
  // can't do this dimension); 'incapable' = today's `*Starved` (bpm/key ran,
  // produced none, engine doesn't advertise the capability). Both are
  // enable-independent, so the panel pairs them with the optimistic enable prop
  // (p.audioEnabled / vocalOptedIn) below to pick "waiting…" vs "off · needs…"
  // wording — reproducing every legacy string with no toggle lag. `undefined`
  // for an old controller with no enum → the capability branches simply don't fire.
  const audioStatus = p.coverage?.audioStatus;
  const vocalStatus = p.coverage?.vocalStatus;
  // The library was embedded with a different model than the one now configured,
  // so a tag run would fail on a dim/model mismatch — surface a blocking, one-click
  // re-embed prompt instead of letting the operator hit a cryptic tagger error.
  const embeddingStale = p.coverage?.embeddingStale === true;
  const moodCount = p.libStats ? Object.keys(p.libStats.byMood || {}).length : 0;
  const lastTag = p.libStats?.updatedAt
    ? new Date(p.libStats.updatedAt).toLocaleString('en-GB')
    : '—';

  // Embeddings present but no vectors → likely a model swap dropped them.
  const embeddingMissing =
    (tagged ?? 0) > 0 && p.libStats != null && p.libStats.withEmbedding === 0;

  // Structured live-run progress from the tagger child — survives page
  // reloads and runs started elsewhere (no client-captured baseline). Null
  // for an old child binary → the running view falls back to generic copy.
  const progress = running ? (p.tagger?.progress ?? null) : null;
  const runPct = progress?.total
    ? Math.min(100, Math.round(((progress.done ?? 0) / progress.total) * 100))
    : null;
  const runIndeterminate = !!progress && progress.total == null && progress.phase !== 'done';
  const legEntries = progress?.llm ? Object.entries(progress.llm.legs) : [];

  // Phase stepper — the pipeline stages this run mode can reach, each tagged
  // done/active/pending by comparing to the live phase's position in PIPELINE
  // order (so a phase the child skipped never strands as "pending"). Empty for
  // an old child binary with no progress sentinel → the stepper stays hidden.
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

  // Per-phase ETA — extrapolate the remaining items from the average rate since
  // the phase baseline. Recomputed on every progress poll (~3s while running)
  // inside the effect below, since it needs Date.now() (impure — not allowed at
  // render time). Suppressed for indeterminate phases (no total), the first ~10s
  // of a phase (too little signal), and a stalled/zero rate.
  const [etaMs, setEtaMs] = useState<number | null>(null);
  // Re-pin the ETA baseline whenever the phase or active-learn round changes so
  // each phase's rate is measured from its own start, then re-estimate against
  // the pinned baseline. Clears once the run ends.
  useEffect(() => {
    if (!progress || progress.phase === 'done') {
      etaRef.current = null;
      setEtaMs(null);
      return;
    }
    const b = etaRef.current;
    if (!b || b.phase !== progress.phase || b.round !== (progress.round ?? null)) {
      // Fresh phase — pin the baseline and hold off on an estimate until the
      // next poll gives us a rate to measure.
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

  // After a run ends, the child's final 'done' event sticks around (broadcast/
  // tagger.ts keeps it post-exit) — surface its per-phase breakdown when idle so
  // the operator can see where the time went (usually the chat-model seed/re-tag
  // phases, not embeddings) without scraping the log.
  const lastTimings =
    !running && p.tagger?.progress?.phase === 'done' ? p.tagger.progress.timings : undefined;
  const lastTimingEntries = lastTimings
    ? Object.entries(lastTimings)
        .filter(([, ms]) => ms > 0)
        .sort((a, b) => b[1] - a[1])
    : [];

  // Last-run failure banner: only when idle, the run genuinely failed (a signal
  // exit — Stop / restart-kill — is 'stopped' and shows nothing), and this
  // finishedAt hasn't been dismissed. A fresh failure has a new timestamp, so it
  // re-shows past a dismiss.
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
      {/* headline */}
      <div className="border-b border-ink p-6">
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

      {/* coverage — the single hero meter */}
      <div className="border-b border-ink">
        <div className="p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="flex items-center gap-2 text-[11px] font-bold tracking-[0.16em] text-ink uppercase">
              <Sparkles size={14} /> Mood &amp; energy tagged
            </span>
            <span className="mono-num text-[13px] font-bold">{pct != null ? `${pct}%` : '—'}</span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="lib-cov-big mono-num">{num(tagged)}</span>
            <span className="text-[13px] text-muted">
              / {total != null ? num(total) : p.coverage?.scanning ? 'scanning…' : '—'} tracks
            </span>
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
                <b className="mono-num text-ink">{num(remaining)}</b> tracks still need tags ·{' '}
                <span className="mono-num">{moodCount}</span> moods in use · last tag {lastTag}
              </>
            ) : (
              <>
                {remaining === 0
                  ? 'Every track is tagged'
                  : scanning
                    ? 'Coverage updating…'
                    : 'Library size unknown'}{' '}
                · <span className="mono-num">{moodCount}</span> moods in use · last tag {lastTag}
              </>
            )}
          </div>
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

      {/* acoustic & audio coverage — status meter on each row, plus the controls
          that change it: bpm/key is always-on (engine permitting); sounds-like
          (CLAP) and vocal (Demucs) are opt-in, so they carry Enable/Disable + a
          contextual Backfill (shown only while enabled, capable, < 100%, and the
          library has SOME work done — on a virgin library the primary
          Start-tagging run is the one entry point). */}
      <div className="flex flex-col gap-3 border-b border-ink px-6 py-4">
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
                      ? 'Needs the heavy analyzer (ANALYZER_HEAVY=1). You can enable now — fingerprinting starts automatically once it’s up.'
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
        {/* Vocal (Demucs) row — the opt-in entry point now that the modal tab is
            gone. Collapsed to a single "off · Enable" line until opted in (#646);
            once wanted it shows the full meter + Disable + Backfill. */}
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
                        ? 'Needs the heavy analyzer (ANALYZER_HEAVY=1). You can enable now — separation starts automatically once it’s up.'
                        : 'Start Demucs vocal separation on new tracks (~10-30s each — CPU-heavy).'
                    }
                  >
                    Enable
                  </Btn>
                </span>
                <span className="caption basis-full !tracking-[0.04em] !normal-case">
                  Separates vocals so the DJ can talk before lyrics (Demucs, ~10-30s/track —
                  CPU-heavy). Off by default.
                  {vocalStatus === 'pending-heavy' && ' Needs the heavy analyzer (ANALYZER_HEAVY=1).'}
                </span>
              </>
            )}
          </div>
        )}
        {audioStatus === 'pending-heavy' && p.audioEnabled ? (
          <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case">
            <b>Sounds-like is enabled — fingerprinting starts once your analyzer can do it.</b> The
            default analyzer is the lean image (bpm/key only); CLAP needs the heavy build. Set{' '}
            <code>ANALYZER_HEAVY=1</code> in <code>.env</code> and recreate the analyzer
            (<code>docker compose up -d analyzer</code>) — analysis then kicks in automatically,
            nothing to re-enable here. The heavy image is amd64-only.{' '}
            <a href="/manual/analysis" className="font-bold text-vermilion underline-offset-2 hover:underline">
              Manual → Acoustic analysis
            </a>
          </div>
        ) : null}
        {vocalStatus === 'pending-heavy' && p.vocalEnabled ? (
          <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case">
            <b>Vocal-activity is enabled — separation starts once your analyzer can do it.</b> Demucs
            needs the heavy build. Set <code>ANALYZER_HEAVY=1</code> in <code>.env</code> and recreate
            the analyzer (<code>docker compose up -d analyzer</code>) — analysis then kicks in
            automatically, nothing to re-enable here. The heavy image is amd64-only.{' '}
            <a href="/manual/analysis" className="font-bold text-vermilion underline-offset-2 hover:underline">
              Manual → Acoustic analysis
            </a>
          </div>
        ) : null}
      </div>

      {/* last-run failure banner — idle only; matches the embeddingStale banner's
          danger styling. 'stopped' runs (Stop / restart-kill) show nothing. */}
      {showFailBanner && (
        <div className="mx-6 mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-[11px] text-ink">
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

      {/* action zone — idle vs running */}
      {!running ? (
        <div className="flex flex-wrap items-center gap-4 p-6">
          <div className="min-w-[220px] flex-1 text-[13px]">
            {libraryCounting ? (
              <>Counting your library&hellip; this only takes a moment.</>
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
            <Btn lg tone="accent" onClick={() => openModal()} disabled={p.busy || libraryCounting}>
              {libraryCounting ? (
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
        <div className="flex flex-col gap-3 p-6">
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
          {/* pipeline stepper — where in the run we are (done · active · ahead),
              so a bar that resets to 0% each phase no longer reads as "starting
              over". Hidden when there's no structured progress (old child). */}
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

      {/* last-run phase breakdown — only when idle and the child reported timings */}
      {lastTimingEntries.length > 0 && (
        <div className="border-t border-dashed border-separator-strong px-6 py-3 text-[11px] text-muted">
          <span className="font-bold text-ink">Last run</span>
          <span className="!normal-case">
            {' · '}
            {lastTimingEntries
              .map(([ph, ms]) => `${PHASE_LABEL[ph] ?? ph} ${fmtDur(ms)}`)
              .join(' · ')}
          </span>
        </div>
      )}

      {/* footer */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-dashed border-separator-strong px-6 py-3">
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

      {/* log drawer — reuses the theme-aware .term surface; each line is dressed
          up for humans (emoji + friendly phrasing + tint) via beautifyLog */}
      {p.logOpen && (
        <pre
          ref={logRef}
          aria-live="polite"
          className="term term-crt m-0 max-h-56 overflow-y-auto !border-t !border-l-0 border-separator-strong"
        >
          {(p.tagger?.lastLog ?? []).length
            ? (p.tagger?.lastLog ?? []).map((line, i) => {
                // Structured events render directly by kind; raw strings fall
                // back to the slim beautifier.
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
        // sounds-like only runs when the dimension is on AND the engine can do
        // it — otherwise the acoustics steps are bpm/key-only (honest hints).
        soundsLikeActive={!analysisOff && audioStatus !== 'pending-heavy' && !!p.audioEnabled}
        budgetMode={p.budgetMode}
        onStart={p.onStart}
        onReconcile={p.onReconcile}
        onRescan={p.onRescan}
        onReset={p.onReset}
      />
    </section>
  );
}
