'use client';

// The single "Tagging" modal opened from the library panel's primary button.
// Three tabs, one per intent:
//   • Run     — pick which pipeline steps run, then start a forward run
//   • Re-scan — maintenance passes that redo already-done work after a model change
//   • Reset   — nuke ALL tagging data (tags, embeddings, acoustics, enrichment)
//               and start fresh, behind a double confirmation
// Run/Re-scan are "configure + launch a pipeline run"; Reset is a destructive
// one-shot. The optional-dimension lifecycle (enable / disable / backfill CLAP +
// Demucs) lives on the panel's coverage rows instead, next to the meters it changes.

import { useEffect, useState } from 'react';
import { Play, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Btn } from './ui';
import { cn } from '../../lib/cn';
import type { Batch, BudgetMode, RescanOpts, TagSteps } from './LibraryTaggingPanel';
import { num } from './LibraryTaggingPanel';

type Tab = 'run' | 'rescan' | 'reset';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // state
  batch: Batch;
  setBatch: (b: Batch) => void;
  busy: boolean;
  remaining: number | null;
  // Total tracks in the library — used to spell out the re-embed scope ("all N
  // tracks"), since a model-change reseed rebuilds the whole library, not just
  // the tagged set. null while the coverage scan is still counting.
  libraryTotal: number | null;
  // coverage-derived availability. analysisOff locks the Run tab's "Analyze
  // acoustics" step; vocalWanted gates the per-run "Vocal activity" sub-checkbox
  // (Run tab) + the "Re-analyse vocal" sub-toggle (Re-scan tab) so they stay
  // hidden until the operator opts vocal in on the panel (#646).
  analysisOff: boolean;
  vocalWanted: boolean;
  // Whether the acoustic pass will actually emit sounds-like (CLAP) fingerprints:
  // the dimension is enabled AND the engine can produce them. false → the
  // "Analyze acoustics" / "Re-analyse acoustics" steps run bpm/key only, so their
  // hints drop the sounds-like promise rather than advertising a no-op.
  soundsLikeActive: boolean;
  // Daily-token-budget tier from /settings — drives the pre-run spend warning.
  // null (old controller / not yet polled) is treated as 'normal' (no warning).
  budgetMode: BudgetMode | null;
  // when set, the modal opens straight to the matching tab/selection
  intent: 'reembed' | null;
  // handlers
  onStart: (steps?: TagSteps) => void;
  onReconcile: () => void;
  onRescan: (opts: RescanOpts) => void;
  // Wipe ALL tagging data and start fresh (deletes library.db server-side).
  onReset: () => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'run', label: 'Run' },
  { key: 'rescan', label: 'Re-scan' },
  { key: 'reset', label: 'Reset' },
];

export default function LibraryTaggingModal(p: Props) {
  const [tab, setTab] = useState<Tab>('run');

  // Run-tab step selection — all on by default EXCEPT the Demucs vocal pass:
  // measured at ~90% of the whole acoustics phase (~10s/track on a 24-thread
  // CPU), so the default forward run stays quick and vocal coverage is a
  // deliberate tick (or the coverage row's Backfill, which sweeps the backlog).
  const [steps, setSteps] = useState<TagSteps>({
    reconcile: true, enrich: true, tagMoods: true, analyze: true, vocal: false,
  });
  const toggleStep = (k: keyof TagSteps) => setSteps(s => ({ ...s, [k]: !s[k] }));

  // Re-scan passes (moved here from the panel's old maintenance drawer).
  const [passes, setPasses] = useState<RescanOpts>({
    reseed: false, reEnrich: false, reAnalyze: false, upgrade: false,
  });
  // Sub-toggle: does a Re-analyse-acoustics pass also redo the slow Demucs pass?
  // Default on (re-analyse = redo all); unticking keeps existing vocal ranges.
  const [reAnalyzeVocal, setReAnalyzeVocal] = useState(true);
  const [confirmRescan, setConfirmRescan] = useState(false);
  // "Then tag untagged tracks" sub-toggle — offered only when Re-embed is the
  // ONLY selected pass (a reseed-only run can continue straight into the forward
  // tag pass; combining it with other re-* passes isn't well-defined). Defaults
  // ON when the modal was opened by the stale-embedding banner (intent 'reembed'),
  // since that banner blocked a run the operator actually wanted.
  const [thenTag, setThenTag] = useState(false);
  const togglePass = (k: keyof RescanOpts) => setPasses(prev => ({ ...prev, [k]: !prev[k] }));

  // Reset tab — first confirmation is an acknowledgement checkbox that arms the
  // button; clicking it then opens the second (a danger alert dialog).
  const [resetAck, setResetAck] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const passAllSelected = !!(passes.reseed && passes.reEnrich && passes.reAnalyze && passes.upgrade);
  const anyPass = !!(passes.reseed || passes.reEnrich || passes.reAnalyze || passes.upgrade);
  const reseedOnly = !!passes.reseed && !passes.reEnrich && !passes.reAnalyze && !passes.upgrade;
  const clearPasses = () => setPasses({ reseed: false, reEnrich: false, reAnalyze: false, upgrade: false });

  // On each open, reset to a sensible tab. A 'reembed' intent (the panel's
  // "embeddings missing" nudge) jumps to Re-scan with re-embed pre-ticked.
  useEffect(() => {
    if (!p.open) return;
    if (p.intent === 'reembed') {
      setTab('rescan');
      setPasses({ reseed: true, reEnrich: false, reAnalyze: false, upgrade: false });
      // Staleness blocked a run the operator wanted — default to continuing into it.
      setThenTag(true);
    } else {
      setTab('run');
      setThenTag(false);
    }
    // The destructive acknowledgement never survives a modal close — every open
    // starts un-armed so Reset can't be one-clicked from a stale tick.
    setResetAck(false);
    // Only re-run when the modal transitions open (or the intent changes).
  }, [p.open, p.intent]);

  // Analyze can't run without an engine — force it off + lock the box.
  const analyzeLocked = p.analysisOff;
  const effAnalyze = analyzeLocked ? false : steps.analyze;
  const effSteps: TagSteps = {
    ...steps,
    analyze: effAnalyze,
    // Vocal only matters when analyze runs and vocal is opted-in; otherwise send
    // false (a harmless --no-vocal — backend ignores it when analyze is off).
    vocal: effAnalyze && p.vocalWanted ? steps.vocal : false,
  };
  const anyStep = effSteps.reconcile || effSteps.enrich || effSteps.tagMoods || effSteps.analyze;
  const onlyReconcile = effSteps.reconcile && !effSteps.enrich && !effSteps.tagMoods && !effSteps.analyze;

  // ---- Run-tab cost preview (Item A) -------------------------------------
  // Estimate the LLM spend before the operator commits. inScope = tracks this
  // run will embed+tag = min(batch limit, untagged remaining); seedEst = the
  // up-front LLM seed budget tag-library.ts spends before propagation carries
  // the rest. Both need live counts, so the line is suppressed until the
  // coverage scan has a total + remaining. Batch 25 mirrors tag-library's
  // default --batch. See seedBudget() below for the mirrored autoSeedCount.
  const limitNum = p.batch === 'all' ? Infinity : parseInt(p.batch, 10);
  const inScope =
    p.remaining == null
      ? null
      : limitNum === Infinity
        ? p.remaining
        : Math.min(limitNum, p.remaining);
  const seedEst =
    inScope != null && p.libraryTotal != null ? Math.min(seedBudget(p.libraryTotal), inScope) : null;
  // 'normal' (or unknown) → no banner; soft/hard get a spend caution.
  const budgetWarn = p.budgetMode === 'soft' || p.budgetMode === 'hard' ? p.budgetMode : null;

  const startRun = () => {
    if (!anyStep || p.busy) return;
    // A reconcile-only selection is the existing walk+prune endpoint.
    if (onlyReconcile) p.onReconcile();
    else p.onStart(effSteps);
    p.onOpenChange(false);
  };

  // Only carry the vocal override when re-analysing AND vocal is opted-in; else
  // omit it so the run defers to settings.audio.vocalActivity.
  const rescanPayload = (): RescanOpts => ({
    ...passes,
    vocal: passes.reAnalyze && p.vocalWanted ? reAnalyzeVocal : undefined,
    // Only carry the continuation when reseed is the sole pass and it's ticked.
    thenTag: reseedOnly && thenTag ? true : undefined,
  });
  const runRescan = () => {
    if (!anyPass || p.busy) return;
    // Re-embedding re-spends embedding calls — confirm first; lighter passes go.
    if (passes.reseed) { setConfirmRescan(true); return; }
    p.onRescan(rescanPayload());
    clearPasses();
    p.onOpenChange(false);
  };

  return (
    <Modal open={p.open} onOpenChange={p.onOpenChange} title="Tagging" width={620}>
      {/* tab strip */}
      <div className="flex gap-1 border-b border-separator-strong px-1">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'border-b-2 px-3 py-2 text-[11px] font-bold tracking-[0.04em]',
              tab === t.key ? 'border-vermilion text-ink' : 'border-transparent text-muted hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-4 p-5">
        {/* Daily-token-budget caution — shown on both tabs when the day's spend
            is near (soft) or past (hard) the cap, so a run's LLM steps won't
            surprise the operator with extra spend or mid-run failures. */}
        {tab !== 'reset' && budgetWarn && (
          <div className="flex items-start gap-2 border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2 text-[11px] leading-[1.5] text-ink">
            {budgetWarn === 'soft' ? (
              <span><b>Daily token budget nearly used</b> — this run will spend more against it.</span>
            ) : (
              <span>
                <b>Daily token budget exhausted</b> — LLM steps will fail until tomorrow (UTC).
                Non-LLM steps (reconcile, acoustics) still run.
              </span>
            )}
          </div>
        )}
        {/* ----------------------------------------------------------------- RUN */}
        {tab === 'run' && (
          <>
            <p className="text-[12px] leading-[1.55] text-muted">
              Process new / untagged tracks. Untick a step to skip it this run — the
              badge shows what each one costs.
            </p>
            <div className="grid gap-2.5">
              <Pass on={steps.reconcile} onClick={() => toggleStep('reconcile')}
                name="Reconcile with Navidrome" tag="quick"
                hint="Find newly-added tracks and drop ones deleted from Navidrome. Fast — no AI, no model calls." />
              <Pass on={steps.enrich} onClick={() => toggleStep('enrich')}
                name="Enrich metadata" tag="network"
                hint="Fetch Last.fm tags + lyrics per track to sharpen the mood read. External API calls — slower on big batches." />
              <Pass on={steps.tagMoods} onClick={() => toggleStep('tagMoods')}
                name="Tag moods (LLM)" tag="AI · billed"
                hint="The core step: embeds each track, then your LLM picks mood & energy and spreads tags to similar songs. Uses model calls." />
              {steps.tagMoods && seedEst != null && inScope != null && (
                <p className="-mt-1 pl-[26px] text-[11px] leading-[1.5] text-muted">
                  ≈ <span className="mono-num">{num(seedEst)}</span> LLM seed calls in ~
                  <span className="mono-num">{Math.ceil(seedEst / 25)}</span> batches, plus re-checks
                  for uncertain tracks · ≈ <span className="mono-num">{num(inScope)}</span> embedding calls
                </p>
              )}
              <Pass on={effSteps.analyze} onClick={() => toggleStep('analyze')} disabled={analyzeLocked}
                name="Analyze acoustics" tag="slow"
                hint={analyzeLocked
                  ? 'No analysis engine running — start the analyzer or tts-heavy sidecar (or a local librosa venv).'
                  : p.soundsLikeActive
                    ? 'Tempo, key & intro, plus sounds-like fingerprints. The slow step; vocal separation is split out below.'
                    : 'Tempo, key & intro for every track — the slow step. Sounds-like fingerprints are off; enable them on the library page to include them.'} />
              {p.vocalWanted && (
                <div className="pl-6">
                  <Pass on={effAnalyze && steps.vocal} onClick={() => toggleStep('vocal')}
                    disabled={!effAnalyze} name="Vocal activity (Demucs)" tag="very slow"
                    hint={!effAnalyze
                      ? 'Part of acoustic analysis — tick "Analyze acoustics" first.'
                      : 'Source-separate each track to detect instrumental vs vocal. Very heavy on CPU (~10-30s/track) — untick to do bpm/key + sounds-like without it.'} />
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-separator-strong pt-3.5">
              <div className="lib-batch">
                <label htmlFor="modal-batch">Limit</label>
                <select id="modal-batch" value={p.batch} onChange={e => p.setBatch(e.target.value as Batch)}>
                  <option value="100">next 100</option>
                  <option value="500">next 500</option>
                  <option value="5000">next 5,000</option>
                  <option value="10000">next 10,000</option>
                  <option value="all">all{p.remaining != null ? ` ${num(p.remaining)}` : ''} remaining</option>
                </select>
              </div>
              <div className="flex items-center gap-2.5">
                <Btn onClick={() => p.onOpenChange(false)}>Cancel</Btn>
                <Btn lg tone="accent" onClick={startRun} disabled={!anyStep || p.busy}>
                  <Play size={13} /> {onlyReconcile ? 'Reconcile' : 'Start'}
                </Btn>
              </div>
            </div>
          </>
        )}

        {/* -------------------------------------------------------------- RE-SCAN */}
        {tab === 'rescan' && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
              <span className="max-w-[52ch] text-[12px] leading-[1.55] text-muted">
                Redo work you&rsquo;ve already done — only needed after changing the LLM,
                embedding model, or analysis engine. Each pass touches only tracks it
                already processed; never your untagged backlog (that&rsquo;s the Run tab).
              </span>
              <button
                type="button"
                className="shrink-0 text-[11px] font-bold text-vermilion underline-offset-2 hover:underline disabled:opacity-40"
                disabled={p.busy}
                onClick={() => setPasses(passAllSelected
                  ? { reseed: false, reEnrich: false, reAnalyze: false, upgrade: false }
                  : { reseed: true, reEnrich: true, reAnalyze: true, upgrade: true })}
              >
                {passAllSelected ? 'Clear all' : 'Select all'}
              </button>
            </div>
            {/* ordered to mirror the Run pipeline: enrich → embed → tag → analyse */}
            <div className="grid gap-2.5">
              <Pass on={!!passes.reEnrich} onClick={() => togglePass('reEnrich')} name="Re-enrich metadata" tag="network"
                hint="Re-fetch Last.fm tags + lyrics for tracks you've already enriched. External API calls — slow on a big library." />
              <Pass on={!!passes.reseed} onClick={() => togglePass('reseed')} name="Re-embed all tracks" tag="slow"
                hint={`Drop & rebuild the similarity vectors for your whole library${p.libraryTotal != null ? ` (${num(p.libraryTotal)} tracks)` : ''} at the current embedding model — not just tagged tracks. Re-spends embedding calls; only needed after a model change. Your mood tags are kept.`} />
              {reseedOnly && (
                <div className="pl-6">
                  <Pass on={thenTag} onClick={() => setThenTag(v => !v)}
                    name="Then tag untagged tracks" tag="AI · billed"
                    hint="Continue into the forward tag pass once vectors are rebuilt — tags all remaining untagged tracks in the same run, so you don't have to come back and start it. Uses model calls." />
                </div>
              )}
              <Pass on={!!passes.upgrade} onClick={() => togglePass('upgrade')} name="Re-decide moods" tag="AI · billed"
                hint="Re-tag already-tagged rows whose prompt or model has gone stale (never your manual tags). No model change → nothing to redo. Uses model calls." />
              {passes.upgrade && (
                <p className="-mt-1 pl-[26px] text-[11px] leading-[1.5] text-muted">
                  Model calls only for rows with a stale prompt or model — often zero if nothing has changed.
                </p>
              )}
              <Pass on={!!passes.reAnalyze} onClick={() => togglePass('reAnalyze')} name="Re-analyse acoustics" tag="slow"
                hint={p.soundsLikeActive
                  ? "Redo bpm/key + sounds-like for tracks you've already analysed. Drops their acoustic data and rebuilds it."
                  : "Redo bpm/key for tracks you've already analysed. Drops their acoustic data and rebuilds it. Sounds-like is off."} />
              {p.vocalWanted && (
                <div className="pl-6">
                  <Pass on={!!passes.reAnalyze && reAnalyzeVocal} onClick={() => setReAnalyzeVocal(v => !v)}
                    disabled={!passes.reAnalyze} name="Re-analyse vocal (Demucs)" tag="very slow"
                    hint={!passes.reAnalyze
                      ? 'Part of Re-analyse acoustics — tick that first.'
                      : 'Also redo Demucs vocal separation. Untick to keep your existing vocal ranges and skip the slow pass (~10-30s/track).'} />
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2.5 border-t border-dashed border-separator-strong pt-3.5">
              <Btn onClick={() => p.onOpenChange(false)}>Cancel</Btn>
              <Btn tone="accent" disabled={!anyPass || p.busy} onClick={runRescan}>
                <RefreshCw size={12} /> {passAllSelected ? 'Run full re-scan' : 'Run re-scan'}
              </Btn>
            </div>
          </>
        )}

        {/* ---------------------------------------------------------------- RESET */}
        {tab === 'reset' && (
          <>
            <div className="flex items-start gap-2.5 border border-l-[3px] border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2.5 text-[12px] leading-[1.55] text-ink">
              <AlertTriangle size={16} className="mt-px shrink-0 text-vermilion" />
              <span>
                <b>This wipes everything the tagger has learned.</b> It permanently deletes all
                mood &amp; energy tags, similarity embeddings, acoustic analysis (bpm / key /
                loudness / vocal), and Last.fm / lyric enrichment
                {p.libraryTotal != null ? <> for all <b className="mono-num">{num(p.libraryTotal)}</b> tracks</> : ''}.
                Your music in Navidrome is <b>not</b> touched — every track just returns to the
                untagged pool.
              </span>
            </div>
            <p className="text-[12px] leading-[1.55] text-muted">
              There&rsquo;s no undo short of restoring a backup. Afterwards you&rsquo;ll start from{' '}
              <b>0%</b> and need a fresh <b>Run</b> (including the slow acoustic + embedding passes)
              to rebuild coverage. Use this only to start completely clean — for a model change,
              the <b>Re-scan</b> tab redoes just the affected work and keeps your tags.
            </p>
            {/* first confirmation — arm the action */}
            <button
              type="button"
              role="checkbox"
              aria-checked={resetAck}
              className={cn('lib-pass', resetAck && 'on')}
              onClick={() => setResetAck(v => !v)}
              disabled={p.busy}
            >
              <span className="box">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6.2L4.8 8.5L9.5 3.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span>
                <span className="lib-pass-name">I understand this permanently deletes all tagging data</span>
                <span className="lib-pass-hint">
                  Tags, embeddings, and acoustic analysis for the whole library are erased and cannot be recovered.
                </span>
              </span>
            </button>
            <div className="flex items-center justify-end gap-2.5 border-t border-dashed border-separator-strong pt-3.5">
              <Btn onClick={() => p.onOpenChange(false)}>Cancel</Btn>
              {/* second confirmation happens in the danger dialog this opens */}
              <Btn tone="danger" disabled={!resetAck || p.busy} onClick={() => setConfirmReset(true)}>
                <Trash2 size={12} /> Reset library…
              </Btn>
            </div>
          </>
        )}
      </div>

      <V3AlertDialog
        open={confirmRescan}
        onOpenChange={setConfirmRescan}
        title={p.libraryTotal != null ? `Re-embed all ${num(p.libraryTotal)} tracks?` : 'Re-embed the whole library?'}
        description={`This rebuilds ${p.libraryTotal != null ? `all ${num(p.libraryTotal)} ` : 'every '}similarity vectors from scratch — the whole library, not just tagged tracks — re-spending embedding calls (can take several minutes on a large library, longer with a heavier model). Existing mood tags are kept and reused as seeds. Only needed after changing the embedding model.${reseedOnly && thenTag ? ' It then continues into the forward tag pass, tagging every remaining untagged track in the same run (uses model calls).' : ''}`}
        confirmLabel="re-scan"
        danger
        onConfirm={() => { p.onRescan(rescanPayload()); clearPasses(); setConfirmRescan(false); p.onOpenChange(false); }}
      />

      <V3AlertDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={p.libraryTotal != null ? `Delete all tagging data for ${num(p.libraryTotal)} tracks?` : 'Delete all tagging data?'}
        description={`This permanently erases every mood/energy tag, similarity embedding, acoustic-analysis result (bpm, key, loudness, vocal), and Last.fm/lyric enrichment${p.libraryTotal != null ? ` across all ${num(p.libraryTotal)} tracks` : ''}. Your music in Navidrome is not affected — but there is no undo short of restoring a backup, and rebuilding coverage means a full tag + analysis run from scratch.`}
        confirmLabel="Delete everything"
        danger
        onConfirm={() => { p.onReset(); setConfirmReset(false); setResetAck(false); p.onOpenChange(false); }}
      />
    </Modal>
  );
}

// Checkbox-style toggle row, shared by the Run steps and the Re-scan passes.
function Pass({ on, onClick, name, hint, disabled, tag }: {
  on: boolean; onClick: () => void; name: string; hint: string; disabled?: boolean; tag?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      className={cn('lib-pass', on && 'on')}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="box">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.2L4.8 8.5L9.5 3.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span>
        <span className="lib-pass-name">
          {name}
          {tag && <span className="ml-2 inline-block align-[1.5px]"><Chip>{tag}</Chip></span>}
        </span>
        <span className="lib-pass-hint">{hint}</span>
      </span>
    </button>
  );
}

// Client mirror of controller/src/music/tag-library.ts `autoSeedCount` — the
// up-front LLM seed budget (~4% of the library, floored 200, capped 2500). Kept
// here so the Run-tab cost preview can show a figure without a round-trip; the
// backend copy is authoritative. MIRROR: keep the 200 / 2500 / 0.04 constants in
// sync with tag-library.ts (a comment there points back here).
function seedBudget(librarySize: number): number {
  return Math.max(200, Math.min(2500, Math.round(librarySize * 0.04)));
}

// Small uppercase cost/characteristic badge — quick / network / AI · billed /
// slow / very slow. Shared by the step rows and the Acoustic & audio headers.
function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-[3px] border border-separator-strong bg-[var(--ink-soft)] px-1.5 py-px text-[9px] font-bold tracking-[0.08em] text-muted uppercase">
      {children}
    </span>
  );
}
