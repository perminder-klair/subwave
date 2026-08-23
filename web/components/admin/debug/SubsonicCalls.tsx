'use client';

import { useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { useAdminMutation } from '../../../lib/admin-query';
import { Card, Btn } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import { cn } from '../../../lib/cn';
import type { DebugSubsonic } from './types';
import { oneLine } from './format';
import { CallSection, FilterChip, JsonBlock } from './bits';
import { debugKeys } from './queries';

export function SubsonicCalls({ subsonic }: { subsonic: DebugSubsonic | undefined }) {
  const { adminFetch } = useAdminAuth();
  const [filter, setFilter] = useState('all');
  const resetMutation = useAdminMutation<void, void>({
    adminFetch,
    toastOnError: false,
    request: async (_vars, fetcher) => {
      // Reset has always been best-effort: any answer or network failure is
      // silent, and the next /debug reading is authoritative.
      await fetcher('/debug/subsonic/reset', { method: 'POST' });
    },
    onDone: (_data, _vars, client) =>
      client.invalidateQueries({ queryKey: debugKeys.status() }),
  });

  if (!subsonic || subsonic.error) {
    return (
      <Card title="Subsonic API calls">
        <span className="field-hint text-muted">
          {subsonic?.error || 'No data yet'}
        </span>
      </Card>
    );
  }

  const calls = subsonic.recentCalls || [];
  const endpoints = subsonic.endpoints || [];
  const totalCalls = endpoints.reduce((s, e) => s + e.calls, 0);
  const shown = filter === 'all' ? calls : calls.filter(c => c.endpoint === filter);

  const reset = async () => {
    try { await resetMutation.mutateAsync(); } catch {}
  };

  return (
    <Card
      title="Subsonic API calls"
      sub={`${calls.length} recent · ${totalCalls} total`}
      right={
        <Btn sm onClick={reset} disabled={resetMutation.isPending}>
          {resetMutation.isPending ? 'Resetting…' : 'Reset'}
        </Btn>
      }
    >
      <div className="grid gap-4">
        <div>
          <div className="mb-1.5 flex flex-wrap gap-1">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              all {calls.length}
            </FilterChip>
            {endpoints.map(e => (
              <FilterChip
                key={e.endpoint}
                active={filter === e.endpoint}
                onClick={() => setFilter(e.endpoint)}
              >
                {e.endpoint} {calls.filter(c => c.endpoint === e.endpoint).length}
              </FilterChip>
            ))}
          </div>
          <ScrollArea className="max-h-[480px]">
            <div className="grid gap-1.5">
              {shown.length === 0 && (
                <span className="field-hint text-muted">
                  {calls.length === 0 ? 'No calls yet' : 'No calls match this filter'}
                </span>
              )}
              {shown.map((c, i) => (
                <details key={i} className="border border-separator-strong">
                  <summary className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-2.5 py-2 sm:gap-2.5">
                    <span className={cn('font-bold', c.ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
                      {c.ok ? '✓' : '✗'}
                    </span>
                    <span className="truncate text-[12px] font-bold">{c.endpoint}</span>
                    <span className="caption text-[10px] whitespace-nowrap">{c.count} results</span>
                    <span className="mono-num text-[11px] text-muted">{c.ms}ms</span>
                    <span className="mono-num text-[10px] text-muted">
                      {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
                    </span>
                  </summary>
                  <div className="grid gap-1 px-2.5 pt-1 pb-2.5">
                    {c.error && (
                      <CallSection label="error" tone="err" preview={oneLine(c.error)}>
                        {c.error}
                      </CallSection>
                    )}
                    <CallSection label="params" preview={oneLine(JSON.stringify(c.params || {}))}>
                      <JsonBlock value={c.params || {}} />
                    </CallSection>
                    {Array.isArray(c.songIds) && c.songIds.length > 0 && (
                      <CallSection
                        label="songs"
                        count={c.songIds.length}
                        preview={c.songIds.map(s => `${s.title} — ${s.artist}`).join(' · ')}
                      >
                        {c.songIds.map(s => `${s.title} — ${s.artist}`).join('\n')}
                      </CallSection>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </Card>
  );
}

