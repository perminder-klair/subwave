'use client';

import type { ReactNode } from 'react';
import { relTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { QueueEntry } from '@/lib/types';

export interface TimelineDrawerProps {
  upcoming?: QueueEntry[];
  history?: QueueEntry[];
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="pt-1 pb-[10px] text-[9px] tracking-[0.3em] text-muted uppercase">
      {children}
    </div>
  );
}

export default function TimelineDrawer({ upcoming, history }: TimelineDrawerProps) {
  const hasUpcoming = !!upcoming?.length;
  const hasHistory = !!history?.length;

  if (!hasUpcoming && !hasHistory) {
    return (
      <div className="text-[13px] leading-relaxed text-muted">
        Nothing played yet. The DJ is on autopilot — request a track to jump the line.
      </div>
    );
  }

  return (
    <div>
      {hasUpcoming && (
        <div className={cn(hasHistory && 'mb-6')}>
          <SectionLabel>Up next</SectionLabel>
          {upcoming?.map((t, i) => (
            <div
              key={`q-${i}`}
              className="flex items-baseline gap-[14px] border-b border-separator-strong py-[14px]"
            >
              <span className="v3-tab-num w-9 text-[28px] font-extralight text-muted">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-lg leading-tight font-semibold">{t.title}</div>
                <div className="mt-0.5 text-xs text-muted">{t.artist}</div>
                {t.requestedBy && (
                  <div className="mt-1 text-[9px] tracking-[0.3em] text-vermilion uppercase">
                    ↳ requested by {t.requestedBy}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {hasHistory && (
        <div>
          <SectionLabel>Played</SectionLabel>
          {history?.map((t, i) => (
            <div
              key={`h-${i}`}
              className="flex items-baseline justify-between gap-3 border-b border-separator-soft py-[11px]"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">{t.title}</div>
                <div className="truncate text-[11px] text-muted">{t.artist}</div>
              </div>
              {t.t && (
                <span className="v3-tab-num shrink-0 text-[10px] tracking-eyebrow text-muted uppercase">
                  {relTime(t.t)} ago
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
