'use client';

import type { ReactNode } from 'react';
import { fmtClock } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { SkeletonText } from '@/components/ui/skeleton';
import { Card, Pill } from '../ui';
import { ScrollArea } from '../../ui/scroll-area';
import { cn } from '../../../lib/cn';
import type { RequestEntry } from './types';
import { oneLine } from './bits';

export function RequestsCard({
  requests,
  err,
  tz,
  locale,
}: {
  requests: RequestEntry[] | null;
  err: string | null;
  tz?: string;
  locale?: StationLocale;
}) {
  return (
    <Card
      title="Requests"
      sub={
        err
          ? 'unavailable'
          : requests
            ? `${requests.length} recent · what listeners asked + how the DJ answered`
            : 'loading…'
      }
    >
      {err ? (
        <div className="text-muted italic">can’t load requests: {err}</div>
      ) : !requests ? (
        <SkeletonText lines={2} />
      ) : requests.length === 0 ? (
        <div className="text-muted italic">no requests yet</div>
      ) : (
        <ScrollArea className="max-h-[520px]">
          <div className="grid gap-1.5">
            {requests.map((r, i) => (
              <RequestRow key={`${r.t ?? ''}:${i}`} r={r} tz={tz} locale={locale} />
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
}

// The Likes card (#991) moved to the Library page's Liked mode in #1253.

function RequestRow({ r, tz, locale }: { r: RequestEntry; tz?: string; locale?: StationLocale }) {
  const ok = r.status === 'resolved';
  const trace = [
    r.intent && `intent ${r.intent}`,
    r.mood && `mood ${r.mood}`,
    r.scope && `scope ${r.scope}`,
    r.sort && `sort ${r.sort}`,
    r.artist && `artist ${r.artist}`,
    r.genre && `genre ${r.genre}`,
    r.language && `lang ${r.language}`,
  ].filter(Boolean) as string[];

  return (
    <details className="border border-separator-strong">
      <summary className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2.5 px-2.5 py-2 sm:grid-cols-[auto_1fr_auto_auto]">
        <span className={cn('font-bold', ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
          {ok ? '✓' : '✗'}
        </span>
        <span className="min-w-0 truncate text-[12px]">
          <span className="font-bold">{r.requester || 'anon'}</span>
          <span className="text-muted"> · {oneLine(r.text)}</span>
        </span>
        <span className="caption hidden text-[10px] sm:inline">
          {r.ms != null ? `${r.ms}ms` : ''}
        </span>
        <span className="mono-num text-[10px] text-muted">
          {fmtClock(r.t, tz, locale) || '—'}
        </span>
      </summary>
      <div className="grid gap-2 px-2.5 pt-1 pb-2.5 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          {r.path && <Pill tone="accent">{r.path}</Pill>}
          {r.pickSource && <Pill>{r.pickSource}</Pill>}
        </div>

        {trace.length > 0 && (
          <div className="caption text-[10px]">{trace.join(' · ')}</div>
        )}

        {ok ? (
          <RequestField label="track">
            {r.track?.title ? (
              <span>
                {r.track.title}{' '}
                <span className="text-muted">— {r.track.artist}</span>
              </span>
            ) : (
              <span className="text-muted italic">—</span>
            )}
          </RequestField>
        ) : (
          <RequestField label="failed">
            <span className="text-[var(--danger)]">{r.message || '—'}</span>
          </RequestField>
        )}

        {r.ack && <RequestField label="ack">{r.ack}</RequestField>}
        {r.introScript && (
          <RequestField label="intro">
            <span className="break-words whitespace-pre-wrap">{r.introScript}</span>
          </RequestField>
        )}
      </div>
    </details>
  );
}

function RequestField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[60px_1fr] items-baseline gap-2">
      <span className="caption text-[9px]">{label}</span>
      <span className="break-words">{children}</span>
    </div>
  );
}

