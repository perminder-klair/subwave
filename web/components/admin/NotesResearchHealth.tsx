'use client';

import { useEffect, useState } from 'react';
import { adminJson, useAdminQuery, type AdminFetch } from '../../lib/admin-query';
import { formatNotesDate } from './sleeve-notes-view';
import { Btn, Card } from './ui';

export interface ResearchProgress {
  lastCompletedAt: string | null;
  lastSourceAt: string | null;
  nextRetryAt: string | null;
  oldestPendingAt: string | null;
}
export const RESEARCH_PAUSE_LABELS: Record<string, string> = {
  disabled: 'Research is switched off.',
  'operator-paused': 'Collection is paused by the operator.',
  'token-budget': 'Waiting for the station token allowance.',
  broadcast: 'Waiting for broadcast-critical work to finish.',
  interactive: 'Waiting for interactive DJ work to finish.',
  listeners: 'Waiting for a listener, or permission to research while the station is empty.',
};
export function researchLooksStalled(
  progress: ResearchProgress,
  reason: string | null,
  ready: boolean,
  now: number,
): boolean {
  if (!ready || ['disabled', 'operator-paused', 'token-budget', 'listeners'].includes(reason ?? ''))
    return false;
  const last = Math.max(
    ...[progress.lastSourceAt, progress.lastCompletedAt, progress.oldestPendingAt]
      .filter(Boolean)
      .map(at => Date.parse(at!)),
  );
  return Number.isFinite(last) && now - last > 6 * 60 * 60_000;
}
export function NotesResearchProgress({
  progress,
  reason,
  ready,
  now,
  timezone,
  tooltip = false,
}: {
  progress?: ResearchProgress;
  reason: string | null;
  ready: boolean;
  now: number;
  timezone?: string;
  tooltip?: boolean;
}) {
  return (
    <div className={`space-y-1 text-xs ${tooltip ? 'text-inherit' : 'text-muted'}`}>
      <p>
        {reason
          ? (RESEARCH_PAUSE_LABELS[reason] ?? 'Research is waiting.')
          : 'Ready work runs automatically when broadcast and source limits allow.'}
      </p>
      {progress && (
        <>
          <p>
            Last source collected:{' '}
            {progress.lastSourceAt ? formatNotesDate(progress.lastSourceAt, timezone) : 'none yet'}{' '}
            · Last research completed:{' '}
            {progress.lastCompletedAt
              ? formatNotesDate(progress.lastCompletedAt, timezone)
              : 'none yet'}
          </p>
          {progress.nextRetryAt && (
            <p>
              Next scheduled retry: {formatNotesDate(progress.nextRetryAt, timezone)}. Other ready
              jobs can run sooner.
            </p>
          )}
          {researchLooksStalled(progress, reason, ready, now) && (
            <p role="status" className={tooltip ? 'font-semibold' : 'text-ink'}>
              No research progress for over six hours while work is waiting. Check Show queue and
              the controller log.
            </p>
          )}
        </>
      )}
    </div>
  );
}
type Storage = {
  capturedAt: string;
  databaseBytes: number;
  walBytes: number;
  reusableBytes: number;
  connectionBytes: number | null;
  sources: { provider: string; documents: number; textBytes: number; compacted: number }[];
};
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
export default function NotesStorage({
  adminFetch,
  timezone,
}: {
  adminFetch: AdminFetch;
  timezone?: string;
}) {
  const query = useAdminQuery<Storage>({
    key: ['sleeve-notes', 'storage'],
    adminFetch,
    enabled: false,
    request: (fetcher, signal) => adminJson(fetcher, '/sleeve-notes/storage', undefined, signal),
  });
  const [previous, setPrevious] = useState<{ at: string; bytes: number } | null>(null);
  useEffect(() => {
    if (!query.data) return;
    try {
      const saved = JSON.parse(localStorage.getItem('subwave-notes-storage') ?? 'null');
      if (
        saved &&
        typeof saved.at === 'string' &&
        Number.isFinite(saved.bytes) &&
        saved.at !== query.data.capturedAt
      )
        setPrevious(saved);
      localStorage.setItem(
        'subwave-notes-storage',
        JSON.stringify({ at: query.data.capturedAt, bytes: query.data.databaseBytes }),
      );
    } catch {
      /* Inspection remains usable when browser storage is unavailable. */
    }
  }, [query.data]);
  const data = query.data;
  return (
    <Card
      headingLevel={2}
      title="Research storage"
      sub="Inspect when needed; this does not poll or contact a source service"
    >
      <Btn onClick={() => void query.refetch()} disabled={query.isFetching}>
        {query.isFetching ? 'Inspecting…' : data ? 'Refresh storage snapshot' : 'Inspect storage'}
      </Btn>
      {query.error && (
        <p role="alert" className="mt-3 text-sm">
          Could not inspect storage. Try again when the controller is available.
        </p>
      )}
      {data && (
        <div className="mt-3 space-y-2 text-xs text-muted">
          <p>
            Database: {bytes(data.databaseBytes)} · Available for reuse: {bytes(data.reusableBytes)}{' '}
            · Pending write log: {bytes(data.walBytes)}
          </p>
          {data.connectionBytes !== null && (
            <p>Derived connection tables and indexes: {bytes(data.connectionBytes)}</p>
          )}
          {previous && (
            <p>
              Database change since {formatNotesDate(previous.at, timezone)}:{' '}
              {data.databaseBytes - previous.bytes >= 0 ? '+' : '−'}
              {bytes(Math.abs(data.databaseBytes - previous.bytes))}
            </p>
          )}
          <div className="v3-focus overflow-x-auto" role="region" aria-label="Source storage; scroll to see all columns" tabIndex={0}>
            <table className="w-full min-w-[28rem] text-left text-xs">
              <caption className="sr-only">Retained source documents</caption>
              <thead>
                <tr>
                  <th scope="col" className="px-2 py-1 whitespace-nowrap">Source</th>
                  <th scope="col" className="px-2 py-1 whitespace-nowrap">Documents</th>
                  <th scope="col" className="px-2 py-1 whitespace-nowrap">Text retained</th>
                  <th scope="col" className="px-2 py-1 whitespace-nowrap">Compacted articles</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map(source => (
                  <tr key={source.provider}>
                    <th scope="row" className="px-2 py-1 font-medium">{source.provider}</th>
                    <td className="px-2 py-1 tabular-nums">{source.documents.toLocaleString()}</td>
                    <td className="px-2 py-1 tabular-nums">{bytes(source.textBytes)}</td>
                    <td className="px-2 py-1 tabular-nums">{source.compacted.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Source text sizes exclude indexes and supporting facts, so they do not add up to the
            database total. SQLite reuses cleared pages before shrinking its file. Snapshot:{' '}
            {formatNotesDate(data.capturedAt, timezone)}.
          </p>
        </div>
      )}
    </Card>
  );
}
