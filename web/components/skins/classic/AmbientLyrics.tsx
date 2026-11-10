'use client';

// The Classic skin's lyrics: the whole song as one column of lines that glides
// so the line being sung holds the centre, larger, while the lines around it
// fade, those already sung more than those to come. From lg the stage splits:
// the track info stacks in a column on the left (CenterStage) and the lyrics
// fill the rest above the waveform. On a phone the track info shrinks to one
// row under the top bar and the lyrics fill everything below it; the widths
// in between give them a band above the waveform.
//
// Words light up as they are sung, the newest in the accent, paced from the
// line's own timing (LRC times lines, not words, so lyricMoment() spreads the
// words across the line). An intro or an instrumental break centres the line
// to come, at rest. Untimed lyrics take the same place, every line at rest,
// for the listener to scroll by hand: with no timing there is nothing to
// follow. Motion is transform and opacity only, the iPad Safari budget: the
// column glides by transform and the sung line grows by scale, so no line
// ever reflows; under reduced motion or lite mode both cut. The stage carries
// no controls: the lyrics button beside the heart opens their settings
// (LyricsSettings).

import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { m } from 'motion/react';
import { cn } from '@/lib/cn';
import { useSkinCalm } from '@/components/skins/sharedHooks';
import {
  activeLyricLineIndex,
  lyricMoment,
  plainLyricsReady,
  syncedLyricsReady,
  useLingeringPresence,
  useLyricClock,
  type TrackLyrics,
} from '@/components/skins/lyrics';
import type { PublicLyricsPayload } from '@/lib/schemas.generated';

// Four steps a second is enough for word-by-word lighting.
const TICK_MS = 250;

const EASE = [0.3, 0.7, 0.2, 1] as const;

// How much larger the sung line is than the rest: half again in the lg
// column, a fifth in the band below lg, where a long line wrapping narrow
// would grow past its neighbours. Every line wraps at 1/GROW of the column
// (LINE_WIDTH), so the sung one, scaled from its left edge, still fits.
const GROW_WIDE = 1.5;
const GROW_BAND = 1.2;
const LINE_WIDTH = 'w-5/6 lg:w-2/3';

const WIDE = '(min-width: 1024px)';
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
/** lg and up, where the lyrics have a column rather than a band. */
function useWideStage(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);
}

// Where the lyrics sit. Below lg: a band just above the waveform, the stage's
// own bottom reserves plus a gap (CenterStage makes room with --lyrics-band),
// left out on a screen too short for it, where the track info needs the room
// more. On a phone (below sm) they run from just under CenterStage's one-row
// header (72px down, ~65px tall) to the same bottom: the room that header
// frees by shrinking the cover and dropping the tags and the DJ line. lg and
// up: right of the track info's column (CenterStage's 360px), beside the
// rail, above the waveform.
const PLACE = cn(
  'absolute z-[1] font-display text-ink',
  'right-[80px] left-4 h-[124px] sm:right-24 sm:left-8',
  'bottom-[228px] [@media(min-width:640px)_and_(max-width:1023px)]:bottom-[220px]',
  '[@media(min-width:640px)_and_(max-width:1023px)_and_(min-height:760px)]:bottom-[308px]',
  '[@media(max-width:1023px)_and_(max-height:699px)]:hidden',
  '[@media(max-width:639px)_and_(min-height:700px)]:top-[152px] [@media(max-width:639px)_and_(min-height:700px)]:h-auto',
  'lg:top-[72px] lg:right-28 lg:left-[360px] lg:h-auto',
  '[@media(min-width:1024px)_and_(min-height:760px)]:bottom-[300px]',
  '[@media(min-width:1024px)_and_(max-height:759px)]:bottom-[212px]',
);

// The column fades out top and bottom, so lines dissolve into the stage rather
// than cut off at its edge. A mask, not an overlay: the stage behind is a
// gradient no overlay colour would match.
const FADE = '[mask-image:linear-gradient(transparent,#000_22%,#000_78%,transparent)]';

const LINE = cn(
  'm-0 leading-[1.05] font-extrabold tracking-[-0.01em] text-balance',
  'text-[clamp(15px,3.8vw,19px)] lg:text-[clamp(18px,1.5vw,24px)]',
);
// Synced lines stand apart, one moment each; untimed ones sit closer, read
// as a page.
const SYNCED_GAP = 'py-[0.4em] lg:py-[1.15em]';
const PLAIN_GAP = 'py-[0.2em] lg:py-[0.35em]';

// Lines already sung fade further than those to come.
const PAST = 0.28;
const AHEAD = 0.45;

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
        const newest = front && index === lit - 1;
        return (
          <span
            key={i}
            className={cn(
              'transition-[opacity,color] duration-200 ease-out',
              newest ? 'text-vermilion' : index < lit ? 'opacity-100' : 'opacity-[0.38]',
            )}
          >
            {part}
          </span>
        );
      })}
    </>
  );
}

type Tone = 'past' | 'sung' | 'ahead';

/** One line of the column. Memoized: on each tick only the sung line changes. */
const Line = memo(function Line({ text, tone, lit, front, calm, grow }: {
  text: string;
  tone: Tone;
  lit: number;
  front: boolean;
  calm: boolean;
  grow: number;
}) {
  return (
    <m.p
      initial={false}
      animate={{ scale: tone === 'sung' ? grow : 1, opacity: tone === 'past' ? PAST : tone === 'ahead' ? AHEAD : 1 }}
      transition={calm ? { duration: 0 } : { duration: 0.5, ease: EASE }}
      className={cn(LINE, SYNCED_GAP, LINE_WIDTH, 'origin-left')}
    >
      {tone === 'sung' ? <Words text={text} lit={lit} front={front} /> : text}
    </m.p>
  );
});

/** Synced lyrics: the column glides to keep the line in focus at its centre. */
function SyncedColumn({ lyrics, positionMs, calm }: { lyrics: PublicLyricsPayload; positionMs: number; calm: boolean }) {
  const { lines } = lyrics;
  const moment = lyricMoment(lyrics, positionMs);
  // At the centre: the line being sung; in an intro or a break, the one to
  // come; after the last, the last.
  const started = activeLyricLineIndex(lyrics, positionMs, 0);
  const focus = moment.current >= 0 ? moment.current : Math.min(lines.length - 1, started + 1);
  const sung = moment.current >= 0 ? lines[moment.current] : null;
  const wordCount = sung ? sung.text.split(/\s+/).filter(Boolean).length : 0;
  const lit = calm ? wordCount : Math.max(1, Math.ceil(moment.progress * wordCount));
  const grow = useWideStage() ? GROW_WIDE : GROW_BAND;

  // Each line's centre within the column, measured, so a line of any length
  // can take the centre. Scale never changes layout, so this holds until the
  // column's width or the lines change.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [centres, setCentres] = useState<number[]>([]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setCentres(Array.from(list.children, (child) => {
      const row = child as HTMLElement;
      return row.offsetTop + row.offsetHeight / 2;
    }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [lines]);
  // The first placement is a cut, not a glide in from the top: gliding starts
  // the frame after the column is measured.
  const measured = centres.length > 0;
  const [gliding, setGliding] = useState(false);
  useEffect(() => {
    if (!measured) return;
    const frame = requestAnimationFrame(() => setGliding(true));
    return () => cancelAnimationFrame(frame);
  }, [measured]);

  return (
    <div className={cn('relative h-full overflow-hidden', FADE)}>
      <m.div
        ref={listRef}
        initial={false}
        animate={{ y: -(centres[focus] ?? 0) }}
        transition={gliding && !calm ? { duration: 0.6, ease: EASE } : { duration: 0 }}
        className="absolute inset-x-0 top-1/2 lg:pr-10 lg:pl-11"
      >
        {lines.map((line, i) => {
          const tone: Tone = i === moment.current ? 'sung' : i < focus ? 'past' : 'ahead';
          return (
            <Line
              key={i}
              text={line.text}
              tone={tone}
              lit={tone === 'sung' ? lit : 0}
              front={tone === 'sung' && !calm && moment.progress < 1}
              calm={calm}
              grow={grow}
            />
          );
        })}
      </m.div>
    </div>
  );
}

/** Untimed lyrics: every line, closer set and readable, to scroll by hand. */
function PlainColumn({ lines }: { lines: Array<{ text: string }> }) {
  return (
    <div
      tabIndex={0}
      className={cn(
        'v3-focus pointer-events-auto h-full overflow-y-auto overscroll-contain lg:pr-10 lg:pl-11',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        FADE,
      )}
    >
      {/* Room to scroll the first and last lines clear of the fades. */}
      <div aria-hidden="true" className="h-[22%]" />
      {lines.map((line, i) =>
        line.text.trim()
          ? <p key={i} className={cn(LINE, PLAIN_GAP, 'opacity-70')}>{line.text}</p>
          : <div key={i} aria-hidden="true" className="h-[0.8em]" />,
      )}
      <div aria-hidden="true" className="h-[22%]" />
    </div>
  );
}

export interface AmbientLyricsProps {
  /** The skin's one answer for this track (useTrackLyrics). */
  track: TrackLyrics;
  trackStartedAt: number | null;
  /** Called with whether lyrics are showing, so the stage can make room. */
  onPresenceChange: (shown: boolean) => void;
}

export default memo(function AmbientLyrics({ track, trackStartedAt, onPresenceChange }: AmbientLyricsProps) {
  const calm = useSkinCalm();
  const positionMs = useLyricClock(track, trackStartedAt, TICK_MS);
  const { lyrics } = track;

  const synced = syncedLyricsReady(track);
  const shown = synced || plainLyricsReady(track);
  // The stage keeps its room through the moment the next track's lines load.
  const present = useLingeringPresence(shown);
  useEffect(() => {
    onPresenceChange(present);
  }, [present, onPresenceChange]);
  useEffect(() => () => onPresenceChange(false), [onPresenceChange]);

  if (!shown || !lyrics) return null;

  return (
    <section aria-label="Lyrics" className={cn(PLACE, synced && 'pointer-events-none')}>
      {/* Keyed by track: a new song fades in, placed at its own start. */}
      <m.div
        key={lyrics.songId}
        initial={calm ? false : { opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.5, ease: EASE } }}
        className="h-full"
      >
        {synced
          ? <SyncedColumn lyrics={lyrics} positionMs={positionMs} calm={calm} />
          : <PlainColumn lines={lyrics.lines} />}
      </m.div>
    </section>
  );
});
