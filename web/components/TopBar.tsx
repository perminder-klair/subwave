'use client';

import { Headphones } from 'lucide-react';
import { buildTagline } from '@/lib/tagline';
import { cn } from '@/lib/cn';
import OdometerNumber from './OdometerNumber';
import ThemeSwitcher from './ThemeSwitcher';
import type { ActiveShow, ListenerCount, StationContext } from '@/lib/types';

export interface TopBarProps {
  tunedIn: boolean;
  context: StationContext | null;
  stationName?: string;
  djName?: string;
  activeShow: ActiveShow | null;
  listeners: ListenerCount | number | null;
  /** Optional — when provided, the show + host line becomes a button that
   *  opens the Schedule drawer. Omitted on Landing where there's no player. */
  onOpenSchedule?: () => void;
}

function isListenerObject(l: ListenerCount | number | null): l is ListenerCount {
  return !!l && typeof l === 'object';
}

export default function TopBar({
  tunedIn,
  context,
  stationName,
  djName,
  activeShow,
  listeners,
  onOpenSchedule,
}: TopBarProps) {
  const tagline = buildTagline(context);
  // When a programmed show is on air, name it and prefer its host.
  const showName = activeShow?.name || null;
  const onAirName = activeShow?.persona?.name || djName;
  const listenerObj = isListenerObject(listeners) ? listeners : null;
  return (
    <div
      // viewport-fit=cover lets the header extend under the iPhone notch /
      // Dynamic Island. The top inset stacks the safe-area on top of the
      // baseline gutter; left/right max() against the gutter so landscape
      // on a notched phone doesn't clip the wordmark, while desktop keeps
      // its wider sm: gutters.
      className="player-topbar absolute top-0 right-0 left-0 z-20 flex items-baseline justify-between gap-3 border-b border-ink
        pt-[calc(env(safe-area-inset-top)_+_1rem)] pr-[max(1rem,env(safe-area-inset-right))]
        pb-2 pl-[max(1rem,env(safe-area-inset-left))]
        sm:pt-[calc(env(safe-area-inset-top)_+_1.5rem)] sm:pr-[max(2rem,env(safe-area-inset-right))]
        sm:pb-3 sm:pl-[max(2rem,env(safe-area-inset-left))]"
    >
      <div className="flex min-w-0 items-baseline gap-2 sm:gap-[14px]">
        <span
          className="player-mark"
          data-spinning={tunedIn ? 'true' : undefined}
          aria-hidden="true"
        />
        <span className="v3-eyebrow shrink-0">{stationName?.trim() || 'SUB/WAVE'}</span>
        {showName && (
          onOpenSchedule ? (
            <button
              type="button"
              onClick={onOpenSchedule}
              className="v3-caption v3-focus min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-ink hover:underline"
              title={`${showName} — open schedule`}
            >
              ▸ {showName}
            </button>
          ) : (
            <span className="v3-caption min-w-0 truncate text-ink" title={showName}>
              ▸ {showName}
            </span>
          )
        )}
        {onAirName && (
          onOpenSchedule ? (
            <button
              type="button"
              onClick={onOpenSchedule}
              className="v3-caption v3-focus cursor-pointer truncate border-0 bg-transparent p-0 text-left text-vermilion hover:underline"
              title="Open schedule"
            >
              with {onAirName}
            </button>
          ) : (
            <span className="v3-caption truncate text-vermilion">
              with {onAirName}
            </span>
          )
        )}
        {tagline && (
          <span
            className="v3-caption hidden truncate text-muted md:inline"
            title={tagline}
          >
            {tagline}
          </span>
        )}
      </div>
      <div className="v3-caption flex shrink-0 items-center gap-3 text-muted sm:gap-[18px]">
        {listenerObj?.current != null && (
          <span
            className={cn(
              'v3-tab-num inline-flex items-center gap-1.5 leading-none font-semibold whitespace-nowrap',
              listenerObj.current > 0 ? 'text-ink' : 'text-muted',
            )}
            title={`${listenerObj.current} listening · peak ${listenerObj.peak ?? 0}`}
            aria-label={`${listenerObj.current} listening`}
          >
            <Headphones className="h-3.5 w-3.5" aria-hidden="true" />
            <OdometerNumber value={listenerObj.current} />
          </span>
        )}
        <ThemeSwitcher variant="player" />
      </div>
    </div>
  );
}
