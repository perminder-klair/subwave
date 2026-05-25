'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { fmtTime } from '@/lib/format';
import DjThinkingLine from './DjThinkingLine';
import { Ripple } from './ui/ripple';
import { isDjTurn } from '@/lib/sessionFeed';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

export interface CenterStageProps {
  nowPlaying: NowPlayingTrack | null;
  elapsed: number;
  feed: SessionTurn[];
  djLineOn: boolean;
  onOpenBooth: () => void;
}

export default function CenterStage({ nowPlaying, elapsed, feed, djLineOn, onOpenBooth }: CenterStageProps) {
  const has = !!nowPlaying?.title;
  const duration = nowPlaying?.duration ?? 0;
  const subsonicId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = subsonicId
    ? `${API_URL}/cover/${encodeURIComponent(subsonicId)}`
    : null;
  // Title key keeps placeholder + real titles in the same AnimatePresence so
  // the first-track-arrives transition cross-dissolves the "scanning" line out.
  const titleKey = has ? `t:${nowPlaying?.title}` : 'placeholder';

  // Ripple bursts for ~3s on two signals: every track change (subsonic_id
  // flip), and every new DJ turn (voice/dj) landing in the feed.
  // djLineOn is a listener preference for the ticker, not a "talking now"
  // flag, so it can't gate the ripple.
  // SessionTurn.t is `string | number | undefined` — ISO timestamps from one
  // path, unix-ms from another. The value is only ever used as a useEffect
  // dep (Object.is change detection), so any stable identifier works.
  const latestDjTurnT = useMemo<string | number | null>(() => {
    if (!feed?.length) return null;
    for (let i = feed.length - 1; i >= 0; i--) {
      const turn = feed[i];
      if (turn && isDjTurn(turn) && turn.text) return turn.t ?? i;
    }
    return null;
  }, [feed]);

  const [trackBurst, setTrackBurst] = useState(false);
  useEffect(() => {
    if (!subsonicId) return;
    setTrackBurst(true);
    const t = setTimeout(() => setTrackBurst(false), 3000);
    return () => clearTimeout(t);
  }, [subsonicId]);

  const [djBurst, setDjBurst] = useState(false);
  useEffect(() => {
    if (latestDjTurnT == null) return;
    setDjBurst(true);
    const t = setTimeout(() => setDjBurst(false), 3000);
    return () => clearTimeout(t);
  }, [latestDjTurnT]);

  const rippleActive = trackBurst || djBurst;

  return (
    <div className="absolute top-1/2 right-24 left-4 flex -translate-y-[58%] flex-col items-start sm:left-8">
      <div className="isolate flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-6">
        {coverSrc && (
          <div className="relative h-[clamp(72px,14vw,160px)] w-[clamp(72px,14vw,160px)] shrink-0">
            <Ripple
              active={rippleActive}
              mainCircleSize={140}
              mainCircleOpacity={0.28}
              numCircles={6}
              className="-inset-[220px] -z-10"
            />
            <div className="relative h-full w-full overflow-hidden rounded-sm border border-muted">
              <AnimatePresence mode="popLayout" initial={false}>
                <m.img
                  key={coverSrc}
                  src={coverSrc}
                  alt=""
                  initial={{ opacity: 0, scale: 1.02 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              </AnimatePresence>
            </div>
          </div>
        )}
        <div className="min-w-0">
          <div className="v3-caption mb-[14px] text-muted">
            Now playing{has && duration ? ` — ${fmtTime(elapsed)} / ${fmtTime(duration)}` : has ? ` — ${fmtTime(elapsed)}` : ''}
          </div>
          <AnimatePresence mode="popLayout" initial={false}>
            <m.div
              key={titleKey}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.24 }}
            >
              {has ? (
                <>
                  <h1 className="v3-title m-0 text-ink">
                    {nowPlaying?.title}
                  </h1>
                  <div className="v3-subtitle mt-[12px] text-muted">
                    <span className="text-ink">{nowPlaying?.artist || 'Unknown artist'}</span>
                    {nowPlaying?.album && <span className="ml-[14px]"> · {nowPlaying.album}</span>}
                    {nowPlaying?.year && <span className="ml-[14px]"> · {nowPlaying.year}</span>}
                  </div>
                </>
              ) : (
                <h1 className="v3-title m-0 text-muted">
                  scanning the dial
                  <span className="v3-blink ml-[0.1em]">_</span>
                </h1>
              )}
            </m.div>
          </AnimatePresence>
        </div>
      </div>

      {has && (
        <DjThinkingLine feed={feed} enabled={djLineOn} onOpenBooth={onOpenBooth} />
      )}
    </div>
  );
}
