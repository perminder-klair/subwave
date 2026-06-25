'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Coins } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fmtTime } from '@/lib/format';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { useElapsed } from '@/hooks/useElapsed';
import DjThinkingLine from './DjThinkingLine';
import CountUp from './CountUp';
import { Ripple } from './ui/ripple';
import { isDjTurn } from '@/lib/sessionFeed';
import { useStationOrigin } from '@/lib/stationOrigin';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';

/** The quiet "music nerd" tokens shown under artist/album: genre · BPM · key.
 *  Returned separately from the mood cluster so the latter can carry the accent
 *  colour. Each token is omitted when its field is absent, so an untagged track
 *  yields an empty array and the strip doesn't render at all. */
function buildMetaTokens(t: NowPlayingTrack | null): string[] {
  if (!t) return [];
  const tokens: string[] = [];
  if (t.genre) tokens.push(t.genre.toUpperCase());
  if (typeof t.bpm === 'number' && t.bpm > 0) tokens.push(`${Math.round(t.bpm)} BPM`);
  if (t.musicalKey) tokens.push(t.musicalKey);
  return tokens;
}

/** The mood/energy phrase, e.g. "mellow · low energy". Up to two moods plus the
 *  energy level; empty string when the track carries neither. */
function buildMoodPhrase(t: NowPlayingTrack | null): string {
  if (!t) return '';
  const parts: string[] = [];
  if (Array.isArray(t.moods)) parts.push(...t.moods.slice(0, 2));
  if (t.energy) parts.push(`${t.energy} energy`);
  return parts.join(' · ');
}

export interface CenterStageProps {
  nowPlaying: NowPlayingTrack | null;
  /** Epoch ms when the current track started (from useStationFeed). */
  trackStartedAt: number | null;
  /** Cumulative since-boot LLM token total, or null before the first poll. */
  llmTokens: number | null;
  feed: SessionTurn[];
  djLineOn: boolean;
  /** Station-wide toggle for the Booth Sprite mascot; the DJ line falls back to
   *  the classic ♪/◇ marker when off. */
  boothBuddyOn: boolean;
  onOpenBooth: () => void;
  onOpenTimeline: () => void;
}

export default memo(function CenterStage({ nowPlaying, trackStartedAt, llmTokens, feed, djLineOn, boothBuddyOn, onOpenBooth, onOpenTimeline }: CenterStageProps) {
  const { apiUrl } = useStationOrigin();
  // The 1s elapsed tick lives here, in the component that displays it, so it
  // only re-renders this subtree — not the whole player (see useElapsed).
  const elapsed = useElapsed(trackStartedAt);
  const has = !!nowPlaying?.title;
  const metaTokens = buildMetaTokens(nowPlaying);
  const moodPhrase = buildMoodPhrase(nowPlaying);
  const hasMeta = metaTokens.length > 0 || moodPhrase.length > 0;
  const duration = nowPlaying?.duration ?? 0;
  const subsonicId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = subsonicId
    ? `${apiUrl}/cover/${encodeURIComponent(subsonicId)}`
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

  // Feed the current cover URL into the CSS `--cover` custom property so the
  // hover-glitch channel ghosts (globals.css `.v3-cover-*`) can paint copies of
  // the art. useDynamicStyle keeps this off the lint-forbidden `style` prop.
  const coverRef = useRef<HTMLButtonElement>(null);
  useDynamicStyle(coverRef, { '--cover': coverSrc ? `url("${coverSrc}")` : null });

  return (
    // Bounded region between the header and the waveform band, with the content
    // centred inside it (justify-center). Previously this was centred in the
    // whole viewport (top-1/2 -translate-y-[64%]) and grew downward freely, so a
    // long DJ line — or any line on a short/wide window — spilled over the
    // bottom-pinned Waveform (issue #576). The bottom reserve clears the
    // compact waveform (top ≈ 206px from bottom); on tall desktop windows the
    // waveform grows to its full band, so the reserve grows to match it.
    <div className="absolute top-[72px] right-24 bottom-[220px] left-4 flex flex-col items-start justify-center sm:left-8 [@media(min-width:640px)_and_(min-height:760px)]:bottom-[300px]">
      <div className="isolate flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-6">
        {coverSrc && (
          <button
            ref={coverRef}
            type="button"
            onClick={onOpenTimeline}
            aria-label="Open the timeline"
            className={cn(
              'v3-cover-frame v3-focus relative h-[clamp(72px,14vw,160px)] w-[clamp(72px,14vw,160px)] shrink-0 appearance-none border-0 bg-transparent p-0',
              // Glitch the art in sync with the ripple waves — track change + DJ speaking.
              rippleActive && 'v3-cover-live',
            )}
          >
            <Ripple
              active={rippleActive}
              mainCircleSize={140}
              mainCircleOpacity={0.28}
              numCircles={6}
              className="-inset-[220px] -z-10"
            />
            <div className="v3-cover-glitch relative h-full w-full overflow-hidden rounded-sm border border-muted">
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
              <span className="v3-cover-scan" aria-hidden="true" />
            </div>
            <span className="v3-cover-tick v3-cover-tick--tl" aria-hidden="true" />
            <span className="v3-cover-tick v3-cover-tick--tr" aria-hidden="true" />
            <span className="v3-cover-tick v3-cover-tick--bl" aria-hidden="true" />
            <span className="v3-cover-tick v3-cover-tick--br" aria-hidden="true" />
          </button>
        )}
        <div className="min-w-0">
          <div className="v3-caption mb-[14px] text-muted">
            Now playing{has && duration ? ` — ${fmtTime(elapsed)} / ${fmtTime(duration)}` : has ? ` — ${fmtTime(elapsed)}` : ''}
            {llmTokens != null && (
              <>
                {' · '}
                <span
                  className="inline-flex items-center gap-1 align-middle text-muted"
                  title="LLM tokens generated since the station booted"
                  aria-label={`${llmTokens.toLocaleString('en-US')} AI tokens generated`}
                >
                  <Coins size={12} strokeWidth={1.75} aria-hidden="true" />
                  <CountUp value={llmTokens} className="v3-tab-num" />
                </span>
              </>
            )}
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
                  <div className="mt-[12px] text-[clamp(13px,1.4vw,18px)] leading-snug font-medium text-muted">
                    <span className="text-ink">{nowPlaying?.artist || 'Unknown artist'}</span>
                    {nowPlaying?.album && <span className="ml-[14px]"> · {nowPlaying.album}</span>}
                    {nowPlaying?.year && <span className="ml-[14px]"> · {nowPlaying.year}</span>}
                  </div>
                  {hasMeta && (
                    <div className="v3-caption mt-[10px] text-muted">
                      {metaTokens.join(' · ')}
                      {moodPhrase && (
                        <span className="text-vermilion">
                          {metaTokens.length > 0 ? ' · ' : ''}↳ {moodPhrase}
                        </span>
                      )}
                    </div>
                  )}
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
        <DjThinkingLine feed={feed} enabled={djLineOn} buddyOn={boothBuddyOn} onOpenBooth={onOpenBooth} />
      )}
    </div>
  );
});
