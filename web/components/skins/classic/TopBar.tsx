'use client';

import { memo } from 'react';
import { Play } from 'lucide-react';
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
  /** The stage is split for lyrics (AmbientLyrics); the bar says so from lg. */
  lyricsLive?: boolean;
}

export default memo(function TopBar({
  tunedIn,
  context,
  stationName,
  djName,
  activeShow,
  onOpenSchedule,
  lyricsLive = false,
}: TopBarProps) {
  const tagline = buildTagline(context);
  const showName = activeShow?.name || null;
  const onAirName = activeShow?.persona?.name || djName;
  return (
    <div
      // viewport-fit=cover lets the header extend under the iPhone notch. The
      // left/right max() against the baseline gutter stops landscape on a
      // notched phone clipping the wordmark.
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
          {/* The ▶ is lifted so its middle sits half a cap height up, level with
              the capitals; the default `middle` hangs it off the x-height. */}
          {showName && (
            onOpenSchedule ? (
              <button
                type="button"
                onClick={onOpenSchedule}
                className="v3-caption v3-focus min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-ink hover:underline"
                title={`${showName} — open schedule`}
              >
                <Play className="inline size-2.5 fill-current align-[calc(0.5cap-5px)]" strokeWidth={0} /> {showName}
              </button>
            ) : (
              <span className="v3-caption min-w-0 truncate text-ink" title={showName}>
                <Play className="inline size-2.5 fill-current align-[calc(0.5cap-5px)]" strokeWidth={0} /> {showName}
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
          {lyricsLive && (
            <span className="v3-caption mr-5 hidden items-center gap-1.5 font-bold text-vermilion lg:inline-flex">
              <span aria-hidden="true" className="size-1.5 bg-vermilion" />
              Lyrics
            </span>
          )}
          <ThemeSwitcher variant="player" />
        </div>
      </div>
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
