'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import {
  turnClass,
  turnKey,
  turnText,
  isCarriedTurn,
  isDjTurn,
  isShowBoundary,
  showBoundaryLabel,
  type TurnDisplayClass,
} from '@/lib/sessionFeed';
import { cn } from '@/lib/cn';
import { fmtClock, fmtClockMinute } from '@/lib/format';
import type { SessionTurn, StationLocale } from '@/lib/types';

type FilterId = 'all' | 'dj' | 'tracks';

interface Filter {
  id: FilterId;
  label: string;
}

const FILTERS: readonly Filter[] = [
  { id: 'all', label: 'All' },
  { id: 'dj', label: 'DJ' },
  { id: 'tracks', label: 'Tracks' },
];

const CLASS_COLOR: Record<TurnDisplayClass, string> = {
  voice: 'text-vermilion',
  dj: 'text-ink',
  track: 'text-muted',
  system: 'text-muted',
};

export interface BoothDrawerProps {
  /** Live session messages, oldest first. Shown newest first. */
  items: SessionTurn[];
  /** Station IANA timezone — timestamps render in it so they match what the DJ
   *  speaks on-air (issue #418). Falls back to the browser zone when absent. */
  timezone?: string | null;
  locale?: StationLocale;
}

// `layout` on each row pushes existing rows down when new ones insert.
// `initial={false}` on the AnimatePresence parent keeps drawer-open from
// animating all 30 rows in at once.
export default function BoothDrawer({ items, timezone, locale }: BoothDrawerProps) {
  const [filter, setFilter] = useState<FilterId>('all');

  const filtered = useMemo<SessionTurn[]>(() => {
    if (!items?.length) return [];
    // System turns (session cues, pick prompts) are operator-facing and never
    // reach listeners. The one exception is the show-boundary separator that
    // follows the previous show's carried tail after a hard roll (#1690); it
    // stays in every filter so dimmed rows below it read as the last show.
    const ordered = [...items]
      .filter((turn) => turnClass(turn) !== 'system' || isShowBoundary(turn))
      .reverse();
    if (filter === 'all') return ordered;
    return ordered.filter((turn) =>
      isShowBoundary(turn) ||
      (filter === 'dj' ? isDjTurn(turn) : turnClass(turn) === 'track'));
  }, [items, filter]);

  return (
    <div>
      <div className="flex gap-1 border-b border-soft-border pt-0.5 pb-[14px]">
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                'sw-focus cursor-pointer border px-2.5 py-1 text-[10px] tracking-[0.25em] uppercase transition-colors duration-150 ease-out',
                active
                  ? 'border-ink bg-ink text-bg'
                  : 'border-soft-border bg-transparent text-muted',
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="py-[18px] text-[13px] leading-relaxed text-muted italic">
          {items?.length ? 'Nothing in this view.' : 'Booth is quiet. Awaiting transmission…'}
        </div>
      )}

      <AnimatePresence initial={false} mode="popLayout">
        {filtered.map((turn, i) => {
          if (isShowBoundary(turn)) {
            const label = showBoundaryLabel(turn, (at) => fmtClockMinute(at, timezone, locale));
            return (
              <m.div
                key={turnKey(turn, i)}
                layout
                role="separator"
                aria-label={`Show boundary: ${label}`}
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14, ease: [0.2, 0.7, 0.2, 1] }}
                className="flex items-center gap-3 border-b border-soft-border py-3"
              >
                <span className="h-px flex-1 bg-soft-border" aria-hidden="true" />
                <span className="v3-tab-num text-[10px] tracking-[0.2em] text-muted">{label}</span>
                <span className="h-px flex-1 bg-soft-border" aria-hidden="true" />
              </m.div>
            );
          }
          const cls = turnClass(turn);
          const isVoice = cls === 'voice';
          const color = CLASS_COLOR[cls];
          const text = turnText(turn);
          // The previous show's tail is dimmed. Motion owns the row's opacity,
          // so the dim goes through `animate`, not a class it would override.
          const carried = isCarriedTurn(turn);
          return (
            <m.div
              key={turnKey(turn, i)}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: carried ? 0.6 : 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: [0.2, 0.7, 0.2, 1] }}
              className={cn(
                'border-b border-soft-border py-3',
                isVoice && '-ml-3 border-l-2 border-l-vermilion pl-3',
              )}
            >
              <div className="mb-1 flex items-baseline gap-2">
                <span className="v3-tab-num min-w-[56px] text-[10px] text-muted">
                  {fmtClock(turn.t, timezone, locale)}
                </span>
                <span className={cn('text-[9px] font-semibold tracking-[0.3em] uppercase', color)}>
                  {turn.kind}
                </span>
                {carried && isVoice && typeof turn.meta?.personaName === 'string' && turn.meta.personaName ? (
                  <span className="min-w-0 truncate text-[9px] font-semibold tracking-[0.2em] text-vermilion uppercase">
                    {turn.meta.personaName}
                  </span>
                ) : null}
              </div>
              <div
                className={cn(
                  'leading-snug [word-break:break-word] text-ink',
                  isVoice ? '[font-family:Georgia,"Times_New_Roman",serif] text-sm italic' : 'text-[13px]',
                )}
              >
                {isVoice ? `"${text}"` : text}
              </div>
              <MetaLine cls={cls} meta={turn.meta} />
            </m.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

interface MetaLineProps {
  cls: TurnDisplayClass;
  meta: SessionTurn['meta'];
}

function MetaLine({ cls, meta }: MetaLineProps) {
  if (!meta) return null;
  const bits: string[] = [];
  const requester =
    (typeof meta.requester === 'string' ? meta.requester : undefined) ??
    (typeof meta.requestedBy === 'string' ? meta.requestedBy : undefined);
  if (requester) bits.push(`req by ${requester}`);
  if (cls === 'track' && typeof meta.source === 'string') bits.push(`source: ${meta.source}`);
  const title = typeof meta.title === 'string' ? meta.title : '';
  const artist = typeof meta.artist === 'string' ? meta.artist : '';
  if (artist || title) {
    bits.push([title, artist].filter(Boolean).join(' — '));
  }
  // A `dj` pick turn can carry the spoken link it wrote (`meta.say`).
  const say = typeof meta.say === 'string' ? meta.say.trim() : '';
  if (!bits.length && !say) return null;
  return (
    <div className="mt-1">
      {bits.length > 0 && (
        <div className="text-[9px] tracking-[0.25em] text-muted uppercase">
          {bits.join(' · ')}
        </div>
      )}
      {say && (
        <div className="mt-0.5 text-[11px] leading-snug text-muted italic">
          ↳ &ldquo;{say}&rdquo;
        </div>
      )}
    </div>
  );
}
