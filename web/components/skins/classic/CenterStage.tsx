'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Captions, CaptionsOff, Coins, Heart } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTrackLike } from '@/components/skins/sharedHooks';
import { fmtTime } from '@/lib/format';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { useElapsed } from '@/hooks/useElapsed';
import DjThinkingLine from './DjThinkingLine';
import CountUp from './CountUp';
import { Ripple } from '@/components/ui/ripple';
import { isDjTurn } from '@/lib/sessionFeed';
import { useStationClient } from '@/lib/stationClient';
import type { TrackLyrics } from '@/components/skins/lyrics';
import LyricsSettings, { usePopoverDismiss } from '@/components/skins/LyricsSettings';
import type { NowPlayingTrack, QueueEntry, SessionTurn } from '@/lib/types';

/** Seconds before the end of the track that the "up next" tease fades in. The
 *  queue head is known long before this; the window is pacing, not data. */
const UP_NEXT_WINDOW_S = 30;

/** Thin spaces, not word spaces: the caption's 0.16em tracking applies per
 *  character, so a plain " · " ballooned to ~13px of gap on a 10px font. */
const SEP = '\u2009·\u2009';

/** Genre · BPM · key, kept separate from the mood cluster so that can carry
 *  the accent colour. An untagged track yields an empty array and the strip
 *  doesn't render at all. */
function buildMetaTokens(t: NowPlayingTrack | null): string[] {
  if (!t) return [];
  const tokens: string[] = [];
  if (t.genre) tokens.push(t.genre.toUpperCase());
  if (typeof t.bpm === 'number' && t.bpm > 0) tokens.push(`${Math.round(t.bpm)} BPM`);
  if (t.musicalKey) tokens.push(t.musicalKey);
  return tokens;
}

/** Up to two moods plus the energy level; empty string when the track carries
 *  neither. */
function buildMoodPhrase(t: NowPlayingTrack | null): string {
  if (!t) return '';
  const parts: string[] = [];
  if (Array.isArray(t.moods)) parts.push(...t.moods.slice(0, 2));
  if (t.energy) parts.push(`${t.energy} energy`);
  return parts.join(SEP);
}

/** The like heart (#991). Renders nothing when likes are disabled or nothing
 *  likeable is on air. */
function LikeHeart() {
  const { available, liked, pending, count, like } = useTrackLike();
  if (!available) return null;
  return (
    <button
      type="button"
      onClick={like}
      disabled={pending || liked}
      aria-pressed={liked}
      aria-label={liked ? 'Liked' : 'Like this track'}
      title={liked ? 'Liked — saved to the station favourites' : 'Like this track'}
      className={cn(
        'v3-focus ml-[10px] inline-flex cursor-pointer items-center gap-[4px] border-0 bg-transparent p-0 align-middle transition-colors',
        liked ? 'text-vermilion' : 'text-muted hover:text-ink',
        pending && 'opacity-60',
      )}
    >
      <Heart size={15} strokeWidth={1.75} fill={liked ? 'currentColor' : 'none'} aria-hidden="true" />
      {count > 0 && <span className="v3-tab-num text-[11px]">{count}</span>}
    </button>
  );
}

/** This listener's lyrics, as the stage offers them: their switch, and the
 *  track's answer for the settings the button beside the heart opens. */
export interface StageLyrics {
  shown: boolean;
  onToggle: () => void;
  track: TrackLyrics;
}

/** The lyrics button beside the heart: shown whenever the station offers
 *  lyrics, so they can be turned back on from where they were. It opens the
 *  lyrics settings; L still shows and hides them at once. */
function LyricsButton({ shown, open, onOpen, buttonRef }: {
  shown: boolean;
  open: boolean;
  onOpen: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const Icon = shown ? Captions : CaptionsOff;
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Lyrics settings"
      title="Lyrics (L shows or hides them)"
      className={cn(
        'v3-focus ml-[10px] inline-flex cursor-pointer items-center border-0 bg-transparent p-0 align-middle transition-colors',
        shown || open ? 'text-ink' : 'text-muted hover:text-ink',
      )}
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
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
  /** Head of the controller's upcoming queue. Null when the queue is empty. */
  upNext: QueueEntry | null;
  /** Lyrics are showing (AmbientLyrics), synced or not: the stage gives them
   *  the right half on wide screens, everything under a one-row header on a
   *  phone, and a band above the waveform in between. */
  lyricsShown?: boolean;
  /** This listener's lyrics; absent while the station has lyrics off. */
  lyrics?: StageLyrics | null;
  onOpenBooth: () => void;
  onOpenTimeline: () => void;
}

export default memo(function CenterStage({ nowPlaying, trackStartedAt, llmTokens, feed, djLineOn, boothBuddyOn, offline, upNext, lyricsShown = false, lyrics = null, onOpenBooth, onOpenTimeline }: CenterStageProps) {
  const client = useStationClient();
  // The 1s elapsed tick lives here, in the component that displays it, so it
  // only re-renders this subtree — not the whole player (see useElapsed).
  const elapsed = useElapsed(trackStartedAt);
  const has = !!nowPlaying?.title;
  // Everything the stage shows about "now" gates on `live`, so an outage reads
  // as off-air instead of a frozen now-playing.
  const live = has && !offline;
  const metaTokens = buildMetaTokens(nowPlaying);
  const moodPhrase = buildMoodPhrase(nowPlaying);
  const hasMeta = metaTokens.length > 0 || moodPhrase.length > 0;
  const duration = nowPlaying?.duration ?? 0;
  const subsonicId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = subsonicId ? client.coverUrl(subsonicId) : null;
  const showArt = !!coverSrc && !offline;
  // Title key keeps placeholder + real titles in the same AnimatePresence so
  // the first-track-arrives transition cross-dissolves the "scanning" line out.
  const titleKey = offline ? 'offline' : has ? `t:${nowPlaying?.title}` : 'placeholder';

  // Persisted, and hydrated in an effect to avoid an SSR mismatch.
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

  // djLineOn is a listener preference for the ticker, not a "talking now" flag,
  // so it can't gate the ripple. SessionTurn.t is ISO from one path and unix-ms
  // from another; it's only ever a useEffect dep (Object.is change detection),
  // so any stable identifier works.
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

  // The lyrics settings hang under the track info, outside the title's swap,
  // so a new track leaves them open rather than remounting them.
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const lyricsButtonRef = useRef<HTMLButtonElement | null>(null);
  const lyricsPopoverRef = useRef<HTMLDivElement | null>(null);
  const closeLyrics = useCallback(() => setLyricsOpen(false), []);
  const toggleLyricsOpen = useCallback(() => setLyricsOpen((open) => !open), []);
  usePopoverDismiss(lyricsOpen, closeLyrics, lyricsPopoverRef, lyricsButtonRef);

  // The hover-glitch ghosts (globals.css `.v3-cover-*`) paint from `--cover`.
  // useDynamicStyle keeps this off the lint-forbidden `style` prop.
  const coverRef = useRef<HTMLButtonElement>(null);
  useDynamicStyle(coverRef, { '--cover': showArt ? `url("${coverSrc}")` : null });

  return (
    // A bounded region rather than a viewport-centred block: centred in the
    // viewport it grew downward freely and a long DJ line spilled over the
    // bottom-pinned Waveform (issue #576). The bottom reserve tracks whichever
    // waveform shape that breakpoint renders. Short/wide windows bottom-align
    // so long DJ lines grow upward, never over the band. The right reserve
    // tracks the DotRail width (slimmed on phones, see DotRail's <sm sizing).
    // While lyrics show (AmbientLyrics), lg and up splits the stage: the
    // track info stacks in a 360px column on the left, ruled off from the
    // lyrics beside it, and keeps only the cover, the title and the artist
    // line. Narrower screens add --lyrics-band to the bottom reserve for the
    // band above the waveform. That band is left out on a short screen below
    // lg, so the reserve is too.
    // A phone (below sm, tall enough for the lyrics) had no room for the band:
    // the cover stacked over a two-line title, the tags and the DJ line ran
    // out of the stage, up under the top bar and down into the lyrics. There
    // the stage shrinks to one row under the top bar, a 64px cover beside a
    // one-line title and the artist, and drops what lg drops. AmbientLyrics
    // starts the lyrics at a fixed 152px below it, so the row stays ~65px.
    <div
      className={cn(
        'absolute top-[72px] right-[80px] bottom-[calc(220px+var(--lyrics-band,0px))] left-4 flex flex-col items-start justify-center sm:right-24 sm:left-8 [@media(min-width:640px)_and_(max-height:759px)]:bottom-[calc(212px+var(--lyrics-band,0px))] [@media(min-width:640px)_and_(max-height:759px)]:justify-end [@media(min-width:640px)_and_(min-height:760px)]:bottom-[calc(300px+var(--lyrics-band,0px))]',
        lyricsShown && '[--lyrics-band:132px] lg:[--lyrics-band:0px] [@media(max-width:1023px)_and_(max-height:699px)]:[--lyrics-band:0px]',
        // The column's rule runs up to the top bar's (49px at lg).
        lyricsShown && 'lg:top-[49px] lg:right-auto lg:left-0 lg:w-[360px] lg:border-r lg:border-separator-strong lg:px-8',
        lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:bottom-auto',
      )}
    >
      {/* Above the stage's lyrics (z-[1]), which the lyrics settings can
          overlap on a narrow screen. */}
      <div
        className={cn(
          'relative isolate z-[2] flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-6',
          lyricsShown && 'lg:flex-col lg:items-start lg:gap-5',
          // Full width, so the one-line title truncates rather than widening the row.
          lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:w-full [@media(max-width:639px)_and_(min-height:700px)]:flex-row [@media(max-width:639px)_and_(min-height:700px)]:items-center',
        )}
      >
        {/* Reserve the artwork slot even without a cover to prevent layout shifts. */}
        <button
          ref={coverRef}
          type="button"
          onClick={onOpenTimeline}
          aria-label="Open the timeline"
          className={cn(
            // Sized to width but capped by viewport height (20vh) so a
            // short/wide window doesn't spend a third of its height on the
            // cover. The 96px floor is what phones get: 14vw is only ~55px on a
            // 390px screen, too small a target for the tap-to-timeline.
            'v3-cover-frame v3-focus relative h-[clamp(96px,min(14vw,20vh),240px)] w-[clamp(96px,min(14vw,20vh),240px)] shrink-0 appearance-none border-0 bg-transparent p-0',
            lyricsShown && 'lg:h-[min(200px,24vh)] lg:w-[min(200px,24vh)] [@media(max-width:639px)_and_(min-height:700px)]:size-16',
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
          <div className="v3-cover-glitch relative h-full w-full overflow-hidden rounded-sm border border-line">
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
        {/* Static in the phone view, so the lyrics settings hang from the
            whole row rather than from beside the cover. */}
        <div className={cn('relative min-w-0', lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:static')}>
          <div className={cn('v3-caption mb-[14px] text-muted', lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:mb-1 [@media(max-width:639px)_and_(min-height:700px)]:truncate')}>
            {offline ? (
              'Off air'
            ) : (
              <>
                {/* The phone view's row is plainly the track on air, and the
                    label would push the clock off a narrow phone. */}
                <span className={cn(lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:hidden')}>
                  Now playing{live ? ' — ' : ''}
                </span>
                {live && duration > 0 ? (
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
                ) : live ? fmtTime(elapsed) : ''}
                {llmTokens != null && (
                  <span className={cn(lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:hidden')}>
                    {' · '}
                    <span
                      className="inline-flex items-center gap-1 align-middle text-ink-faint"
                      title="LLM tokens generated since the station booted"
                      aria-label={`${llmTokens.toLocaleString('en-US')} AI tokens generated`}
                    >
                      <Coins size={12} strokeWidth={1.75} aria-hidden="true" />
                      <CountUp value={llmTokens} className="v3-tab-num" />
                    </span>
                  </span>
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
                  <h1
                    className={cn(
                      'v3-title m-0 line-clamp-2 text-ink',
                      // .v3-title is unlayered, so its size yields only to !,
                      // and its text-wrap to a nowrap that is !, too.
                      lyricsShown && 'lg:text-[clamp(30px,3vw,46px)]!',
                      lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:block [@media(max-width:639px)_and_(min-height:700px)]:truncate! [@media(max-width:639px)_and_(min-height:700px)]:text-[20px]! [@media(max-width:639px)_and_(min-height:700px)]:leading-[1.2]!',
                    )}
                    title={nowPlaying?.title}
                  >
                    {nowPlaying?.title}
                  </h1>
                  {/* One line in the phone view: the artist truncates so the
                      heart and the lyrics button stay on it. */}
                  <div
                    className={cn(
                      'mt-[4px] text-[clamp(13px,1.4vw,18px)] leading-snug font-medium text-muted',
                      lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:flex [@media(max-width:639px)_and_(min-height:700px)]:items-center',
                    )}
                  >
                    <span className={cn('text-ink', lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:min-w-0 [@media(max-width:639px)_and_(min-height:700px)]:truncate')}>
                      {nowPlaying?.artist || 'Unknown artist'}
                    </span>
                    {nowPlaying?.album && <span className={cn(lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:hidden')}> · {nowPlaying.album}</span>}
                    {nowPlaying?.year && <span className={cn(lyricsShown && '[@media(max-width:639px)_and_(min-height:700px)]:hidden')}> · {nowPlaying.year}</span>}
                    <LikeHeart />
                    {lyrics && (
                      <LyricsButton
                        shown={lyrics.shown}
                        open={lyricsOpen}
                        onOpen={toggleLyricsOpen}
                        buttonRef={lyricsButtonRef}
                      />
                    )}
                  </div>
                  {hasMeta && (
                    <div className={cn('v3-caption mt-[10px] text-muted', lyricsShown && 'lg:hidden [@media(max-width:639px)_and_(min-height:700px)]:hidden')}>
                      {metaTokens.join(SEP)}
                      {moodPhrase && (
                        <span className="text-accent-2">
                          {metaTokens.length > 0 ? SEP : ''}↳ {moodPhrase}
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
          {lyrics && lyricsOpen && live && (
            <div
              ref={lyricsPopoverRef}
              role="dialog"
              aria-label="Lyrics settings"
              // Short of the DotRail (80px on a phone), which draws above it.
              className="absolute top-full left-0 z-10 mt-3 w-[min(340px,calc(100vw-6rem))] border border-line bg-bg p-3 shadow-lg"
            >
              <LyricsSettings shown={lyrics.shown} onToggle={lyrics.onToggle} track={lyrics.track} />
            </div>
          )}
        </div>
      </div>

      {live && (
        <DjThinkingLine
          feed={feed}
          enabled={djLineOn}
          currentTrackId={subsonicId}
          buddyOn={boothBuddyOn}
          onOpenBooth={onOpenBooth}
          className={cn(lyricsShown && 'lg:hidden [@media(max-width:639px)_and_(min-height:700px)]:hidden')}
        />
      )}

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
            className={cn(
              'v3-caption v3-focus mt-[10px] max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-muted',
              lyricsShown && 'lg:hidden [@media(max-width:639px)_and_(min-height:700px)]:hidden',
            )}
          >
            <span className="text-accent-2">↦ up next</span>
            {' · '}
            <span className="text-ink">{upNext.title}</span>
            {upNext.artist ? ` — ${upNext.artist}` : ''}
          </m.button>
        )}
      </AnimatePresence>
    </div>
  );
});
