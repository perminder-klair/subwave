'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Minus, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  LYRIC_OFFSET_MAX_MS,
  LYRIC_OFFSET_MIN_MS,
  LYRIC_OFFSET_NUDGE_MS,
  LYRIC_OFFSET_STEP_MS,
  formatLyricOffset,
  useCurrentLyrics,
} from '@/components/skins/lyrics';

export interface LyricsDrawerProps {
  songId?: string | null;
  title?: string;
  artist?: string;
  trackStartedAt: number | null;
}

export default function LyricsDrawer({ songId, title, artist, trackStartedAt }: LyricsDrawerProps) {
  const [showOffset, setShowOffset] = useState(false);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const {
    lyrics,
    loading,
    failed,
    stale,
    offsetMs,
    activeLineIndex: active,
    updateOffset,
  } = useCurrentLyrics({ songId, trackStartedAt });

  const onOffsetInput = (event: ChangeEvent<HTMLInputElement>) => {
    updateOffset(Number(event.target.value));
  };

  useEffect(() => {
    if (active < 0) return;
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active]);

  if (!songId) {
    return (
      <div className="text-[13px] leading-relaxed text-muted">
        Lyrics are available for library tracks once the station has indexed them.
      </div>
    );
  }

  // `stale` means the station is still answering for the previous track — we
  // have no verdict for this one, so keep waiting rather than claiming it has
  // no lyrics. The hook re-asks on its own.
  if (loading || stale) {
    return (
      <div className="text-[13px] leading-relaxed text-muted">
        Pulling lyrics from the library…
      </div>
    );
  }

  if (failed) {
    return (
      <div className="text-[13px] leading-relaxed text-muted">
        Lyrics are not reachable right now.
      </div>
    );
  }

  if (!lyrics?.lines.length) {
    return (
      <div>
        <div className="text-[9px] tracking-[0.3em] text-muted uppercase">No lyrics indexed</div>
        <div className="mt-3 text-[13px] leading-relaxed text-muted">
          {title ? `${title}${artist ? ` by ${artist}` : ''}` : 'This track'} has no lyrics in the station library yet.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-separator-soft pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[14px] leading-tight font-semibold">{title || 'Now playing'}</div>
            {artist && <div className="mt-1 truncate text-[10px] tracking-[0.16em] text-muted uppercase">{artist}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {lyrics.synced && (
              <>
                <div className="v3-tab-num text-[9px] tracking-[0.18em] text-muted uppercase">Synced</div>
                <DropdownMenu open={showOffset} onOpenChange={setShowOffset}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'v3-focus grid h-7 w-7 place-items-center border border-separator-soft bg-transparent text-muted transition-colors',
                        showOffset && 'border-ink bg-ink text-bg',
                      )}
                      aria-label="Lyrics offset controls"
                      title="Lyrics offset controls"
                    >
                      <SlidersHorizontal size={15} strokeWidth={1.7} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    side="top"
                    sideOffset={8}
                    className="z-[100] w-[min(420px,calc(100vw-2rem))] rounded-none border-separator-soft bg-[color-mix(in_oklab,var(--bg)_94%,black)] p-3 text-ink shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
                    data-lyric-offset
                    onCloseAutoFocus={event => event.preventDefault()}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-[9px] tracking-[0.28em] text-muted uppercase">Track offset</div>
                      <div className="v3-tab-num shrink-0 text-[11px] tracking-[0.1em] text-ink">{formatLyricOffset(offsetMs)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="v3-focus grid h-8 w-8 shrink-0 cursor-pointer place-items-center border border-separator-soft bg-transparent text-ink"
                        onClick={() => updateOffset(offsetMs - LYRIC_OFFSET_NUDGE_MS)}
                        aria-label="Delay lyrics"
                        title="Delay lyrics"
                      >
                        <Minus size={14} strokeWidth={1.8} />
                      </button>
                      <input
                        type="range"
                        min={LYRIC_OFFSET_MIN_MS}
                        max={LYRIC_OFFSET_MAX_MS}
                        step={LYRIC_OFFSET_STEP_MS}
                        value={offsetMs}
                        onChange={onOffsetInput}
                        aria-label="Track lyric offset"
                        className="h-8 min-w-0 flex-1 accent-[var(--accent)]"
                      />
                      <button
                        type="button"
                        className="v3-focus grid h-8 w-8 shrink-0 cursor-pointer place-items-center border border-separator-soft bg-transparent text-ink"
                        onClick={() => updateOffset(offsetMs + LYRIC_OFFSET_NUDGE_MS)}
                        aria-label="Advance lyrics"
                        title="Advance lyrics"
                      >
                        <Plus size={14} strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        className="v3-focus grid h-8 w-8 shrink-0 cursor-pointer place-items-center border border-separator-soft bg-transparent text-muted"
                        onClick={() => updateOffset(0)}
                        aria-label="Reset lyrics offset"
                        title="Reset lyrics offset"
                      >
                        <RotateCcw size={14} strokeWidth={1.8} />
                      </button>
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="v3-scroll mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto pb-4">
        {lyrics.synced && <div className="h-[calc(50%-1.4rem)] shrink-0" aria-hidden="true" />}
        {lyrics.lines.map((line, index) => {
          const isActive = index === active;
          return (
            <div
              key={`${line.startMs ?? 'plain'}-${index}`}
              ref={isActive ? activeRef : undefined}
              className={cn(
                'border-l py-2 pr-3 pl-3 text-[14px] leading-relaxed transition-colors',
                isActive
                  ? 'border-vermilion bg-[color-mix(in_oklab,var(--accent)_5%,transparent)] text-ink'
                  : 'border-separator-soft text-muted',
                !lyrics.synced && 'border-separator-soft text-ink',
              )}
            >
              {line.text}
            </div>
          );
        })}
        {lyrics.synced && <div className="h-[calc(50%-1.4rem)] shrink-0" aria-hidden="true" />}
      </div>
    </div>
  );
}
