'use client';

import { Card } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import type { DebugSleeveNotes } from './types';

export function SleeveNotesCalls({ sleeveNotes, timezone }: { sleeveNotes?: DebugSleeveNotes; timezone?: string }) {
  const calls = sleeveNotes?.recentCalls ?? [];
  const jobs = sleeveNotes?.jobs ?? [];
  const clock = (value?: string) => {
    if (!value) return '—';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: timezone,
      }).format(new Date(value));
    } catch { return '—'; }
  };
  return (
    <Card title="Extended Sleeve Notes activity" sub={`${jobs.length} durable job${jobs.length === 1 ? '' : 's'} · ${calls.length} recent HTTP call${calls.length === 1 ? '' : 's'} · non-LLM`}>
      <ScrollArea className="max-h-[480px]">
      <div className="grid gap-1.5">
        {jobs.length === 0 && calls.length === 0 && <span className="field-hint text-muted">No Sleeve Notes provider jobs yet.</span>}
        {jobs.map((job, index) => (
          <div key={`${job.provider ?? 'job'}-${job.capability ?? index}-${job.updatedAt ?? index}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 border border-separator-strong px-2.5 py-2">
            <span className={job.state === 'complete' ? 'font-bold text-vermilion' : job.state === 'failed' ? 'font-bold text-[var(--danger)]' : 'font-bold text-muted'}>{job.state === 'complete' ? '✓' : job.state === 'failed' ? '✗' : '•'}</span>
            <span className="min-w-0 text-[12px]"><strong>{job.provider}</strong> <span className="text-muted">·</span> {job.capability} <span className="text-muted">·</span> {job.subjectType}</span>
            <span className="mono-num text-[10px] text-muted">{job.state}{job.attempts ? ` · ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}` : ''}</span>
            <span className="mono-num text-[10px] text-muted">{clock(job.runAfter ?? job.updatedAt)}</span>
          </div>
        ))}
        {calls.map((call, index) => (
          <div key={`${call.t ?? index}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 border border-separator-strong px-2.5 py-2">
            <span className={call.ok ? 'font-bold text-vermilion' : 'font-bold text-[var(--danger)]'}>{call.ok ? '✓' : '✗'}</span>
            <span className="min-w-0 text-[12px]"><strong>{call.endpoint}</strong> <span className="text-muted">·</span> <span className="truncate">{call.title}{call.artist ? ` — ${call.artist}` : ''}</span></span>
            <span className="mono-num text-[11px] text-muted">{call.ms ?? '—'}ms</span>
            <span className="mono-num text-[10px] text-muted">{call.status ?? call.error ?? 'network'}</span>
            <span className="mono-num text-[10px] text-muted">{clock(call.t)}</span>
          </div>
        ))}
      </div>
      </ScrollArea>
    </Card>
  );
}
