'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, X, Ban } from 'lucide-react';
import { Card, Btn } from '../ui';
import { cn } from '../../../lib/cn';

import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { CHECK_HIT } from './bits';
import type { BlockEntry } from './types';

const entryKey = (e: BlockEntry) => `${e.type}:${e.id}`;

export function BlockedTab({ entries, loading, unblocking, bulkBusy, onUnblock, onBulkUnblock, onRefresh }: {
  entries: BlockEntry[] | null;
  loading: boolean;
  unblocking: string | null;
  bulkBusy: boolean;
  onUnblock: (e: BlockEntry) => void;
  onBulkUnblock: (entries: BlockEntry[]) => void;
  onRefresh: () => void;
}) {
  const rows = useMemo(
    () => (entries || []).slice().sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '')),
    [entries],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // An entry removed by a single unblock (or by another admin session) must not linger
  // as a checked ghost the bulk action then reports as "already gone".
  useEffect(() => {
    setSelected(prev => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.map(entryKey));
      const next = new Set([...prev].filter(k => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const busy = bulkBusy || !!unblocking;
  const allSelected = rows.length > 0 && rows.every(e => selected.has(entryKey(e)));
  const toggle = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <Card
      title="Never play"
      sub={entries ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} — these are refused everywhere: DJ picks, requests, even manual queueing` : ''}
      right={
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <Btn
              sm
              tone="accent"
              onClick={() => onBulkUnblock(rows.filter(e => selected.has(entryKey(e))))}
              disabled={busy}
            >
              {bulkBusy ? '…' : <><X size={11} /> Unblock {selected.size}</>}
            </Btn>
          )}
          <Btn sm onClick={onRefresh} disabled={loading}>
            <RefreshCw size={11} /> {loading ? 'Loading…' : 'Refresh'}
          </Btn>
        </div>
      }
      bodyClass="!p-0"
    >
      {rows.length === 0 ? (
        loading ? (
          <SkeletonRows rows={4} className="m-4" />
        ) : (
          <EmptyState
            compact
            title="Nothing blocked"
            description={<>Use the <Ban size={11} className="inline align-[-1px]" /> action on any track row to keep a track, album or artist off the air.</>}
          />
        )
      ) : (
        <div className={cn(loading && 'opacity-60 transition-opacity')}>
          <div className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2">
            <label className={CHECK_HIT}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(entryKey)))}
                aria-label={allSelected ? 'deselect all blocked entries' : 'select all blocked entries'}
              />
            </label>
            <span className="text-[10px] tracking-wider text-muted uppercase">
              {selected.size > 0 ? `${selected.size} selected` : 'select to unblock in bulk'}
            </span>
          </div>
          {rows.map(e => {
            const key = entryKey(e);
            return (
              <div key={key} className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 last:border-b-0">
                <label className={CHECK_HIT}>
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => toggle(key)}
                    aria-label={`select ${e.name || e.id}`}
                  />
                </label>
                <span className="lib-mtag shrink-0" title={`blocked ${e.type}`}>{e.type}</span>
                <div className="min-w-0 flex-1">
                  <div className="lib-title">{e.name || e.id}</div>
                  {(e.artist || e.album) && e.type !== 'artist' && (
                    <div className="lib-artist">{e.artist || ''}{e.album && e.type === 'track' ? ` · ${e.album}` : ''}</div>
                  )}
                </div>
                <span className="hidden text-[11px] text-muted sm:block" title="blocked on">
                  {e.addedAt ? new Date(e.addedAt).toLocaleDateString('en-GB') : ''}
                </span>
                <Btn sm onClick={() => onUnblock(e)} disabled={busy}>
                  {unblocking === key ? '…' : <><X size={12} /> Unblock</>}
                </Btn>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

