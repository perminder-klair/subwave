'use client';

// The single "Tagging" modal opened from the library panel's primary button.
// Three tabs, one per intent:
//   • Run            — pick which pipeline steps run, then start a forward run
//   • Acoustic & audio — the optional bpm/key + sounds-like (CLAP) controls
//   • Re-scan        — maintenance passes that redo work after a model change
// The panel keeps every status meter; this modal owns the *actions*.

import { useEffect, useState } from 'react';
import { Play, RefreshCw, Activity } from 'lucide-react';
import { Modal } from '../ui/modal';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Btn } from './ui';
import { cn } from '../../lib/cn';
import type { Batch, RescanOpts, TagSteps } from './LibraryTaggingPanel';
import { num } from './LibraryTaggingPanel';

type Tab = 'run' | 'audio' | 'rescan';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // state
  batch: Batch;
  setBatch: (b: Batch) => void;
  busy: boolean;
  remaining: number | null;
  // coverage-derived availability
  analysisOff: boolean;
  audioIncapable: boolean;
  audioOn: boolean;
  audioEnabled: boolean | null;
  // vocal-activity (Demucs) controls (#646). The Enable toggle is always shown
  // here (this advanced tab is the opt-in surface, parallel to sounds-like) so
  // it stays reachable; the panel's coverage *row* is what hides by default.
  vocalIncapable: boolean;
  vocalOn: boolean;
  vocalEnabled: boolean | null;
  // Whether vocal is opted-in (env/settings) — gates the Run tab's per-run
  // "Vocal activity (Demucs)" sub-checkbox so it stays hidden by default (#646).
  vocalWanted: boolean;
  // when set, the modal opens straight to the matching tab/selection
  intent: 'reembed' | null;
  // handlers
  onStart: (steps?: TagSteps) => void;
  onReconcile: () => void;
  onRescan: (opts: RescanOpts) => void;
  onAnalyzeAudio: () => void;
  onToggleAudio: () => void;
  onToggleVocal: () => void;
  onVocalBackfill: () => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'run', label: 'Run' },
  { key: 'audio', label: 'Acoustic & audio' },
  { key: 'rescan', label: 'Re-scan' },
];

export default function LibraryTaggingModal(p: Props) {
  const [tab, setTab] = useState<Tab>('run');

  // Run-tab step selection — all on by default (today's full-run behaviour).
  const [steps, setSteps] = useState<TagSteps>({
    reconcile: true, enrich: true, tagMoods: true, analyze: true, vocal: true,
  });
  const toggleStep = (k: keyof TagSteps) => setSteps(s => ({ ...s, [k]: !s[k] }));

  // Re-scan passes (moved here from the panel's old maintenance drawer).
  const [passes, setPasses] = useState<RescanOpts>({
    reseed: false, reEnrich: false, reAnalyze: false, upgrade: false,
  });
  const [confirmRescan, setConfirmRescan] = useState(false);
  const togglePass = (k: keyof RescanOpts) => setPasses(prev => ({ ...prev, [k]: !prev[k] }));
  const passAllSelected = !!(passes.reseed && passes.reEnrich && passes.reAnalyze && passes.upgrade);
  const anyPass = !!(passes.reseed || passes.reEnrich || passes.reAnalyze || passes.upgrade);
  const clearPasses = () => setPasses({ reseed: false, reEnrich: false, reAnalyze: false, upgrade: false });

  // On each open, reset to a sensible tab. A 'reembed' intent (the panel's
  // "embeddings missing" nudge) jumps to Re-scan with re-embed pre-ticked.
  useEffect(() => {
    if (!p.open) return;
    if (p.intent === 'reembed') {
      setTab('rescan');
      setPasses({ reseed: true, reEnrich: false, reAnalyze: false, upgrade: false });
    } else {
      setTab('run');
    }
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

  const startRun = () => {
    if (!anyStep || p.busy) return;
    // A reconcile-only selection is the existing walk+prune endpoint.
    if (onlyReconcile) p.onReconcile();
    else p.onStart(effSteps);
    p.onOpenChange(false);
  };

  const runRescan = () => {
    if (!anyPass || p.busy) return;
    // Re-embedding re-spends embedding calls — confirm first; lighter passes go.
    if (passes.reseed) { setConfirmRescan(true); return; }
    p.onRescan(passes);
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
              <Pass on={effSteps.analyze} onClick={() => toggleStep('analyze')} disabled={analyzeLocked}
                name="Analyze acoustics" tag="slow"
                hint={analyzeLocked
                  ? 'No analysis engine running — start the tts-heavy sidecar or a local librosa venv.'
                  : 'Tempo, key & intro, plus sounds-like fingerprints when enabled. The slow step; vocal separation is split out below.'} />
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

        {/* ------------------------------------------------------ ACOUSTIC & AUDIO */}
        {tab === 'audio' && (
          <>
            <p className="text-[12px] leading-[1.55] text-muted">
              Optional acoustic analysis. Improves beat-matching and enables
              &ldquo;sounds-like&rdquo; picks; tagging works fine without it.
            </p>
            {p.analysisOff ? (
              <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink">
                No analysis engine running. Start the tts-heavy sidecar
                (<code className="font-mono text-[10.5px]">docker compose --profile tts-heavy up -d</code>)
                or configure a local librosa venv, then return here.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="caption flex items-center gap-2"><Activity size={13} /> Audio fingerprint · sounds-like</span>
                  {p.audioEnabled && (
                    <Btn sm tone="accent" onClick={() => { p.onAnalyzeAudio(); p.onOpenChange(false); }} disabled={p.busy || p.audioIncapable}>
                      <Play size={12} /> {p.audioOn ? 'Analyze new tracks' : 'Analyze library'}
                    </Btn>
                  )}
                  <Btn sm onClick={p.onToggleAudio} disabled={p.busy}>
                    {p.audioEnabled ? 'Disable' : 'Enable'}
                  </Btn>
                </div>
                {p.audioIncapable && p.audioEnabled && (
                  <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink">
                    <b>The analysis engine can&rsquo;t fingerprint audio.</b> Pull the latest tts-heavy
                    image and recreate the sidecar:
                    <code className="mt-1 block font-mono text-[10.5px] text-muted">docker compose pull tts-heavy &amp;&amp; docker compose --profile tts-heavy up -d tts-heavy</code>
                  </div>
                )}
                {/* vocal activity (#646) — Enable always reachable here; the
                    panel's coverage row is what stays hidden until opted in */}
                <div className="flex flex-col gap-2.5 border-t border-dashed border-separator-strong pt-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="caption flex items-center gap-2"><Activity size={13} /> Vocal activity · instrumental detection</span>
                      {p.vocalEnabled && (
                        <Btn sm tone="accent" onClick={() => { p.onVocalBackfill(); p.onOpenChange(false); }} disabled={p.busy || p.vocalIncapable}>
                          <Play size={12} /> {p.vocalOn ? 'Backfill missing' : 'Analyze vocals'}
                        </Btn>
                      )}
                      <Btn sm onClick={p.onToggleVocal} disabled={p.busy}>
                        {p.vocalEnabled ? 'Disable' : 'Enable'}
                      </Btn>
                    </div>
                    <p className="caption !tracking-[0.04em] !normal-case">
                      Separates vocals from the mix so the DJ can tell instrumental vs vocal tracks and
                      time talk before lyrics. Expensive — runs on the analysis engine.
                    </p>
                    {p.vocalIncapable && p.vocalEnabled && (
                      <div className="border border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-[1.5] text-ink">
                        <b>The analysis engine can&rsquo;t separate vocals.</b> Rebuild the tts-heavy
                        sidecar with Demucs:
                        <code className="mt-1 block font-mono text-[10.5px] text-muted">docker compose build --build-arg WITH_DEMUCS=1 tts-heavy &amp;&amp; docker compose --profile tts-heavy up -d tts-heavy</code>
                      </div>
                    )}
                  </div>
              </div>
            )}
            <div className="flex justify-end border-t border-dashed border-separator-strong pt-3.5">
              <Btn onClick={() => p.onOpenChange(false)}>Done</Btn>
            </div>
          </>
        )}

        {/* -------------------------------------------------------------- RE-SCAN */}
        {tab === 'rescan' && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5">
              <span className="max-w-[52ch] text-[12px] leading-[1.55] text-muted">
                Only needed after changing the LLM, embedding model, or analysis engine.
                Existing mood tags are kept as seeds.
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
            <div className="grid gap-2.5">
              <Pass on={!!passes.reseed} onClick={() => togglePass('reseed')} name="Re-embed all tracks"
                hint="Drop & rebuild every vector. Run after changing the embedding model." />
              <Pass on={!!passes.reEnrich} onClick={() => togglePass('reEnrich')} name="Re-enrich metadata"
                hint="Re-fetch Last.fm tags + lyrics that feed the tagging." />
              <Pass on={!!passes.reAnalyze} onClick={() => togglePass('reAnalyze')} name="Re-analyse acoustics"
                hint="Redo BPM / key for every track. Also refreshes sounds-like fingerprints when enabled." />
              <Pass on={!!passes.upgrade} onClick={() => togglePass('upgrade')} name="Re-decide moods"
                hint="Re-tag tracks whose prompt or model is now stale." />
            </div>
            <div className="flex items-center justify-end gap-2.5 border-t border-dashed border-separator-strong pt-3.5">
              <Btn onClick={() => p.onOpenChange(false)}>Cancel</Btn>
              <Btn tone="accent" disabled={!anyPass || p.busy} onClick={runRescan}>
                <RefreshCw size={12} /> {passAllSelected ? 'Run full re-scan' : 'Run re-scan'}
              </Btn>
            </div>
          </>
        )}
      </div>

      <V3AlertDialog
        open={confirmRescan}
        onOpenChange={setConfirmRescan}
        title="Re-embed the whole library?"
        description="This pass drops and rebuilds every similarity vector from scratch, which re-spends embedding calls and can take several minutes on a large library. Existing mood tags are kept and reused as seeds. Only needed after changing the embedding model."
        confirmLabel="re-scan"
        danger
        onConfirm={() => { p.onRescan(passes); clearPasses(); setConfirmRescan(false); p.onOpenChange(false); }}
      />
    </Modal>
  );
}

// Checkbox-style toggle row, shared by the Run steps and the Re-scan passes.
function Pass({ on, onClick, name, hint, disabled, tag }: {
  on: boolean; onClick: () => void; name: string; hint: string; disabled?: boolean; tag?: string;
}) {
  return (
    <button type="button" className={cn('lib-pass', on && 'on')} onClick={onClick} disabled={disabled}>
      <span className="box">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.2L4.8 8.5L9.5 3.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span>
        <span className="lib-pass-name">
          {name}
          {tag && (
            <span className="ml-2 rounded-[3px] border border-separator-strong bg-[var(--ink-soft)] px-1.5 py-px align-[1.5px] text-[9px] font-bold tracking-[0.08em] text-muted uppercase">
              {tag}
            </span>
          )}
        </span>
        <span className="lib-pass-hint">{hint}</span>
      </span>
    </button>
  );
}
