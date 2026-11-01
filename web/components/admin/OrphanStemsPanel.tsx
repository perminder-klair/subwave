'use client';

// Orphan stem dirs: what the cache holds for tracks that left the
// library, and the presses about it. A dry-run report is the default read
// (GET never moves anything), and it only ever says what a pass WOULD do. The
// run button asks once, naming the counts, then runs a confirmed pass, and what
// that pass really did shows beside the report ("Last pass"), failures and
// refusals included: the dry run read back afterwards cannot know them.
// Only a pass moves anything. With the daily pass off (the default) the button
// is that pass, so it stays live while anything is due: aged quarantines to
// delete and returned tracks to release, not just new orphans. A released
// track's blends work again at once, though its first analysis as a new track
// still runs Demucs. The daily cron behind the toggle is off by default —
// deleting operator files is opt-in, and a first pass should be read, not
// trusted (#1570 rule).
// The dirs are named by track id and the library no longer knows them, so
// raw ids told an operator nothing: "Show tracks" pulls the readable list
// (GET /stems/orphans/tracks resolves title/artist/album from the plays
// snapshot, the recent-plays sidecar and the event logs) into a fold under
// the stats.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { adminJson, useAdminMutation, useAdminQuery } from '../../lib/admin-query';
import type { AdminFetch } from '../../lib/admin-query';
import { errorMessage } from '../../lib/notify';
import { Card, Btn, Pill } from './ui';
import { settingsKeys } from './settings/queries';
import { V3AlertDialog } from '../ui/alert-dialog';

export interface OrphanReport {
  dryRun: boolean;
  keptCount: number;
  quarantined: number;
  quarantinedNames: string[];
  released: string[];
  deletedCount: number;
  deletedNames: string[];
  agingCount: number;
  supersededCount: number;
  inFlight: number;
  failed: number;
  refused?: boolean;
  reason?: string;
  /** Why the automatic pass would refuse this plan; a manual confirm still runs. */
  autoRefusal?: string;
  freedBytes: number;
  offline?: string;
}

interface OrphanState {
  enabled: boolean;
  report: OrphanReport;
}

/** A toggle answers with `enabled` alone: it moves nothing, so it spends no walk. */
interface OrphanPayload {
  enabled: boolean;
  report?: OrphanReport;
}

interface OrphanVars {
  confirm?: boolean;
  setEnabled?: boolean;
}

interface OrphanTrackRow {
  id: string;
  state: 'orphan' | 'quarantined';
  title: string | null;
  artist: string | null;
  album: string | null;
}

interface OrphanTracks {
  tracks: OrphanTrackRow[];
}

const orphanKeys = {
  all: ['stems', 'orphans'] as const,
  state: () => [...orphanKeys.all, 'state'] as const,
  tracks: () => [...orphanKeys.all, 'tracks'] as const,
};

export function fetchOrphanState(fetcher: AdminFetch, signal?: AbortSignal) {
  return adminJson<OrphanState>(fetcher, '/stems/orphans', undefined, signal);
}

export function fetchOrphanTracks(fetcher: AdminFetch, signal?: AbortSignal) {
  return adminJson<OrphanTracks>(fetcher, '/stems/orphans/tracks', undefined, signal);
}

function useOrphanState(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<OrphanState>({
    key: orphanKeys.state(),
    adminFetch,
    enabled,
    request: fetchOrphanState,
  });
}

// Lazy: the event-log tail behind the name resolution costs real I/O, so the
// list fetches on the first open of the fold, not on every panel paint.
function useOrphanTracks(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<OrphanTracks>({
    key: orphanKeys.tracks(),
    adminFetch,
    enabled,
    request: fetchOrphanTracks,
  });
}

function useOrphanMutation(adminFetch: AdminFetch) {
  return useAdminMutation<OrphanPayload, OrphanVars>({
    adminFetch,
    request: (vars, fetcher) =>
      adminJson<OrphanPayload>(fetcher, '/stems/orphans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(vars),
      }),
    onDone: (data, vars, client) => {
      if (!vars.confirm) {
        client.setQueryData<OrphanState>(orphanKeys.state(), prev => (prev ? { ...prev, enabled: data.enabled } : prev));
        return;
      }
      // A pass changed the cache: the report, the track list and the size
      // beside the budget (the pass dropped its snapshot) are all stale.
      void client.invalidateQueries({ queryKey: orphanKeys.all });
      void client.invalidateQueries({ queryKey: settingsKeys.stemUsage() });
    },
  });
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const plural = (n: number, noun: string) => `${n.toLocaleString('en-GB')} ${noun}${n === 1 ? '' : 's'}`;
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const ORPHAN_CARD_SUB = 'A track that leaves the library keeps its Demucs stem dirs until the byte budget evicts them. This finds those dirs, parks them in a quarantine for a week (a track that comes back gets them released, so its blends work again at once, though its first analysis as a new track still runs Demucs), and deletes what ages out.';

/** Everything a confirmed pass would do. The run button is live while it is not zero. */
export function pendingWork(report: OrphanReport): number {
  return report.quarantined + report.released.length + report.deletedCount;
}

export function runLabel(report: OrphanReport): string {
  const parts = [
    report.quarantined ? `move ${report.quarantined}` : '',
    report.released.length ? `release ${report.released.length}` : '',
    report.deletedCount ? `delete ${report.deletedCount}` : '',
  ].filter(Boolean);
  if (parts.length === 0) return 'Nothing to do';
  if (parts.length === 1 && report.quarantined) return `Move ${report.quarantined} to quarantine`;
  return sentence(parts.join(', '));
}

export function runDialog(report: OrphanReport): { title: string; description: string; confirmLabel: string } {
  const movesOnly = report.released.length === 0 && report.deletedCount === 0;
  const lines = [
    report.quarantined ? `${plural(report.quarantined, 'stem folder')} for tracks no longer in the library move into the quarantine.` : '',
    report.released.length ? `${plural(report.released.length, 'quarantined folder')} whose track is back return to the cache.` : '',
    report.deletedCount ? `${plural(report.deletedCount, 'quarantined folder')} past the week are deleted for good.` : '',
    report.quarantined ? 'A track that comes back within a week gets its folder back on the next pass; after a week, the next pass deletes the rest for good. With the daily pass off, the next pass is this button.' : '',
  ].filter(Boolean);
  return {
    title: movesOnly ? 'Move orphan stems to the quarantine' : 'Run the orphan stems cleanup',
    description: lines.join(' '),
    confirmLabel: movesOnly ? 'move to quarantine' : 'run cleanup',
  };
}

/** What a confirmed pass really did: the only place a failure or a refusal shows. */
export function PassResult({ report }: { report: OrphanReport }) {
  if (report.refused) {
    return (
      <p className="text-sm" role="status">
        <Pill tone="accent">refused</Pill>{' '}
        {sentence(report.offline ?? report.reason ?? 'the stems share is not readable')}.
      </p>
    );
  }
  const did = [
    report.quarantined ? `moved ${report.quarantined} to quarantine` : '',
    report.released.length ? `released ${report.released.length}` : '',
    report.deletedCount ? `deleted ${report.deletedCount} (${mb(report.freedBytes)} freed)` : '',
  ].filter(Boolean);
  return (
    <p className="text-sm" role="status">
      <strong>Last pass:</strong> {did.length ? did.join(', ') : 'nothing moved'}.
      {report.failed > 0 && (
        <> <strong className="mono-num">{report.failed}</strong> failed — check ownership/permissions on the stems share.</>
      )}
    </p>
  );
}

// The dry run's own sentence: every clause is what a pass WOULD do.
function DryRunSummary({ report }: { report: OrphanReport }) {
  return (
    <p className="text-sm">
      {report.quarantined > 0 ? (
        <>
          <strong className="mono-num">{report.quarantined}</strong> orphan dir
          {report.quarantined === 1 ? '' : 's'} found
          {report.inFlight > 0 ? ` (${report.inFlight} still being written, skipped)` : ''}.
        </>
      ) : (
        <>No orphan stem dirs{report.inFlight > 0 ? ` (${report.inFlight} in-flight skipped)` : ''}.</>
      )}
      {report.agingCount > 0 && (
        <> <strong className="mono-num">{report.agingCount}</strong> already in quarantine, aging.</>
      )}
      {report.deletedCount > 0 && (
        <> <strong className="mono-num">{report.deletedCount}</strong> past the week, ready to delete.</>
      )}
      {report.released.length > 0 && (
        <> <strong className="mono-num">{report.released.length}</strong> back in the library, ready to release.</>
      )}
    </p>
  );
}

export interface OrphanReportViewProps {
  report: OrphanReport;
  enabled: boolean;
  /** The report of the last confirmed pass this page ran, if any. */
  lastPass: OrphanReport | null;
  busy: boolean;
  scanning: boolean;
  showTracks: boolean;
  onToggleTracks: () => void;
  onRun: () => void;
  onRescan: () => void;
  onToggleDaily: () => void;
  /** The track fold, shown under the controls. */
  children?: ReactNode;
}

export function OrphanReportView({
  report, enabled, lastPass, busy, scanning, showTracks, onToggleTracks, onRun, onRescan, onToggleDaily, children,
}: OrphanReportViewProps) {
  const pending = pendingWork(report);
  return (
    <div className="flex flex-col gap-3">
      {report.refused ? (
        <p className="text-sm text-muted">
          <Pill tone="accent">refused</Pill>{' '}
          {report.offline ?? report.reason ?? 'the stems share is not readable'} — nothing was moved.
        </p>
      ) : (
        <DryRunSummary report={report} />
      )}
      {lastPass && <PassResult report={lastPass} />}
      {enabled && report.autoRefusal && (
        <p className="text-sm text-muted">
          <Pill tone="accent">daily pass held</Pill> {sentence(report.autoRefusal)}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Btn
          sm
          disabled={busy}
          onClick={onToggleTracks}
          title="The dirs by track name — resolved from play history and the event log; ids with no surviving name stay listed, unknown."
        >
          {showTracks ? 'Hide tracks' : `Show tracks (${report.quarantined + report.agingCount})`}
        </Btn>
        <Btn sm tone="solid" disabled={pending === 0 || busy} onClick={onRun}>
          {busy ? 'Working…' : runLabel(report)}
        </Btn>
        <Btn
          sm
          disabled={busy || scanning}
          onClick={onRescan}
          title="Re-reads the cache root and the quarantine (a few seconds on a big share)."
        >
          {scanning ? 'Scanning…' : 'Re-scan'}
        </Btn>
        <Pill
          dot
          tone="ink"
          pressed={enabled}
          disabled={busy}
          onClick={onToggleDaily}
          title={`The daily pass moves new orphans, gives folders back to tracks that returned, and deletes what has aged a week. Click to turn it ${enabled ? 'off' : 'on'}.`}
          /* tone="ink" carries the visible border — the default badge border is
             --separator-strong at ~10% alpha, which on a card reads as a
             border-less float next to the bordered action buttons. The state
             colour rides on text/dot only, and follows the theme's accent —
             the same figure the "on air" / stem-cache header metrics light
             with — so "on" is one colour across the page, not a second green. */
          className={enabled ? 'text-[color:var(--accent)]' : 'text-muted-foreground'}
        >
          Daily pass {enabled ? 'on' : 'off'}
        </Pill>
      </div>
      {children}
      <p className="text-[12px] text-muted">
        Quarantine holds each orphan for 7 days under <code>.orphan-quarantine</code> at the cache
        root — a move, not a copy, and invisible to every walk. This report is a dry run: nothing
        moved until you press it or the daily pass runs (off by default). With the daily pass off,
        nothing ages out or comes back on its own: that waits for this button.
      </p>
    </div>
  );
}

function TrackRow({ track }: { track: OrphanTrackRow }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 border-b border-[var(--separator-soft)] py-1.5 last:border-0">
      <div className="min-w-0">
        {track.title ? (
          <span className="text-[13px]">
            {track.title}
            {track.artist ? <span className="text-muted"> — {track.artist}</span> : null}
            {track.album ? <span className="text-muted"> · {track.album}</span> : null}
          </span>
        ) : (
          <span className="text-[13px] text-muted">Unknown track — no name recorded before it left</span>
        )}
      </div>
      <code className="mono-num text-[11px] break-all text-muted">{track.id}</code>
    </div>
  );
}

function TrackGroup({ label, tracks }: { label: string; tracks: OrphanTrackRow[] }) {
  return (
    <div className="mb-2">
      <p className="py-1 text-[11px] tracking-wide text-muted uppercase">{label}</p>
      {tracks.map(t => <TrackRow key={t.id} track={t} />)}
    </div>
  );
}

export default function OrphanStemsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const ready = hydrated && !needsAuth;
  const stateQuery = useOrphanState(adminFetch, ready);
  const [showTracks, setShowTracks] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [lastPass, setLastPass] = useState<OrphanReport | null>(null);
  const tracksQuery = useOrphanTracks(adminFetch, ready && showTracks);
  const mutation = useOrphanMutation(adminFetch);
  const report = stateQuery.data?.report;
  const enabled = stateQuery.data?.enabled === true;
  const dialog = report ? runDialog(report) : null;

  const act = (vars: OrphanVars) =>
    mutation.mutate(vars, {
      onSuccess: data => { if (vars.confirm && data.report) setLastPass(data.report); },
    });

  const rows = tracksQuery.data?.tracks ?? [];
  const orphanRows = rows.filter(t => t.state === 'orphan');
  const quarantinedRows = rows.filter(t => t.state === 'quarantined');

  return (
    <Card title="Orphan stems cleanup" sub={ORPHAN_CARD_SUB}>
      {!ready || stateQuery.isLoading ? (
        <p className="text-sm text-muted">Reading the cache…</p>
      ) : report ? (
        <OrphanReportView
          report={report}
          enabled={enabled}
          lastPass={lastPass}
          busy={mutation.isPending}
          scanning={stateQuery.isFetching}
          showTracks={showTracks}
          onToggleTracks={() => setShowTracks(v => !v)}
          onRun={() => setConfirmRun(true)}
          onRescan={() => { void stateQuery.refetch(); }}
          onToggleDaily={() => act({ setEnabled: !enabled })}
        >
          {showTracks && (
            <div className="max-h-80 overflow-y-auto rounded border border-[var(--separator-soft)] px-3 py-1">
              {tracksQuery.isLoading ? (
                <p className="py-2 text-sm text-muted">Resolving names — this scans the recent event logs…</p>
              ) : orphanRows.length === 0 && quarantinedRows.length === 0 ? (
                <p className="py-2 text-sm text-muted">Nothing in the cache root or the quarantine.</p>
              ) : (
                <>
                  {orphanRows.length > 0 && <TrackGroup label="Orphaned — will move to quarantine" tracks={orphanRows} />}
                  {quarantinedRows.length > 0 && <TrackGroup label="Already in quarantine" tracks={quarantinedRows} />}
                </>
              )}
            </div>
          )}
        </OrphanReportView>
      ) : (
        <p className="text-sm text-muted">
          {stateQuery.error ? errorMessage(stateQuery.error) : 'The stems share could not be read.'}
        </p>
      )}
      <V3AlertDialog
        open={confirmRun}
        onOpenChange={setConfirmRun}
        title={dialog?.title ?? ''}
        description={dialog?.description ?? ''}
        confirmLabel={dialog?.confirmLabel}
        danger
        onConfirm={() => act({ confirm: true })}
      />
    </Card>
  );
}
