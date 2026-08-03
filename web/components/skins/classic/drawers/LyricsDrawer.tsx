'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStationClient } from '@/lib/stationClient';
import type { PublicLyricsPayload } from '@/lib/types';

export interface LyricsDrawerProps {
  songId?: string | null;
  title?: string;
  artist?: string;
  trackStartedAt: number | null;
}

const OFFSET_STORAGE_KEY = 'subwave:lyrics-offset-ms';
const OFFSET_VISIBLE_STORAGE_KEY = 'subwave:lyrics-offset-visible';
const OFFSET_MIN_MS = -5000;
const OFFSET_MAX_MS = 5000;
const OFFSET_STEP_MS = 50;
const OFFSET_NUDGE_MS = 100;

function clampOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(OFFSET_MAX_MS, Math.max(OFFSET_MIN_MS, Math.round(value)));
}

function formatOffset(ms: number): string {
  if (ms === 0) return '0.00s';
  return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(2)}s`;
}

function activeLineIndex(lyrics: PublicLyricsPayload | null, elapsedMs: number, offsetMs: number): number {
  if (!lyrics?.synced) return -1;
  const adjustedElapsedMs = Math.max(0, elapsedMs + offsetMs);
  let active = -1;
  for (let i = 0; i < lyrics.lines.length; i += 1) {
    const startMs = lyrics.lines[i]?.startMs;
    if (startMs == null) continue;
    if (startMs > adjustedElapsedMs) break;
    active = i;
  }
  return active;
}

export default function LyricsDrawer({ songId, title, artist, trackStartedAt }: LyricsDrawerProps) {
  const client = useStationClient();
  const [lyrics, setLyrics] = useState<PublicLyricsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [offsetMs, setOffsetMs] = useState(0);
  const [showOffset, setShowOffset] = useState(false);
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(OFFSET_STORAGE_KEY);
      if (stored != null) setOffsetMs(clampOffsetMs(Number(stored)));
      setShowOffset(window.localStorage.getItem(OFFSET_VISIBLE_STORAGE_KEY) === '1');
    } catch {}
  }, []);

  const updateOffset = (next: number) => {
    const clamped = clampOffsetMs(next);
    setOffsetMs(clamped);
    try {
      window.localStorage.setItem(OFFSET_STORAGE_KEY, String(clamped));
    } catch {}
  };

  const toggleOffset = () => {
    setShowOffset(next => {
      const visible = !next;
      try {
        window.localStorage.setItem(OFFSET_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
      } catch {}
      return visible;
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLyrics(null);
    setFailed(false);
    if (!songId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    client.currentLyrics()
      .then((payload) => {
        if (cancelled) return;
        setLyrics(payload?.songId === songId ? payload : null);
        setFailed(payload == null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [client, songId]);

  useEffect(() => {
    if (!lyrics?.synced) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [lyrics?.synced, trackStartedAt]);

  const elapsedMs = trackStartedAt == null ? 0 : Math.max(0, nowMs - trackStartedAt);
  const active = useMemo(() => activeLineIndex(lyrics, elapsedMs, offsetMs), [lyrics, elapsedMs, offsetMs]);

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
      <div className="shrink-0 border-y border-separator-soft py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="truncate text-[16px] leading-tight font-semibold">{title || 'Now playing'}</div>
            {artist && <div className="mt-1 truncate text-[11px] tracking-[0.16em] text-muted uppercase">{artist}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="v3-tab-num text-[10px] tracking-[0.18em] text-vermilion uppercase">
              {lyrics.synced ? 'Synced' : 'Plain'}
            </div>
            {lyrics.synced && (
              <button
                type="button"
                className={cn(
                  'v3-focus grid h-8 w-8 place-items-center border border-separator-soft bg-transparent text-ink',
                  showOffset && 'bg-ink text-bg',
                )}
                onClick={toggleOffset}
                aria-pressed={showOffset}
                aria-label="Lyrics offset controls"
                title="Lyrics offset controls"
              >
                <SlidersHorizontal size={15} strokeWidth={1.7} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="v3-scroll mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto pb-5">
        {lyrics.lines.map((line, index) => {
          const isActive = index === active;
          return (
            <div
              key={`${line.startMs ?? 'plain'}-${index}`}
              ref={isActive ? activeRef : undefined}
              className={cn(
                'border-l py-[9px] pr-3 pl-4 text-[15px] leading-relaxed transition-colors',
                isActive
                  ? 'border-vermilion bg-[color-mix(in_oklab,var(--accent)_9%,transparent)] text-ink shadow-[inset_1px_0_0_var(--accent)]'
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
          className="shrink-0 px-4 pt-3 pb-4 [backdrop-filter:blur(18px)_saturate(1.4)] [-webkit-backdrop-filter:blur(18px)_saturate(1.4)] sm:px-5"
          data-lyric-offset
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-[9px] tracking-[0.28em] text-muted uppercase">Lyric offset</div>
            <div className="v3-tab-num text-[11px] tracking-[0.1em] text-ink">{formatOffset(offsetMs)}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="v3-focus h-8 w-8 shrink-0 cursor-pointer border border-separator-soft bg-transparent text-[15px] leading-none text-ink"
              onClick={() => updateOffset(offsetMs - OFFSET_NUDGE_MS)}
              aria-label="Delay lyrics"
            >
              -
            </button>
            <input
              type="range"
              min={OFFSET_MIN_MS}
              max={OFFSET_MAX_MS}
              step={OFFSET_STEP_MS}
              value={offsetMs}
              onChange={onOffsetInput}
              aria-label="Lyric offset"
              className="h-8 min-w-0 flex-1 accent-[var(--accent)]"
            />
            <button
              type="button"
              className="v3-focus h-8 w-8 shrink-0 cursor-pointer border border-separator-soft bg-transparent text-[15px] leading-none text-ink"
              onClick={() => updateOffset(offsetMs + OFFSET_NUDGE_MS)}
              aria-label="Advance lyrics"
            >
              +
            </button>
            <button
              type="button"
              className="v3-focus h-8 shrink-0 cursor-pointer border border-separator-soft bg-transparent px-2 text-[9px] tracking-[0.18em] text-muted uppercase"
              onClick={() => updateOffset(0)}
            >
              Zero
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
