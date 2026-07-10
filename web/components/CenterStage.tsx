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
import type { NowPlayingTrack, QueueEntry, SessionTurn } from '@/lib/types';

/** How close to the end of the current track (seconds) the "up next" tease
 *  fades in. Picks land at the previous track's start, so the queue head is
 *  known well before this — the window is about pacing, not data. */
const UP_NEXT_WINDOW_S = 30;

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
  /** Stream confirmed offline (see PlayerApp) — the stage shows an explicit
   *  off-air state instead of a stale "Now playing". */
  offline: boolean;
  /** Head of the controller's upcoming queue, teased near the end of the
   *  current track. Null when the queue is empty. */
  upNext: QueueEntry | null;
  onOpenBooth: () => void;
  onOpenTimeline: () => void;
}

export default memo(function CenterStage({ nowPlaying, trackStartedAt, llmTokens, feed, djLineOn, boothBuddyOn, offline, upNext, onOpenBooth, onOpenTimeline }: CenterStageProps) {
  const { apiUrl } = useStationOrigin();
  // The 1s elapsed tick lives here, in the component that displays it, so it
  // only re-renders this subtree — not the whole player (see useElapsed).
  const elapsed = useElapsed(trackStartedAt);
  const has = !!nowPlaying?.title;
  // Track info is only trustworthy while the stream is up — everything the
  // stage shows about "now" (title, meta, DJ line, art) gates on `live` so an
  // outage reads as off-air instead of a frozen now-playing.
  const live = has && !offline;
  const metaTokens = buildMetaTokens(nowPlaying);
  const moodPhrase = buildMoodPhrase(nowPlaying);
  const hasMeta = metaTokens.length > 0 || moodPhrase.length > 0;
  const duration = nowPlaying?.duration ?? 0;
  const subsonicId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = subsonicId
    ? `${apiUrl}/cover/${encodeURIComponent(subsonicId)}`
    : null;
  const showArt = !!coverSrc && !offline;
  // Title key keeps placeholder + real titles in the same AnimatePresence so
  // the first-track-arrives transition cross-dissolves the "scanning" line out.
  const titleKey = offline ? 'offline' : has ? `t:${nowPlaying?.title}` : 'placeholder';

  // Clock mode for the caption readout: elapsed (2:31 / 4:05) or remaining
  // (-1:34 / 4:05). Tapping the readout flips it; persisted like the ticker
  // preference and hydrated in an effect to avoid an SSR mismatch.
  const [showRemaining, setShowRemaining] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem('subwave:remaining');
      if (v != null) setShowRemaining(v === '1');
    } catch {}
  }, []);
  const toggleClock = () => {
    setShowRemaining(v => {
      const next = !v;
      try { localStorage.setItem('subwave:remaining', next ? '1' : '0'); } catch {}
      return next;
    });
  };
  const remaining = Math.max(0, duration - elapsed);

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
  useDynamicStyle(coverRef, { '--cover': showArt ? `url("${coverSrc}")` : null });

  return (
    // Bounded region between the header and the waveform band, with the content
    // centred inside it (justify-center). Previously this was centred in the
    // whole viewport (top-1/2 -translate-y-[64%]) and grew downward freely, so a
    // long DJ line — or any line on a short/wide window — spilled over the
    // bottom-pinned Waveform (issue #576). The bottom reserve clears the
    // compact waveform (top ≈ 206px from bottom); on tall desktop windows the
    // waveform grows to its full band, so the reserve grows to match it.
    // On short/wide windows the content bottom-aligns instead: centring left
    // the vertical slack as a dead gap between the track info and the band, and
    // anchoring the bottom edge means long DJ lines grow upward, never over the
    // waveform. The reserve drops to 212px there to hug the raised 208px band.
    // The right reserve tracks the DotRail width: slimmed on phones (see
    // DotRail's <sm sizing) so the title/DJ-line column keeps ~20px more of a
    // 375px screen, full 96px from sm up.
    <div className="absolute top-[72px] right-[80px] bottom-[220px] left-4 flex flex-col items-start justify-center sm:right-24 sm:left-8 [@media(min-width:640px)_and_(max-height:759px)]:bottom-[212px] [@media(min-width:640px)_and_(max-height:759px)]:justify-end [@media(min-width:640px)_and_(min-height:760px)]:bottom-[300px]">
      <div className="isolate flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-6">
        {/* Always rendered — a track without artwork (or an off-air stage) gets
            the disc-mark placeholder instead of collapsing the slot and jumping
            the text column left (see .v3-cover-placeholder). */}
        <button
          ref={coverRef}
          type="button"
          onClick={onOpenTimeline}
          aria-label="Open the timeline"
          className={cn(
            // Art sizes to width but is capped by viewport height (20vh) so a
            // short/wide window doesn't spend a third of its height on the
            // cover; tall viewports resolve min() to 14vw. The 96px floor is
            // what phones get (14vw is only ~55px on a 390px screen — too
            // small a target for the tap-to-timeline it carries).
            'v3-cover-frame v3-focus relative h-[clamp(96px,min(14vw,20vh),160px)] w-[clamp(96px,min(14vw,20vh),160px)] shrink-0 appearance-none border-0 bg-transparent p-0',
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
            {/* Placeholder sits under the art, so a failed image load (the img
                hides itself onError) falls back to it too. */}
            <span className="v3-cover-placeholder" aria-hidden="true" />
            {showArt && (
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
            )}
            <span className="v3-cover-scan" aria-hidden="true" />
          </div>
          <span className="v3-cover-tick v3-cover-tick--tl" aria-hidden="true" />
          <span className="v3-cover-tick v3-cover-tick--tr" aria-hidden="true" />
          <span className="v3-cover-tick v3-cover-tick--bl" aria-hidden="true" />
          <span className="v3-cover-tick v3-cover-tick--br" aria-hidden="true" />
        </button>
        <div className="min-w-0">
          <div className="v3-caption mb-[14px] text-muted">
            {offline ? (
              'Off air'
            ) : (
              <>
                Now playing
                {live && duration > 0 ? (
                  <>
                    {' — '}
                    {/* Tap the readout to flip elapsed ↔ remaining — radio time
                        is mostly "how long until the next thing happens". */}
                    <button
                      type="button"
                      onClick={toggleClock}
                      title={showRemaining ? 'Show elapsed time' : 'Show time remaining'}
                      aria-label={showRemaining ? 'Time remaining — switch to elapsed' : 'Elapsed time — switch to remaining'}
                      className="v3-focus v3-tab-num cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-inherit uppercase"
                    >
                      {showRemaining
                        ? `-${fmtTime(remaining)} / ${fmtTime(duration)}`
                        : `${fmtTime(elapsed)} / ${fmtTime(duration)}`}
                    </button>
                  </>
                ) : live ? ` — ${fmtTime(elapsed)}` : ''}
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
              {live ? (
                <>
                  {/* Clamped so a very long title can't eat the bounded region
                      and squeeze out the DJ line (the h1 flavour of #576). */}
                  <h1 className="v3-title m-0 line-clamp-2 text-ink" title={nowPlaying?.title}>
                    {nowPlaying?.title}
                  </h1>
                  <div className="mt-[4px] text-[clamp(13px,1.4vw,18px)] leading-snug font-medium text-muted">
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
                  {offline ? 'off air' : 'scanning the dial'}
                  <span className="v3-blink ml-[0.1em]">_</span>
                </h1>
              )}
            </m.div>
          </AnimatePresence>
        </div>
      </div>

      {live && (
        <DjThinkingLine feed={feed} enabled={djLineOn} currentTrackId={subsonicId} buddyOn={boothBuddyOn} onOpenBooth={onOpenBooth} />
      )}

      {/* "Up next" tease — the queue head, fading in for the last stretch of
          the current track like a real radio board. Needs a known duration to
          time the window; taps through to the Timeline drawer. */}
      <AnimatePresence>
        {live && upNext?.title && duration > 0 && remaining <= UP_NEXT_WINDOW_S && (
          <m.button
            key="up-next"
            type="button"
            onClick={onOpenTimeline}
            title="Open the timeline"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="v3-caption v3-focus mt-[10px] max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-muted"
          >
            <span className="text-vermilion">↦ up next</span>
            {' · '}
            <span className="text-ink">{upNext.title}</span>
            {upNext.artist ? ` — ${upNext.artist}` : ''}
          </m.button>
        )}
      </AnimatePresence>
    </div>
  );
});
