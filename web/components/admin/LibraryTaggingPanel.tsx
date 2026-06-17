'use client';

// The "Your DJ knows X%" tagging panel at the top of /admin/library —
// coverage hero, the primary Start-tagging action, live structured run
// progress, and the progressive-disclosure Maintenance & advanced drawer
// (which also houses the optional acoustic + audio-fingerprint passes).
// Extracted from LibraryPanel.tsx; the browse/search/untagged experience
// stays over there.

import { useEffect, useRef, useState } from 'react';
import {
  Sparkles, Activity, Play, Square, ChevronDown, ChevronRight, Terminal, RefreshCw,
} from 'lucide-react';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { Btn, Eyebrow } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';
import { cn } from '../../lib/cn';

// ---------------------------------------------------------------------------
// shared types (also consumed by LibraryPanel)
// ---------------------------------------------------------------------------
export interface Coverage {
  tagged: number;
  analysed: number;
  // Tracks with a CLAP audio (sounds-like) embedding. Same analysis backend,
  // gated on ANALYZE_AUDIO_EMBEDDING — 0 when that's off even if bpm/key runs.
  audioEmbedded?: number;
  total: number | null;
  percent: number | null;
  analysedPercent: number | null;
  audioEmbeddedPercent?: number | null;
  scannedAt: string | null;
  scanning: boolean;
  // null = still probing; false = no analysis backend (sidecar/librosa) running.
  analysisAvailable?: boolean | null;
  analysisBackend?: string | null;
  // Whether the backend can emit CLAP "sounds-like" embeddings. false = engine
  // is up but on an image without the CLAP stack (an older tts-heavy) — drives
  // the active "pull the latest image" warning. null = unknown / still probing.
  audioAnalysisAvailable?: boolean | null;
  // Whether the backend can emit Demucs vocal-activity ranges. false = engine
  // up but built without the Demucs stack (sidecar WITH_DEMUCS=0) — drives the
  // "rebuild with WITH_DEMUCS=1" warning when vocal activity is enabled.
  vocalAnalysisAvailable?: boolean | null;
}

// Mirrors controller/src/music/tagger-progress.ts — the structured sentinel
// the tagger child emits and /settings relays.
export interface TaggerProgress {
  phase: 'walk' | 'enrich' | 'embed' | 'seed' | 'propagate' | 'learn' | 'analyze' | 'done';
  label: string;
  done?: number;
  total?: number;        // absent → indeterminate (e.g. the Navidrome walk)
  round?: number;        // active-learn round
  errors?: number;
  llm?: { legs: Record<string, number> };
  updatedAt: string;
}

export interface TaggerState {
  running?: boolean;
  pid?: number;
  startedAt?: string;
  lastLog?: string[];
  // 'tag' (tag-library), 'analyze' (the acoustic/audio-embedding pass), or
  // 'reconcile' (walk Navidrome + prune orphaned rows) — all run through the
  // same single-flight child slot.
  mode?: 'tag' | 'analyze' | 'reconcile' | null;
  progress?: TaggerProgress | null;
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

export type Batch = '100' | '500' | 'all';

export type RescanOpts = {
  reseed?: boolean;
  reEnrich?: boolean;
  reAnalyze?: boolean;
  upgrade?: boolean;
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
  onStart: () => void;
  onStop: () => void;
  onRescan: (opts: RescanOpts) => void;
  // Walk Navidrome and prune library entries for tracks that no longer exist.
  onReconcile: () => void;
  // sounds-like (CLAP) controls — null until the first settings poll lands.
  audioEnabled: boolean | null;
  onToggleAudio: () => void;
  onAnalyzeAudio: () => void;
  // Whether vocal-activity (Demucs) analysis is enabled — null until the first
  // settings poll lands. Drives the "build WITH_DEMUCS=1" warning when on but
  // the backend can't produce vocal ranges.
  vocalEnabled: boolean | null;
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

export default function TaggingPanel(p: TaggingPanelProps) {
  const [maintOpen, setMaintOpen] = useState(false);
  const [confirmRescan, setConfirmRescan] = useState(false);
  const [passes, setPasses] = useState<RescanOpts>({ reseed: false, reEnrich: false, reAnalyze: false, upgrade: false });
  const logRef = useRef<HTMLPreElement>(null);
  const moodFillRef = useRef<HTMLSpanElement>(null);
  const acousticFillRef = useRef<HTMLSpanElement>(null);
  const audioFillRef = useRef<HTMLSpanElement>(null);
  const runFillRef = useRef<HTMLSpanElement>(null);

  const tagged = p.coverage?.tagged ?? p.libStats?.total ?? null;
  const total = p.coverage?.total ?? null;
  const analysed = p.coverage?.analysed ?? null;
  const audioEmbedded = p.coverage?.audioEmbedded ?? null;
  const pct = p.coverage?.percent ?? null;
  const apct = p.coverage?.analysedPercent ?? null;
  const audpct = p.coverage?.audioEmbeddedPercent ?? null;
  // Audio embeddings only exist once at least one is written; until then the
  // row reads "not enabled" rather than a misleading 0% (CLAP is opt-in).
  const audioOn = (audioEmbedded ?? 0) > 0;
  const remaining = total != null && tagged != null ? Math.max(0, total - tagged) : null;
  const running = !!p.tagger?.running;
  const analysisOff = p.coverage?.analysisAvailable === false;
  // Engine is up but on an image without the CLAP stack (an older tts-heavy
  // predating baked-in fingerprinting) — "sounds-like" can't be produced until
  // the sidecar is pulled fresh. We warn actively rather than letting a run
  // finish with the bar stuck at 0.
  const audioIncapable = !analysisOff && p.coverage?.audioAnalysisAvailable === false;
  // Vocal activity is on but the engine was built without Demucs — the analysis
  // pass would skip vocal backfill (no-op), so warn rather than silently never
  // filling vocal ranges. Mirrors the CLAP `audioIncapable` warning above.
  const vocalIncapable = !analysisOff && p.coverage?.vocalAnalysisAvailable === false;
  const moodCount = p.libStats ? Object.keys(p.libStats.byMood || {}).length : 0;
  const lastTag = p.libStats?.updatedAt ? new Date(p.libStats.updatedAt).toLocaleString('en-GB') : '—';
  const anySel = !!(passes.reseed || passes.reEnrich || passes.reAnalyze || passes.upgrade);

  // Embeddings present but no vectors → likely a model swap dropped them.
  const embeddingMissing = (tagged ?? 0) > 0 && p.libStats != null && p.libStats.withEmbedding === 0;

  // Structured live-run progress from the tagger child — survives page
  // reloads and runs started elsewhere (no client-captured baseline). Null
  // for an old child binary → the running view falls back to generic copy.
  const progress = running ? (p.tagger?.progress ?? null) : null;
  const runPct = progress?.total
    ? Math.min(100, Math.round(((progress.done ?? 0) / progress.total) * 100))
    : null;
  const runIndeterminate = !!progress && progress.total == null && progress.phase !== 'done';
  const legEntries = progress?.llm ? Object.entries(progress.llm.legs) : [];

  useDynamicStyle(moodFillRef, { width: pct != null ? `${Math.min(100, pct)}%` : '0%' });
  useDynamicStyle(acousticFillRef, { width: !analysisOff && apct != null ? `${Math.min(100, apct)}%` : '0%' });
  useDynamicStyle(audioFillRef, { width: audioOn && audpct != null ? `${Math.min(100, audpct)}%` : '0%' });
  useDynamicStyle(runFillRef, { width: runPct != null ? `${runPct}%` : null });

  useEffect(() => {
    if (p.logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [p.logOpen, p.tagger?.lastLog?.length]);

  const togglePass = (k: keyof RescanOpts) => setPasses(prev => ({ ...prev, [k]: !prev[k] }));
  const allSelected = !!(passes.reseed && passes.reEnrich && passes.reAnalyze && passes.upgrade);
  const toggleAll = () => {
    const on = !allSelected;
    setPasses({ reseed: on, reEnrich: on, reAnalyze: on, upgrade: on });
  };
  const clearPasses = () => setPasses({ reseed: false, reEnrich: false, reAnalyze: false, upgrade: false });
  // Re-embedding re-spends embedding calls — guard those runs behind a confirm;
  // the lighter passes (re-enrich / re-analyse / re-decide) run straight away.
  const runRescan = () => {
    if (passes.reseed) { setConfirmRescan(true); return; }
    p.onRescan(passes);
    clearPasses();
  };

  return (
    <section className="card">
      {/* headline */}
      <div className="border-b border-ink p-6">
        <Eyebrow className="text-vermilion">library · tagging</Eyebrow>
        <h1 className="lib-hero-title">
          {pct != null
            ? <>Your DJ knows <span className="pct mono-num">{pct}%</span> of your library.</>
            : <>Manage the music your station plays.</>}
        </h1>
        <p className="lib-hero-sub">
          The DJ reads each track&rsquo;s <b>mood</b> and <b>energy</b> to pick the right song for
          the moment — new tracks need tagging before they go on air.
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
            <span className="text-[13px] text-muted">/ {total != null ? num(total) : (p.coverage?.scanning ? 'scanning…' : '—')} tracks</span>
          </div>
          <div className="lib-bar mt-3"><span ref={moodFillRef} /></div>
          <div className="mt-2.5 text-[11px] text-muted">
            {remaining != null && remaining > 0
              ? <><b className="mono-num text-ink">{num(remaining)}</b> tracks still need tags · <span className="mono-num">{moodCount}</span> moods in use · last tag {lastTag}</>
              : <>{remaining === 0 ? 'Every track is tagged' : 'Coverage updating…'} · <span className="mono-num">{moodCount}</span> moods in use · last tag {lastTag}</>}
          </div>
          {embeddingMissing && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[color-mix(in_oklab,var(--accent)_30%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-ink">
              <span><b>Embeddings missing.</b> Your embedding model may have changed — re-embed to restore similarity-based picks.</span>
              <button
                type="button"
                className="font-bold text-vermilion underline-offset-2 hover:underline"
                onClick={() => { setMaintOpen(true); setPasses(s => ({ ...s, reseed: true })); }}
              >
                Set up a re-embed →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* action zone — idle vs running */}
      {!running ? (
        <div className="flex flex-wrap items-center gap-4 p-6">
          <div className="min-w-[220px] flex-1 text-[13px]">
            {remaining != null && remaining > 0
              ? <><b>{num(remaining)}</b> tracks are waiting. Tag them and they become DJ-ready.</>
              : remaining === 0
                ? <>Library fully tagged. Run a re-scan below if you&rsquo;ve changed the model.</>
                : <>Start tagging new tracks so the DJ can play them.</>}
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="lib-batch">
              <label htmlFor="lib-batch">Tag</label>
              <select id="lib-batch" value={p.batch} onChange={e => p.setBatch(e.target.value as Batch)}>
                <option value="100">next 100</option>
                <option value="500">next 500</option>
                <option value="all">all{remaining != null ? ` ${num(remaining)}` : ''} remaining</option>
              </select>
            </div>
            <Btn lg tone="accent" onClick={p.onStart} disabled={p.busy || remaining === 0}>
              <Play size={13} /> Start tagging
            </Btn>
            <Btn
              lg
              onClick={p.onReconcile}
              disabled={p.busy}
              title="Walk Navidrome and remove library entries for tracks that no longer exist (deleted files or IDs changed by a full rescan). No tagging cost."
            >
              <RefreshCw size={13} /> Reconcile with Navidrome
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
                      &nbsp;· {num(progress.done)}{progress.total != null && <> / {num(progress.total)}</>}
                    </span>
                  )}
                </>
              ) : (
                p.tagger?.mode === 'analyze' ? 'Audio analysis in progress…'
                  : p.tagger?.mode === 'reconcile' ? 'Reconciling with Navidrome…'
                  : 'Tagging in progress…'
              )}
            </span>
            <span className="caption mono-num !tracking-[0.04em]">
              {runPct != null && `${runPct}% · `}
              {p.tagger?.pid ? `pid ${p.tagger.pid}` : ''}
              {p.tagger?.startedAt ? ` · started ${new Date(p.tagger.startedAt).toLocaleTimeString('en-GB')}` : ''}
            </span>
            <Btn sm tone="danger" onClick={p.onStop} disabled={p.busy}><Square size={11} /> Stop</Btn>
          </div>
          {(runPct != null || runIndeterminate) && (
            <div className={cn('lib-bar !h-1.5', runIndeterminate && 'indet')}><span ref={runFillRef} /></div>
          )}
          {(legEntries.length > 1 || (progress?.errors ?? 0) > 0) && (
            <div className="caption mono-num !tracking-[0.04em]">
              {legEntries.length > 1 && <>dual-LLM · {legEntries.map(([m, n]) => `${m} ${num(n)}`).join(' · ')}</>}
              {legEntries.length > 1 && (progress?.errors ?? 0) > 0 && ' · '}
              {(progress?.errors ?? 0) > 0 && <span className="text-vermilion">{num(progress!.errors)} failed</span>}
            </div>
          )}
          <div className="caption !tracking-[0.04em] !normal-case">
            {(progress && PHASE_HINT[progress.phase]) ||
              (p.tagger?.mode === 'analyze'
                ? 'The analysis engine is listening to each track — measuring tempo and key, and fingerprinting how it sounds.'
                : p.tagger?.mode === 'reconcile'
                  ? 'Checking every track against Navidrome and removing entries for files that no longer exist.'
                  : 'The DJ is listening to each new track and deciding its mood & energy.')}
            {' '}You can keep browsing — this runs in the background.
          </div>
        </div>
      )}

      {/* footer — progressive disclosure */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-dashed border-separator-strong px-6 py-3">
        <button
          type="button"
          className={cn('inline-flex items-center gap-1.5 text-[11px] font-bold', maintOpen ? 'text-ink' : 'text-muted hover:text-ink')}
          onClick={() => setMaintOpen(o => !o)}
        >
          {maintOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Maintenance &amp; advanced
        </button>
        <button
          type="button"
          className={cn('inline-flex items-center gap-1.5 text-[11px] font-bold', p.logOpen ? 'text-ink' : 'text-muted hover:text-ink')}
          onClick={() => p.setLogOpen(o => !o)}
        >
          <Terminal size={13} /> {p.logOpen ? 'Hide log' : 'View log'}
        </button>
      </div>

      {/* maintenance & advanced disclosure */}
      {maintOpen && (
        <div className="flex flex-col gap-3.5 border-t border-ink bg-[var(--ink-soft)] p-6">
          {/* optional acoustic / audio-fingerprint passes — tucked away here so
              the default view stays focused on mood & energy */}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <span className="caption flex items-center gap-2">
              <Activity size={13} /> Acoustic analysis · bpm / key
            </span>
            <span className="lib-opt-tag">optional</span>
            <span className="lib-minibar"><span ref={acousticFillRef} /></span>
            <span className="caption mono-num !tracking-[0.04em]">
              {analysisOff ? 'engine off' : <>{num(analysed)} / {num(total)} · {apct != null ? `${apct}%` : '…'}</>}
            </span>
            <span className="caption basis-full !tracking-[0.04em] !normal-case">
              {analysisOff
                ? 'No analysis engine running — start the tts-heavy sidecar (docker compose --profile tts-heavy up -d) or configure a local librosa venv.'
                : 'Improves beat-matching between tracks; tagging works fine without it.'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-dashed border-separator-strong pt-3.5">
            <span className="caption flex items-center gap-2">
              <Activity size={13} /> Audio fingerprint · sounds-like
            </span>
            <span className="lib-opt-tag">optional</span>
            <span className="lib-minibar"><span ref={audioFillRef} /></span>
            <span className="caption mono-num !tracking-[0.04em]">
              {analysisOff
                ? 'engine off'
                : audioIncapable
                  ? 'engine missing CLAP'
                  : audioOn
                    ? <>{num(audioEmbedded)} / {num(total)} · {audpct != null ? `${audpct}%` : '…'}</>
                    : p.audioEnabled ? 'enabled — not yet analysed' : 'off'}
            </span>
            {!analysisOff && p.audioEnabled != null && (
              <span className="flex items-center gap-2">
                {p.audioEnabled && (
                  <Btn sm tone="accent" onClick={p.onAnalyzeAudio} disabled={running || p.busy || audioIncapable}>
                    <Play size={12} /> {audioOn ? 'Analyze new tracks' : 'Analyze library'}
                  </Btn>
                )}
                <Btn sm onClick={p.onToggleAudio} disabled={running || p.busy}>
                  {p.audioEnabled ? 'Disable' : 'Enable'}
                </Btn>
              </span>
            )}
            {audioIncapable && p.audioEnabled ? (
              <span className="basis-full border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case">
                <b>Sounds-like is on, but the analysis engine can’t fingerprint audio.</b> Your
                tts-heavy image predates audio fingerprinting, so a run would only fill bpm/key and
                leave this at 0. Pull the latest image and recreate the sidecar, then run the analysis:
                <code className="mt-1 block font-mono text-[10.5px] text-muted">docker compose pull tts-heavy &amp;&amp; docker compose --profile tts-heavy up -d tts-heavy</code>
              </span>
            ) : (
              <span className="caption basis-full !tracking-[0.04em] !normal-case">
                {analysisOff
                  ? 'Needs the analysis engine above.'
                  : 'Listens to each track and fingerprints how it sounds, enabling “sounds-like” picks and sonic journeys.'}
              </span>
            )}
          </div>

          {vocalIncapable && p.vocalEnabled ? (
            <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink !normal-case">
              <b>Vocal-activity is on, but the analysis engine can’t separate vocals.</b> Your
              tts-heavy image predates vocal separation, so the pass skips vocal ranges (it won’t
              re-scan the whole library chasing them). Pull the latest image and recreate the sidecar, then run the analysis:
              <code className="mt-1 block font-mono text-[10.5px] text-muted">docker compose pull tts-heavy &amp;&amp; docker compose --profile tts-heavy up -d tts-heavy</code>
            </div>
          ) : null}

          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 border-t border-dashed border-separator-strong pt-3.5">
            <span className="max-w-[64ch] text-[12px] leading-[1.55] text-muted">
              <b className="text-ink">Re-scan</b> — only needed after changing the LLM, embedding model, or analysis
              engine. Pick the passes to redo (tick all for a full rebuild); existing mood tags are kept as seeds.
            </span>
            <button
              type="button"
              className="shrink-0 text-[11px] font-bold text-vermilion underline-offset-2 hover:underline disabled:opacity-40"
              disabled={p.busy || running}
              onClick={allSelected ? clearPasses : toggleAll}
            >
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Pass on={!!passes.reseed} onClick={() => togglePass('reseed')} name="Re-embed all tracks"
              hint="Drop & rebuild every vector. Run after changing the embedding model." />
            <Pass on={!!passes.reEnrich} onClick={() => togglePass('reEnrich')} name="Re-enrich metadata"
              hint="Re-fetch Last.fm tags + lyrics that feed the tagging." />
            <Pass on={!!passes.reAnalyze} onClick={() => togglePass('reAnalyze')} name="Re-analyse acoustics"
              hint="Redo BPM / key for every track — also refreshes sounds-like fingerprints when enabled." />
            <Pass on={!!passes.upgrade} onClick={() => togglePass('upgrade')} name="Re-decide moods"
              hint="Re-tag tracks whose prompt or model is now stale." />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <Btn sm tone="accent" disabled={!anySel || p.busy || running} onClick={runRescan}>
              <RefreshCw size={12} /> {allSelected ? 'Run full re-scan' : 'Run re-scan'}
            </Btn>
          </div>
        </div>
      )}

      {/* log drawer — reuses the theme-aware .term surface */}
      {p.logOpen && (
        <pre ref={logRef} className="term m-0 max-h-56 overflow-y-auto !border-t !border-l-0 border-separator-strong">
          {(p.tagger?.lastLog || []).join('\n') || '(no log output yet — start a tagging run to see the booth think)'}
        </pre>
      )}

      <V3AlertDialog
        open={confirmRescan}
        onOpenChange={setConfirmRescan}
        title="Re-embed the whole library?"
        description="This pass drops and rebuilds every similarity vector from scratch, which re-spends embedding calls and can take several minutes on a large library. Existing mood tags are kept and reused as seeds. Only needed after changing the embedding model."
        confirmLabel="re-scan"
        danger
        onConfirm={() => { p.onRescan(passes); clearPasses(); }}
      />
    </section>
  );
}

function Pass({ on, onClick, name, hint }: { on: boolean; onClick: () => void; name: string; hint: string }) {
  return (
    <button type="button" className={cn('lib-pass', on && 'on')} onClick={onClick}>
      <span className="box">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.2L4.8 8.5L9.5 3.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span>
        <span className="lib-pass-name">{name}</span>
        <span className="lib-pass-hint">{hint}</span>
      </span>
    </button>
  );
}
