'use client';

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Minus, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSkinCalm } from '@/components/skins/sharedHooks';
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

// After the listener scrolls the lyrics themselves, the panel stops following
// the sung line for this long, so reading back up a verse is not yanked away.
const FOLLOW_PAUSE_MS = 6_000;

const ICON_BUTTON =
  'v3-focus grid h-8 w-8 shrink-0 cursor-pointer place-items-center border border-separator-soft bg-transparent text-ink disabled:cursor-default disabled:opacity-40';

function Note({ children }: { children: ReactNode }) {
  return <div className="text-[13px] leading-relaxed text-muted">{children}</div>;
}

export default function LyricsDrawer({ songId, title, artist, trackStartedAt }: LyricsDrawerProps) {
  const [showOffset, setShowOffset] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const userScrolledAt = useRef(0);
  const followedOnce = useRef(false);
  const calm = useSkinCalm();
  const deviceHintId = useId();
  const stationHintId = useId();
  const { status, lyrics, activeLineIndex: active, deviceOffsetMs, setDeviceOffsetMs, station } =
    useCurrentLyrics({ songId, trackStartedAt });

  useEffect(() => {
    try {
      setShowOffset(window.localStorage.getItem(OFFSET_VISIBLE_STORAGE_KEY) === '1');
    } catch {}
  }, []);

  const toggleOffset = () => {
    setShowOffset(prev => {
      const visible = !prev;
      try {
        window.localStorage.setItem(OFFSET_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
      } catch {}
      return visible;
    });
  };

  const markUserScroll = useCallback(() => {
    userScrolledAt.current = Date.now();
  }, []);

  useEffect(() => {
    followedOnce.current = false;
  }, [songId]);

  // Follow the sung line inside the panel's own scroller. scrollIntoView would
  // also move every scrolling ancestor, the drawer and the page included.
  useEffect(() => {
    const box = scrollRef.current;
    const line = activeRef.current;
    if (active < 0 || !box || !line) return;
    if (Date.now() - userScrolledAt.current < FOLLOW_PAUSE_MS) return;
    const boxRect = box.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const top = box.scrollTop + (lineRect.top - boxRect.top) - (box.clientHeight - lineRect.height) / 2;
    // The first jump on opening is instant; so is every one under reduced
    // motion or lite mode.
    const smooth = followedOnce.current && !calm;
    followedOnce.current = true;
    box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }, [active, calm]);

  if (!songId) {
    return <Note>Lyrics are available for library tracks once the station has indexed them.</Note>;
  }
  if (status === 'disabled') return <Note>Lyrics are switched off on this station.</Note>;
  if (status === 'gone') return <Note>This song has left the air, so its lyrics are no longer available.</Note>;
  if (status === 'locked') return <Note>This station is private. Unlock the player with its password to see lyrics.</Note>;
  if (status === 'unavailable') {
    return <Note>Lyrics are not reachable right now. Trying again…</Note>;
  }
  if (status !== 'ready' || !lyrics) return <Note>Pulling lyrics from the library…</Note>;

  if (!lyrics.lines.length) {
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
          {lyrics.synced && (
            <div className="flex shrink-0 items-center gap-2">
              <div className="v3-tab-num text-[9px] tracking-[0.18em] text-muted uppercase">Synced</div>
              <button
                type="button"
                className={cn(
                  'v3-focus grid h-7 w-7 place-items-center border border-separator-soft bg-transparent text-muted transition-colors',
                  showOffset && 'border-ink bg-ink text-bg',
                )}
                onClick={toggleOffset}
                aria-pressed={showOffset}
                aria-label="Lyrics timing controls"
                title="Lyrics timing controls"
              >
                <SlidersHorizontal size={15} strokeWidth={1.7} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="v3-scroll mt-3 flex min-h-24 flex-1 flex-col overflow-y-auto pb-4"
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        onKeyDown={markUserScroll}
      >
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
        <div className="shrink-0 border-t border-separator-soft pt-2">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div className="text-[9px] tracking-[0.28em] text-muted uppercase" title="Only changes what this browser shows">
              This device
              <span id={deviceHintId} className="sr-only">Only changes what this browser shows.</span>
            </div>
            <div className="v3-tab-num shrink-0 text-[11px] tracking-[0.1em] text-ink">{formatLyricOffset(deviceOffsetMs)}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => setDeviceOffsetMs(deviceOffsetMs - LYRIC_OFFSET_NUDGE_MS)}
              aria-label="Delay lyrics on this device"
              title="Delay lyrics"
            >
              <Minus size={14} strokeWidth={1.8} />
            </button>
            <input
              type="range"
              min={LYRIC_OFFSET_MIN_MS}
              max={LYRIC_OFFSET_MAX_MS}
              step={LYRIC_OFFSET_STEP_MS}
              value={deviceOffsetMs}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setDeviceOffsetMs(Number(event.target.value))}
              aria-label="Lyrics timing on this device"
              aria-valuetext={formatLyricOffset(deviceOffsetMs)}
              aria-describedby={deviceHintId}
              className="h-8 min-w-0 flex-1 accent-[var(--accent)] opacity-70"
            />
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => setDeviceOffsetMs(deviceOffsetMs + LYRIC_OFFSET_NUDGE_MS)}
              aria-label="Advance lyrics on this device"
              title="Advance lyrics"
            >
              <Plus size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={cn(ICON_BUTTON, 'text-muted')}
              onClick={() => setDeviceOffsetMs(0)}
              aria-label="Reset lyrics timing on this device"
              title="Reset"
            >
              <RotateCcw size={14} strokeWidth={1.8} />
            </button>
          </div>

          {station.canTune && (
            <div className="mt-2 border-t border-separator-soft pt-2">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <div
                  className="text-[9px] tracking-[0.28em] text-muted uppercase"
                  title="Fixes this track's lyric file for every listener. Shown because this browser is signed in as the operator."
                >
                  Station · this track
                  <span id={stationHintId} className="sr-only">
                    Fixes this track&apos;s lyric file for every listener, once saved.
                  </span>
                </div>
                <div className="v3-tab-num shrink-0 text-[11px] tracking-[0.1em] text-ink" aria-live="polite">
                  <span className="sr-only">Station timing </span>
                  {formatLyricOffset(station.offsetMs)}
                  {station.dirty && <span className="sr-only">, not saved</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={ICON_BUTTON}
                  onClick={() => station.set(station.offsetMs - LYRIC_OFFSET_NUDGE_MS)}
                  disabled={station.saving}
                  aria-label="Delay this track's lyrics for every listener"
                  aria-describedby={stationHintId}
                  title="Delay lyrics"
                >
                  <Minus size={14} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className={ICON_BUTTON}
                  onClick={() => station.set(station.offsetMs + LYRIC_OFFSET_NUDGE_MS)}
                  disabled={station.saving}
                  aria-label="Advance this track's lyrics for every listener"
                  aria-describedby={stationHintId}
                  title="Advance lyrics"
                >
                  <Plus size={14} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className={cn(ICON_BUTTON, 'text-muted')}
                  onClick={() => station.set(0)}
                  disabled={station.saving || station.offsetMs === 0}
                  aria-label="Clear this track's station timing"
                  aria-describedby={stationHintId}
                  title="Clear"
                >
                  <RotateCcw size={14} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="v3-focus ml-auto h-8 cursor-pointer border border-ink bg-ink px-3 text-[10px] tracking-[0.2em] text-bg uppercase disabled:cursor-default disabled:opacity-40"
                  onClick={() => void station.save()}
                  disabled={!station.dirty || station.saving}
                >
                  {station.saving ? 'Saving…' : 'Save'}
                </button>
              </div>
              {station.error && (
                <div className="mt-1 text-[10px] leading-snug text-vermilion" role="alert">{station.error}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
