'use client';

// The Classic skin's lyrics: big, bold, and in the background of the stage
// rather than in a drawer. Wide screens give them the right of the stage, the
// track info keeping the left (CenterStage narrows while they show); narrower
// screens give them a band above the waveform.
//
// Only synced lyrics show here. A line drifts up into place and the next one
// waits faintly beneath it; within a line the words light up as they are sung,
// the newest in the accent, paced from the line's own timing (LRC times lines,
// not words, so lyricMoment() spreads the words across the line). Intros and
// instrumental breaks rest on a breathing ellipsis. Motion is opacity and
// transform only, the iPad Safari budget, and under reduced motion or lite
// mode lines simply swap and whole lines light at once. The stage carries no
// controls: the lyrics button beside the heart opens their settings, and an
// untimed song's words are there to read (LyricsSettings).

import { memo, useEffect } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { cn } from '@/lib/cn';
import { useSkinCalm } from '@/components/skins/sharedHooks';
import {
  lyricMoment,
  syncedLyricsReady,
  useLingeringPresence,
  useLyricClock,
  type TrackLyrics,
} from '@/components/skins/lyrics';

// Four steps a second is enough for word-by-word lighting; the drawer's 500ms
// left a word lit late by up to half a second.
const TICK_MS = 250;

const EASE = [0.2, 0.7, 0.2, 1] as const;

export interface AmbientLyricsProps {
  /** The skin's one answer for this track (useTrackLyrics). */
  track: TrackLyrics;
  trackStartedAt: number | null;
  /** Called with whether lyrics are showing, so the stage can make room. */
  onPresenceChange: (shown: boolean) => void;
}

function Words({ text, lit, front }: { text: string; lit: number; front: boolean }) {
  // Split on spaces but keep them, so wrapping and balance see the real text;
  // each word part carries its place among the words.
  const parts: Array<{ part: string; index: number }> = [];
  let words = 0;
  for (const part of text.split(/(\s+)/)) parts.push({ part, index: part.trim() ? words++ : -1 });
  return (
    <>
      {parts.map(({ part, index }, i) => {
        if (index < 0) return part;
        const sung = index < lit;
        const newest = front && index === lit - 1;
        return (
          <span
            key={i}
            className={cn(
              'transition-[opacity,color] duration-300 ease-out',
              newest ? 'text-vermilion opacity-100' : sung ? 'opacity-80' : 'opacity-20',
            )}
          >
            {part}
          </span>
        );
      })}
    </>
  );
}

function Breathing({ calm }: { calm: boolean }) {
  return (
    <span aria-hidden="true" className="inline-flex gap-[0.28em] opacity-30">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(!calm && 'animate-pulse', i === 1 && '[animation-delay:300ms]', i === 2 && '[animation-delay:600ms]')}
        >
          ·
        </span>
      ))}
    </span>
  );
}

export default memo(function AmbientLyrics({ track, trackStartedAt, onPresenceChange }: AmbientLyricsProps) {
  const calm = useSkinCalm();
  const positionMs = useLyricClock(track, trackStartedAt, TICK_MS);
  const { lyrics } = track;
  const songId = lyrics?.songId;

  const shown = syncedLyricsReady(track);
  // The stage keeps its room through the moment the next track's lines load.
  const present = useLingeringPresence(shown);
  useEffect(() => {
    onPresenceChange(present);
  }, [present, onPresenceChange]);
  useEffect(() => () => onPresenceChange(false), [onPresenceChange]);

  if (!shown || !lyrics) return null;

  const moment = lyricMoment(lyrics, positionMs);
  const line = moment.current >= 0 ? lyrics.lines[moment.current] : null;
  const next = moment.next >= 0 ? lyrics.lines[moment.next] : null;
  const wordCount = line ? line.text.split(/\s+/).filter(Boolean).length : 0;
  const lit = calm ? wordCount : Math.max(1, Math.ceil(moment.progress * wordCount));
  // A line leaves quickly and the next arrives just behind it, so two lines
  // barely share the stage even in the narrow band.
  const arrive = { duration: calm ? 0.2 : 0.55, delay: calm ? 0 : 0.1, ease: EASE };
  const depart = { duration: calm ? 0.15 : 0.28, ease: EASE };
  const enter = calm ? { opacity: 0 } : { opacity: 0, y: 16 };
  const settle = { opacity: 1, y: 0, transition: arrive };
  const leave = calm ? { opacity: 0, transition: depart } : { opacity: 0, y: -18, transition: depart };

  return (
    <section
      aria-label="Lyrics"
      className={cn(
        'pointer-events-none absolute z-[1] flex flex-col font-display text-ink',
        // Below lg: a band just above the waveform, the stage's own bottom
        // reserves plus a gap (CenterStage makes room with --lyrics-band).
        'right-[80px] left-4 h-[124px] justify-end text-[clamp(20px,5.2vw,30px)] sm:right-24 sm:left-8',
        'bottom-[228px] [@media(min-width:640px)_and_(max-width:1023px)]:bottom-[220px]',
        '[@media(min-width:640px)_and_(max-width:1023px)_and_(min-height:760px)]:bottom-[308px]',
        // Too short for a band: the track info needs the room more.
        '[@media(max-width:1023px)_and_(max-height:699px)]:hidden',
        // lg and up: a column right of the track info, beside the rail, the
        // lines at a fixed height so the column never moves with them.
        'lg:top-[72px] lg:right-28 lg:left-[56%] lg:h-auto lg:justify-center lg:text-[clamp(30px,3.1vw,60px)]',
        '[@media(min-width:1024px)_and_(min-height:760px)]:bottom-[300px]',
        '[@media(min-width:1024px)_and_(max-height:759px)]:bottom-[212px]',
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col justify-end lg:h-[4.8em] lg:flex-none lg:justify-start">
        <AnimatePresence mode="popLayout" initial={false}>
          {line ? (
            <m.p
              key={`${songId}:${moment.current}`}
              initial={enter}
              animate={settle}
              exit={leave}
              className="m-0 line-clamp-2 leading-[1.04] font-extrabold tracking-[-0.02em] text-balance lg:line-clamp-3"
            >
              <Words text={line.text} lit={lit} front={!calm && moment.progress < 1} />
            </m.p>
          ) : moment.resting ? (
            <m.p
              key={`${songId}:rest`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: arrive }}
              exit={{ opacity: 0, transition: depart }}
              className="m-0 leading-none font-extrabold"
            >
              <Breathing calm={calm} />
            </m.p>
          ) : null}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {next && (
            <m.p
              key={`${songId}:next:${moment.next}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.3, transition: { ...arrive, delay: calm ? 0 : 0.25 } }}
              exit={{ opacity: 0, transition: { ...depart, duration: calm ? 0.15 : 0.18 } }}
              className="m-0 mt-[0.35em] line-clamp-1 text-[0.46em] leading-tight font-bold tracking-[-0.01em] lg:line-clamp-2"
            >
              {next.text}
            </m.p>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
});
