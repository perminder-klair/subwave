'use client';

import { AnimatePresence, m } from 'motion/react';
import { fmtTime } from '@/lib/format';
import DjThinkingLine from './DjThinkingLine';
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
  const coverSrc = nowPlaying?.subsonic_id
    ? `${API_URL}/cover/${encodeURIComponent(nowPlaying.subsonic_id)}`
    : null;
  // Title key keeps placeholder + real titles in the same AnimatePresence so
  // the first-track-arrives transition cross-dissolves the "scanning" line out.
  const titleKey = has ? `t:${nowPlaying?.title}` : 'placeholder';

  return (
    <div className="absolute top-1/2 right-24 left-4 flex -translate-y-[58%] flex-col items-start sm:left-8">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-6">
        {coverSrc && (
          <div className="relative h-[clamp(72px,14vw,160px)] w-[clamp(72px,14vw,160px)] shrink-0 overflow-hidden rounded-sm border border-muted">
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
