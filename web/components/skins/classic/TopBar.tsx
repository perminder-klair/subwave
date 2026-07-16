'use client';

import { memo } from 'react';
import { buildTagline } from '@/lib/tagline';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import type { ActiveShow, StationContext } from '@/lib/types';

export interface TopBarProps {
  tunedIn: boolean;
  context: StationContext | null;
  stationName?: string;
  djName?: string;
  activeShow: ActiveShow | null;
  /** Optional — when provided, the show + host line becomes a button that
   *  opens the Schedule drawer. Omitted on Landing where there's no player. */
  onOpenSchedule?: () => void;
}

export default memo(function TopBar({
  tunedIn,
  context,
  stationName,
  djName,
  activeShow,
  onOpenSchedule,
}: TopBarProps) {
  const tagline = buildTagline(context);
  // When a programmed show is on air, name it and prefer its host.
  const showName = activeShow?.name || null;
  const onAirName = activeShow?.persona?.name || djName;
  return (
    <div
      // viewport-fit=cover lets the header extend under the iPhone notch /
      // Dynamic Island. The top inset stacks the safe-area on top of the
      // baseline gutter; left/right max() against the gutter so landscape
      // on a notched phone doesn't clip the wordmark, while desktop keeps
      // its wider sm: gutters.
      className="player-topbar absolute top-0 right-0 left-0 z-30 flex flex-col gap-1 border-b border-ink bg-bg/55 pt-[calc(env(safe-area-inset-top)_+_0.625rem)] pr-[max(1rem,env(safe-area-inset-right))]
        pb-2.5 pl-[max(1rem,env(safe-area-inset-left))]
        backdrop-blur-xl backdrop-saturate-150
        sm:pt-[calc(env(safe-area-inset-top)_+_0.875rem)] sm:pr-[max(2rem,env(safe-area-inset-right))]
        sm:pb-3.5 sm:pl-[max(2rem,env(safe-area-inset-left))]"
    >
      <div className="flex items-center justify-between gap-3">
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
              className="v3-caption hidden min-w-0 truncate text-muted md:inline"
              title={tagline}
            >
              {tagline}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center">
          <ThemeSwitcher variant="player" />
        </div>
      </div>
      {/* Mobile: the context line is too long to share the masthead row, so it
          drops to its own line below; from md it sits inline above. */}
      {tagline && (
        <span
          className="v3-caption player-topbar-subline truncate text-muted md:hidden"
          title={tagline}
        >
          {tagline}
        </span>
      )}
    </div>
  );
});
