'use client';

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notify } from '../../../lib/notify';
import { AdminResponseError, adminJson, adminResponse } from '../../../lib/admin-query';
import { llmProviderLabel } from '../llm/providerMeta';
import { patchSettingsAudio, settingsKeys } from '../settings/queries';
import { useLibrary } from './LibraryContext';
import { libraryKeys } from './queries';
import { useAdminMutation, useAdminQuery, type AdminFetch } from './useAdminQuery';
import type {
  AnalysisFailure,
  Batch,
  BudgetMode,
  LibraryStatsLite,
  RescanOpts,
  TagSteps,
} from '../LibraryTaggingPanel';
import type { SettingsResponse } from './types';

// The tagging/analysis half of the library page: the slow /settings poll and
// every operator action the Tagging panel fires.
//
// The two FAST loops (coverage + the tagger snapshot) live in LibraryContext,
// since the tagger snapshot sets the coverage cadence and Search reads coverage
// too. This slow loop never touches tagger state, which is what keeps the two
// from racing.

// POST /settings with one nested block, the shape all four toggles share.
async function postAudioSetting(
  fetcher: AdminFetch, patch: Record<string, unknown>,
): Promise<void> {
  await adminJson(fetcher, '/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: patch }),
  });
}

// POST a tagger/analysis start. They differ only in path, body and the message
// their failure carries.
function startRun(path: string, body: unknown, what: string) {
  return async (fetcher: AdminFetch): Promise<void> => {
    try {
      await adminJson(fetcher, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof AdminResponseError) {
        const detail = typeof error.body.error === 'string' ? error.body.error : null;
        throw new Error(detail || `${what} (${error.status})`);
      }
      throw error;
    }
  };
}

export function useTaggerControls() {
  const { adminFetch, ready, coverage, reloadCoverage, tagger } = useLibrary();
  const qc = useQueryClient();

  const [batch, setBatch] = useState<Batch>('500');
  const [logOpen, setLogOpen] = useState(false);

  // Slow loop: the rarely-changing settings-derived bits. Silent on failure —
  // a 30s poll that toasts on a blip is noise.
  const settingsQuery = useAdminQuery<SettingsResponse>({
    key: settingsKeys.detail(),
    path: '/settings',
    refetchInterval: 30_000,
    staleTime: 0,
  });
  const settings = settingsQuery.data;
  const failuresQuery = useAdminQuery<{ failures?: AnalysisFailure[] }>({
    key: libraryKeys.analysisFailures(),
    path: '/library/analysis-failures?limit=200',
    enabled: false,
  });
  const failures = failuresQuery.data?.failures ?? null;

  const libStats: LibraryStatsLite | null = settings?.libraryStats ?? null;
  const audio = settings?.values?.audio;
  // null until the first poll lands — the toggles render disabled until then.
  const audioEnabled = audio ? !!audio.embeddings : null;
  const vocalEnabled = audio ? !!audio.vocalActivity : null;
  const quietEnabled = audio ? !!audio.analyzeQuietOnly : null;
  const quietMins = audio
    ? (typeof audio.analyzeQuietMinutes === 'number' ? audio.analyzeQuietMinutes : 10)
    : null;
  // Absent on an old controller → the modal omits the tier.
  const budgetMode: BudgetMode | null = settings?.budget?.mode ?? null;

  // Which provider each tagging cost bills to (#1162). A blank embedding
  // provider follows the LLM provider; the embedding model shows only when
  // explicitly set (the default resolution table lives in Settings).
  const llm = settings?.values?.llm;
  const emb = settings?.values?.embedding;
  const llmLabel = llm?.provider
    ? llmProviderLabel(llm.provider) + (llm.model ? ` · ${llm.model}` : '')
    : null;
  const embedLabel = llm?.provider
    ? llmProviderLabel(emb?.provider || llm.provider) + (emb?.model ? ` · ${emb.model}` : '')
    : null;

  const reloadSettings = useCallback(
    () => qc.invalidateQueries({ queryKey: settingsKeys.detail() }),
    [qc],
  );
  const reloadTagger = useCallback(
    () => qc.invalidateQueries({ queryKey: libraryKeys.tagger() }),
    [qc],
  );

  // Per-track analysis failures (#1300 bug 3c). The disabled query is fetched
  // only on demand: `coverage.analysisFailed` already says whether there is
  // anything to look at, and on a healthy station that is zero forever.
  const loadFailures = useCallback(async () => {
    if (!ready) return;
    await failuresQuery.refetch();
  }, [failuresQuery, ready]);

  // Forget the failure history so the next run retries these tracks — the
  // operator's move after fixing the cause. Refreshes coverage so the banner
  // (driven by the count, not the list) goes away.
  const clearFailures = useCallback(async () => {
    if (!ready) return;
    try {
      await adminResponse(adminFetch, '/library/analysis-failures/clear', { method: 'POST' });
      qc.setQueryData(libraryKeys.analysisFailures(), { failures: [] });
      void reloadCoverage();
    } catch { /* transient */ }
  }, [adminFetch, qc, ready, reloadCoverage]);

  const remaining = coverage?.total != null ? Math.max(0, coverage.total - coverage.tagged) : null;

  // --- the runs ------------------------------------------------------------
  // Each opens the log and refreshes the tagger snapshot; failures toast
  // through useAdminMutation's shared onError.

  const startM = useAdminMutation<void, TagSteps | undefined>({
    request: (steps, fetcher) => {
      const limit = batch === 'all' ? null : parseInt(batch, 10);
      const body: Record<string, unknown> = limit && limit > 0 ? { limit } : {};
      // Absent on the legacy "Tag all" quick action, which sends a plain full run.
      if (steps) Object.assign(body, steps);
      return startRun('/tag-library', body, 'tagger start failed')(fetcher);
    },
    onDone: () => { notify.ok('tagger started'); setLogOpen(true); void reloadTagger(); },
  });

  const stopM = useAdminMutation<void, void>({
    request: async (_v, fetcher) => {
      await adminResponse(fetcher, '/tag-library/stop', { method: 'POST' });
    },
    onDone: () => { notify.ok('stopping tagger…'); void reloadTagger(); },
  });

  // Each opt maps to a tag-library CLI flag (reseed / reEnrich / reAnalyze /
  // upgrade). Sends no limit — a partial reseed leaves the library in a mixed
  // state KNN can't use, and `thenTag` continues into a full forward pass.
  const rescanM = useAdminMutation<void, RescanOpts>({
    request: (opts, fetcher) => startRun('/tag-library', opts, 're-scan failed')(fetcher),
    onDone: () => { notify.ok('re-scan started…'); setLogOpen(true); void reloadTagger(); },
  });

  // Prunes library entries whose tracks no longer exist in Navidrome. No
  // LLM/embedding cost, and it reuses the tagger's single-flight slot.
  const reconcileM = useAdminMutation<void, void>({
    request: (_v, fetcher) => startRun('/library/reconcile', {}, 'reconcile failed')(fetcher),
    onDone: () => {
      notify.ok('reconcile started, scanning Navidrome');
      setLogOpen(true);
      void reloadTagger();
    },
  });

  // Runs as a background child on the tagger's single-flight state.
  const analyzeM = useAdminMutation<void, void>({
    request: (_v, fetcher) => startRun('/library/analyze', {}, 'analysis start failed')(fetcher),
    onDone: () => { notify.ok('audio analysis started'); setLogOpen(true); void reloadTagger(); },
  });

  // vocal:true forces the analyze pass into the vocal scope (#646).
  const vocalBackfillM = useAdminMutation<void, void>({
    request: (_v, fetcher) =>
      startRun('/library/analyze', { vocal: true }, 'vocal analysis start failed')(fetcher),
    onDone: () => { notify.ok('vocal analysis started'); setLogOpen(true); void reloadTagger(); },
  });

  // Deletes library.db server-side; Navidrome is untouched, so every track
  // returns to the untagged pool. Refused (409) while a tagger run is active.
  const resetM = useAdminMutation<void, void>({
    request: (_v, fetcher) => startRun('/library/reset', {}, 'reset failed')(fetcher),
    onDone: async (_d, _v, client) => {
      notify.ok('library reset — all tagging data wiped');
      // Everything under ['library'] — every row list, plus coverage and the
      // library stats.
      await client.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });

  // --- the toggles ---------------------------------------------------------
  // Each writes the flipped value straight into the cached /settings body
  // before invalidating, so the switch moves at once rather than waiting out
  // the poll.
  const patchAudioSetting = useCallback((patch: Record<string, unknown>) => {
    patchSettingsAudio(qc, patch);
    void reloadSettings();
  }, [qc, reloadSettings]);

  // Flips settings.audio.embeddings (the CLAP opt-in). Only persists the
  // setting — vectors appear after an analysis run.
  const toggleAudioM = useAdminMutation<boolean, boolean>({
    request: async (next, fetcher) => {
      await postAudioSetting(fetcher, { embeddings: next });
      return next;
    },
    onDone: next => {
      patchAudioSetting({ embeddings: next });
      // On a lean analyzer, enabling is pending rather than done.
      const audioPending =
        coverage?.analysisAvailable !== false && coverage?.audioAnalysisAvailable === false;
      notify.ok(
        next
          ? audioPending
            ? 'sounds-like enabled — starts once the heavy analyzer is up'
            : 'sounds-like analysis enabled'
          : 'sounds-like analysis disabled',
      );
    },
  });

  // Demucs vocal-activity opt-in (#646). Env ANALYZE_VOCAL_ACTIVITY still wins "on".
  const toggleVocalM = useAdminMutation<boolean, boolean>({
    request: async (next, fetcher) => {
      await postAudioSetting(fetcher, { vocalActivity: next });
      return next;
    },
    onDone: next => {
      patchAudioSetting({ vocalActivity: next });
      // Mirrors toggleAudio: enabling on a lean analyzer is "armed", not active.
      const vocalPending =
        coverage?.analysisAvailable !== false && coverage?.vocalAnalysisAvailable === false;
      notify.ok(
        next
          ? vocalPending
            ? 'vocal-activity enabled — starts once the heavy analyzer is up'
            : 'vocal-activity analysis enabled'
          : 'vocal-activity analysis disabled',
      );
      // The coverage-driven bits (vocalStatus, the vocal meter row) shouldn't
      // wait out the 60s poll.
      void reloadCoverage();
    },
  });

  // Quiet-times gate (#1099): analysis pauses while listeners are tuned in. The
  // pass re-reads the toggle from disk on every check, so a flip takes effect
  // mid-run; env ANALYZE_QUIET_ONLY still wins "on".
  const toggleQuietM = useAdminMutation<boolean, boolean>({
    request: async (next, fetcher) => {
      await postAudioSetting(fetcher, { analyzeQuietOnly: next });
      return next;
    },
    onDone: next => {
      patchAudioSetting({ analyzeQuietOnly: next });
      notify.ok(
        next
          ? 'quiet times on — analysis pauses while anyone is listening'
          : 'quiet times off — analysis runs regardless of listeners',
      );
    },
  });

  // Idle window for the quiet-times gate, in minutes (1–120).
  const saveQuietMinutesM = useAdminMutation<number, number>({
    request: async (minutes, fetcher) => {
      await postAudioSetting(fetcher, { analyzeQuietMinutes: minutes });
      return minutes;
    },
    onDone: minutes => {
      patchAudioSetting({ analyzeQuietMinutes: minutes });
      notify.ok(`quiet window set — analysis resumes after ${minutes} min with no listeners`);
    },
  });

  // One shared busy flag: the Tagging panel disables every control while any
  // of them is in flight.
  const busy = [
    startM, stopM, rescanM, reconcileM, analyzeM, vocalBackfillM, resetM,
    toggleAudioM, toggleVocalM, toggleQuietM, saveQuietMinutesM,
  ].some(m => m.isPending);

  return {
    coverage, remaining, tagger, libStats, failures,
    batch, setBatch, busy, logOpen, setLogOpen,
    audioEnabled, vocalEnabled, quietEnabled, quietMins, budgetMode,
    llmLabel, embedLabel,
    startTagger: (steps?: TagSteps) => { startM.mutate(steps); },
    stopTagger: () => { stopM.mutate(); },
    rescanTagger: (opts: RescanOpts) => { rescanM.mutate(opts); },
    reconcile: () => { reconcileM.mutate(); },
    resetLibrary: () => { resetM.mutate(); },
    analyzeAudio: () => { analyzeM.mutate(); },
    vocalBackfill: () => { vocalBackfillM.mutate(); },
    // The panel's switches send no argument, so the flip is computed here. The
    // `== null` guard stops a toggle firing before the first /settings poll
    // lands and writing `!null` = true over a real `true`.
    toggleAudio: () => { if (audioEnabled != null) toggleAudioM.mutate(!audioEnabled); },
    toggleVocal: () => { if (vocalEnabled != null) toggleVocalM.mutate(!vocalEnabled); },
    toggleQuiet: () => { if (quietEnabled != null) toggleQuietM.mutate(!quietEnabled); },
    saveQuietMinutes: (minutes: number) => { saveQuietMinutesM.mutate(minutes); },
    loadFailures, clearFailures,
  };
}
