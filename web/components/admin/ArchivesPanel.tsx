'use client';

// No playback controls: these MP3s are an hour long each and the browser audio
// element doesn't seek well into them.

import { useMemo, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { adminJson, adminResponse, useAdminMutation } from '../../lib/admin-query';
import { fmtSize, relTime } from '../../lib/format';
import { Card, Btn, Eyebrow, Pill } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { operationKeys, useArchivesQuery, type ArchiveEntry } from './operations-queries';

function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

export default function ArchivesPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const archivesQuery = useArchivesQuery(adminFetch, hydrated && !needsAuth);
  const entries = archivesQuery.data ?? null;
  const [downloading, setDownloading] = useState<string | null>(null);
  const [dlErr, setDlErr] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearErr, setClearErr] = useState<string | null>(null);

  const clearMutation = useAdminMutation<void, void>({
    adminFetch,
    request: async (_unused, fetcher) => {
      await adminJson(fetcher, '/archives', { method: 'DELETE' });
    },
    onDone: async (_receipt, _unused, client) => {
      await client.invalidateQueries({ queryKey: operationKeys.archives(), exact: true });
    },
    toastOnError: false,
  });

  // The only delete affordance — per-file delete isn't worth the UI for
  // hour-long mixdowns.
  const clearArchive = async () => {
    setClearing(true);
    setClearErr(null);
    try {
      await clearMutation.mutateAsync();
    } catch (e) {
      setClearErr(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  };

  const byDate = useMemo(() => {
    if (!entries) return [] as { date: string; items: ArchiveEntry[]; bytes: number }[];
    const m = new Map<string, ArchiveEntry[]>();
    for (const e of entries) {
      const arr = m.get(e.date) || [];
      arr.push(e);
      m.set(e.date, arr);
    }
    return [...m.entries()]
      .sort((a, b) => (a[0] > b[0] ? -1 : 1))
      .map(([date, items]) => ({
        date,
        items: items.sort((a, b) => b.hour - a.hour),
        bytes: items.reduce((a, b) => a + b.bytes, 0),
      }));
  }, [entries]);

  if (archivesQuery.error) {
    return (
      <div className="grid gap-4">
        <ErrorState
          error={archivesQuery.error instanceof Error ? archivesQuery.error.message : String(archivesQuery.error)}
          onRetry={() => { void archivesQuery.refetch(); }}
        />
      </div>
    );
  }
  if (!entries) {
    return (
      <div className="grid gap-4">
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const totalBytes = entries.reduce((a, b) => a + b.bytes, 0);

  // The endpoint is behind requireAdmin, so a plain <a download> saves the 401
  // JSON body instead. user:pass@ in the URL is a no-op same-origin and Chrome
  // strips it from navigations, so fetch via adminFetch and save from a blob.
  const download = async (path: string) => {
    setDownloading(path);
    setDlErr(null);
    try {
      // admin-query-imperative: archive-download
      const r = await adminResponse(adminFetch, `/archives/file/${path}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = path.replace(/\//g, '_'); // 2025-06-02/02-00.mp3 → 2025-06-02_02-00.mp3
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDlErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">archives</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            What went out, hour by hour.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Liquidsoap writes one MP3 per clock hour into <code>state/archive/</code>.
            They&rsquo;re kept until the operator deletes them. There is no automatic rotation,
            so keep an eye on disk if the station runs 24/7.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{entries.length} hour{entries.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">{fmtSize(totalBytes)} total</span>
          <Btn
            sm
            tone="danger"
            className="ml-auto min-h-9 sm:min-h-0"
            onClick={() => setConfirmClear(true)}
            disabled={clearing || entries.length === 0}
          >
            {clearing ? 'Clearing…' : 'Clear archive'}
          </Btn>
        </div>
      </section>

      {dlErr && (
        <div className="text-[12px] text-[var(--danger)]">download error: {dlErr}</div>
      )}
      {clearErr && (
        <div className="text-[12px] text-[var(--danger)]">clear failed: {clearErr}</div>
      )}

      {byDate.length === 0 && (
        <Card>
          <EmptyState
            title="No recordings yet"
            description={
              <>
                The first hour writes once the clock crosses the next <code>HH:00</code>. If you started the
                station mid-hour, you&rsquo;ll see the first file after the next top of the hour.
              </>
            }
          />
        </Card>
      )}

      {byDate.map(group => (
        <Card
          key={group.date}
          title={group.date}
          right={<Pill>{group.items.length} h · {fmtSize(group.bytes)}</Pill>}
        >
          <ul className="divide-y divide-[var(--ink-soft)]">
            {group.items.map(e => (
              <li key={e.path} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="mono-num text-[13px] font-bold">{hourLabel(e.hour)}</span>
                  <span className="text-[11px] text-muted">{fmtSize(e.bytes)}</span>
                  <span className="text-[10px] text-muted">{relTime(e.mtime)} ago</span>
                </div>
                <Btn
                  sm
                  tone="accent"
                  className="min-h-9 shrink-0 sm:min-h-0"
                  onClick={() => download(e.path)}
                  disabled={downloading === e.path}
                >
                  {downloading === e.path ? 'Downloading…' : 'Download'}
                </Btn>
              </li>
            ))}
          </ul>
        </Card>
      ))}

      <V3AlertDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        danger
        title="Clear archive"
        description={
          <>
            Permanently delete all {entries.length} recorded hour{entries.length === 1 ? '' : 's'}
            {' '}({fmtSize(totalBytes)})? This frees the disk under <code>state/archive/</code> and
            cannot be undone. The current hour keeps recording.
          </>
        }
        confirmLabel="clear archive"
        onConfirm={clearArchive}
      />
    </div>
  );
}
