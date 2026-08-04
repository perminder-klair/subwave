'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Minus, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
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

const OFFSET_VISIBLE_STORAGE_KEY = 'subwave:lyrics-offset-visible';

export default function LyricsDrawer({ songId, title, artist, trackStartedAt }: LyricsDrawerProps) {
  const [showOffset, setShowOffset] = useState(false);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const {
    lyrics,
    loading,
    failed,
    offsetMs,
    activeLineIndex: active,
    updateOffset,
  } = useCurrentLyrics({ songId, trackStartedAt });

  useEffect(() => {
    try {
      setShowOffset(window.localStorage.getItem(OFFSET_VISIBLE_STORAGE_KEY) === '1');
    } catch {}
  }, []);

  const toggleOffset = () => {
    setShowOffset(next => {
      const visible = !next;
      try {
        window.localStorage.setItem(OFFSET_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
      } catch {}
      return visible;
    });
  };

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

  if (loading) {
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
                <button
                  type="button"
                  className={cn(
                    'v3-focus grid h-7 w-7 place-items-center border border-separator-soft bg-transparent text-muted transition-colors',
                    showOffset && 'border-ink bg-ink text-bg',
                  )}
                  onClick={toggleOffset}
                  aria-pressed={showOffset}
                  aria-label="Lyrics offset controls"
                  title="Lyrics offset controls"
                >
                  <SlidersHorizontal size={15} strokeWidth={1.7} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="v3-scroll mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto pb-4">
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
      </div>

      {lyrics.synced && showOffset && (
        <div
          className="shrink-0 border-t border-separator-soft pt-3"
          data-lyric-offset
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
        </div>
      )}
    </div>
  );
}
