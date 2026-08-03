'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useStationClient } from '@/lib/stationClient';
import type { PublicLyricsPayload } from '@/lib/types';

export interface LyricsDrawerProps {
  songId?: string | null;
  title?: string;
  artist?: string;
  trackStartedAt: number | null;
}

function activeLineIndex(lyrics: PublicLyricsPayload | null, elapsedMs: number): number {
  if (!lyrics?.synced) return -1;
  let active = -1;
  for (let i = 0; i < lyrics.lines.length; i += 1) {
    const startMs = lyrics.lines[i]?.startMs;
    if (startMs == null) continue;
    if (startMs > elapsedMs) break;
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
  const activeRef = useRef<HTMLDivElement | null>(null);

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
  const active = useMemo(() => activeLineIndex(lyrics, elapsedMs), [lyrics, elapsedMs]);

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
    <div>
      <div className="mb-4 border-b border-separator-soft pb-4">
        <div className="truncate text-lg leading-tight font-semibold">{title || 'Now playing'}</div>
        {artist && <div className="mt-0.5 truncate text-xs text-muted">{artist}</div>}
        <div className="mt-3 text-[9px] tracking-[0.3em] text-muted uppercase">
          {lyrics.synced ? 'Synced lyrics' : 'Lyrics'}
        </div>
      </div>

      <div className="flex flex-col gap-1 pb-8">
        {lyrics.lines.map((line, index) => {
          const isActive = index === active;
          return (
            <div
              key={`${line.startMs ?? 'plain'}-${index}`}
              ref={isActive ? activeRef : undefined}
              className={cn(
                'border-l-2 py-2 pr-3 pl-4 text-[15px] leading-relaxed transition-colors',
                isActive
                  ? 'border-vermilion bg-[rgba(197,48,42,0.08)] text-ink'
                  : 'border-transparent text-muted',
                !lyrics.synced && 'border-separator-soft text-ink',
              )}
            >
              {line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
