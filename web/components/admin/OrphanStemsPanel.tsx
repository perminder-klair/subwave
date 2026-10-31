'use client';

// Orphan stem dirs: what the cache holds for tracks that left the
// library, and the two presses about it. A dry-run report is the default read
// (GET never moves anything); "Move N to quarantine" asks once, naming the
// count and the week's grace, then moves; aged
// quarantines delete themselves after a week, and a track id that walks back
// into the library gets its dirs released rather than re-separated.
// The daily cron behind the toggle is off by default — deleting operator
// files is opt-in, and a first pass should be read, not trusted (#1570 rule).
// The dirs are named by track id and the library no longer knows them, so
// raw ids told an operator nothing: "Show tracks" pulls the readable list
// (GET /stems/orphans/tracks resolves title/artist/album from the plays
// snapshot, the recent-plays sidecar and the event logs) into a fold under
// the stats.

import { useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { useAdminMutation, useAdminQuery } from '../../lib/admin-query';
import type { AdminFetch } from '../../lib/admin-query';
import { Card, Btn, Pill } from './ui';
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
  freedBytes: number;
  offline?: string;
}

interface OrphanState {
  enabled: boolean;
  report: OrphanReport;
}

interface OrphanPayload {
  enabled: boolean;
  report: OrphanReport;
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

const orphanKeys = { all: ['stems', 'orphans'] as const, state: () => [...orphanKeys.all, 'state'] };

function useOrphanState(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<OrphanState>({
    key: orphanKeys.state(),
    adminFetch,
    enabled,
    request: (fetch, signal) =>
      fetch('/stems/orphans', { signal }).then(r => r.json() as Promise<OrphanState>),
  });
}

// Lazy: the event-log tail behind the name resolution costs real I/O, so the
// list fetches on the first open of the fold, not on every panel paint.
function useOrphanTracks(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<OrphanTracks>({
    key: [...orphanKeys.all, 'tracks'],
    adminFetch,
    enabled,
    request: (fetch, signal) =>
      fetch('/stems/orphans/tracks', { signal }).then(r => r.json() as Promise<OrphanTracks>),
  });
}

function useOrphanMutation(adminFetch: AdminFetch) {
  return useAdminMutation<OrphanPayload, { confirm?: boolean; setEnabled?: boolean }>({
    adminFetch,
    request: (vars, fetch) =>
      fetch('/stems/orphans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(vars),
      }).then(r => {
        if (!r.ok) throw new Error(`purge failed (${r.status})`);
        return r.json() as Promise<OrphanPayload>;
      }),
  });
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

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
  const [confirmMove, setConfirmMove] = useState(false);
  const tracksQuery = useOrphanTracks(adminFetch, ready && showTracks);
  const mutation = useOrphanMutation(adminFetch);
  const report = stateQuery.data?.report;
  const enabled = stateQuery.data?.enabled === true;

  const act = (vars: { confirm?: boolean; setEnabled?: boolean }) =>
    mutation.mutate(vars, {
      onSuccess: () => {
        void stateQuery.refetch();
        // If the fold is open, moved dirs must not keep showing as orphans.
        if (showTracks) void tracksQuery.refetch();
      },
    });

  const rows = tracksQuery.data?.tracks ?? [];
  const orphanRows = rows.filter(t => t.state === 'orphan');
  const quarantinedRows = rows.filter(t => t.state === 'quarantined');

  return (
    <Card
      title="Orphan stems cleanup"
      sub="A track that leaves the library keeps its Demucs stem dirs until the byte budget evicts them. This finds those dirs, parks them in a quarantine for a week (a track that walks back gets them released, not re-separated), and deletes what ages out."
    >
      {!ready || stateQuery.isLoading ? (
        <p className="text-sm text-muted">Reading the cache…</p>
      ) : report?.refused ? (
        <p className="text-sm text-muted">
          <Pill tone="accent">refused</Pill>{' '}
          {report.offline ?? report.reason ?? 'the stems share is not readable'} — nothing was moved.
        </p>
      ) : report ? (
        <div className="flex flex-col gap-3">
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
              <> Deleted <strong className="mono-num">{report.deletedCount}</strong> aged quarantine
                ({mb(report.freedBytes)} freed).</>
            )}
            {report.released.length > 0 && (
              <> Released <strong className="mono-num">{report.released.length}</strong> back to the library.</>
            )}
            {report.failed > 0 && (
              <> <strong className="mono-num">{report.failed}</strong> failed — check ownership/permissions on the stems share.</>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Btn
              sm
              disabled={mutation.isPending}
              onClick={() => setShowTracks(v => !v)}
              title="The dirs by track name — resolved from play history and the event log; ids with no surviving name stay listed, unknown."
            >
              {showTracks ? 'Hide tracks' : `Show tracks (${report.quarantined + report.agingCount})`}
            </Btn>
            <Btn
              sm
              tone="solid"
              disabled={report.quarantined === 0 || mutation.isPending}
              onClick={() => setConfirmMove(true)}
            >
              {mutation.isPending ? 'Working…'
                : report.quarantined > 0 ? `Move ${report.quarantined} to quarantine` : 'Nothing to move'}
            </Btn>
            <Btn
              sm
              disabled={mutation.isPending || stateQuery.isFetching}
              onClick={() => { void stateQuery.refetch(); }}
              title="Re-reads the cache root and the quarantine (a few seconds on a big share)."
            >
              {stateQuery.isFetching ? 'Scanning…' : 'Re-scan'}
            </Btn>
            <Pill
              dot
              tone="ink"
              pressed={enabled}
              disabled={mutation.isPending}
              onClick={() => act({ setEnabled: !enabled })}
              title={enabled
                ? 'The daily pass quarantines new orphans once a day; entries delete themselves after a week. Click to turn it off.'
                : 'The daily pass quarantines new orphans once a day; entries delete themselves after a week. Click to turn it on.'}
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
          <p className="text-[12px] text-muted">
            Quarantine holds each orphan for 7 days under <code>.orphan-quarantine</code> at the cache
            root — a move, not a copy, and invisible to every walk. This report is a dry run: nothing
            moved until you press it or the daily pass runs (off by default).
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted">The stems share could not be read.</p>
      )}
      <V3AlertDialog
        open={confirmMove}
        onOpenChange={setConfirmMove}
        title="Move orphan stems to the quarantine"
        description={report
          ? `${report.quarantined.toLocaleString('en-GB')} stem folder${report.quarantined === 1 ? '' : 's'} for tracks no longer in the library move into the quarantine. A track that comes back within a week gets its folder back; after a week, the rest are deleted for good.`
          : ''}
        confirmLabel="move to quarantine"
        danger
        onConfirm={() => act({ confirm: true })}
      />
    </Card>
  );
}
