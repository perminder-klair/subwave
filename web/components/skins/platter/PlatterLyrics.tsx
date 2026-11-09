'use client';

// Platter's lyrics, in focus mode only: the corner the drawing leaves empty
// holds the song's lines as spokes of one wheel, turning about a point off to
// the right, where the deck is. The line being sung lies level; the ones just
// sung fan up and away above it, the ones coming wait below, each fainter the
// further round it is. A new line turns the whole wheel one notch.
//
// Every line keeps its own element from the notch it enters at (invisible) to
// the one it leaves at, so a change is only ever a transition of transform and
// opacity: nothing mounts into view, and there is no filter (depth is opacity
// alone, where a blur per line cost iPad Safari a repaint each). Under lite
// mode or reduced motion the wheel steps and a whole line lights at once.
// Untimed lyrics take the same corner as a column to scroll by hand: with no
// timing there is nothing to turn. The lines carry no controls; the header's
// lyrics button opens their settings (LyricsSettings).

import { memo } from 'react';
import { cn } from '@/lib/cn';
import {
  activeLyricLineIndex,
  lyricMoment,
  plainLyricsReady,
  syncedLyricsReady,
  useLyricClock,
  type TrackLyrics,
} from '../lyrics';
import { useSkinCalm } from '../sharedHooks';
import styles from './Platter.module.css';

const TICK_MS = 250;
/** Lines kept either side of the anchor; the outermost is the invisible notch
 *  a line enters and leaves through. */
const REACH = 3;
/** One class per notch, -REACH (longest sung) to +REACH (furthest ahead). */
const NOTCH = [
  styles.spokeM3, styles.spokeM2, styles.spokeM1, styles.spoke0, styles.spokeP1, styles.spokeP2, styles.spokeP3,
];

/** The corner the caption also uses, so the two never show together
 *  (PlatterSkin gives the DJ the floor). The wheel's lower spokes tilt along
 *  the plinth's edge and so can run wider than the untimed column, a plain
 *  box that has to stop short of the plinth's corner. */
const CORNER = 'absolute top-14 left-8';
const WHEEL = 'w-[min(34%,440px)] aspect-[11/10]';
const COLUMN = 'w-[min(26%,340px)] aspect-square';

function Words({ text, lit }: { text: string; lit: number }) {
  const parts: Array<{ part: string; index: number }> = [];
  let words = 0;
  for (const part of text.split(/(\s+)/)) parts.push({ part, index: part.trim() ? words++ : -1 });
  return (
    <>
      {parts.map(({ part, index }, i) =>
        index < 0 ? part : (
          <span key={i} className={cn(styles.word, index < lit && styles.wordLit)}>{part}</span>
        ),
      )}
    </>
  );
}

export interface PlatterLyricsProps {
  /** The skin's one answer for this track (useTrackLyrics). */
  track: TrackLyrics;
  trackStartedAt: number | null;
}

export default memo(function PlatterLyrics({ track, trackStartedAt }: PlatterLyricsProps) {
  const calm = useSkinCalm();
  const positionMs = useLyricClock(track, trackStartedAt, TICK_MS);
  const { lyrics } = track;
  if (!lyrics) return null;

  if (plainLyricsReady(track)) {
    return (
      <section aria-label="Lyrics" className={cn(CORNER, COLUMN)}>
        {/* Keyed by track, so a new song starts at its top. */}
        <div
          key={lyrics.songId}
          tabIndex={0}
          className={cn(
            'v3-focus h-full overflow-y-auto overscroll-contain font-display text-[clamp(15px,1.4vw,19px)] leading-[1.5] italic',
            styles.plainLyrics,
          )}
        >
          {lyrics.lines.map((line, i) =>
            line.text.trim()
              ? <p key={i} className="m-0 opacity-75">{line.text}</p>
              : <div key={i} aria-hidden="true" className="h-[0.9em]" />,
          )}
        </div>
      </section>
    );
  }
  if (!syncedLyricsReady(track)) return null;

  // The wheel is anchored on the last line to have started, sung or not, so
  // it holds still through a break instead of emptying; only a line the
  // moment calls current is inked in full. The clock already carries both
  // corrections, so the anchor asks with none.
  const moment = lyricMoment(lyrics, positionMs);
  const anchor = activeLyricLineIndex(lyrics, positionMs, 0);
  const spokes: Array<{ index: number; text: string; notch: number }> = [];
  for (let notch = -REACH; notch <= REACH; notch++) {
    const index = anchor + notch;
    const text = lyrics.lines[index]?.text.trim();
    if (text) spokes.push({ index, text, notch });
  }

  return (
    <section
      aria-label="Lyrics"
      className={cn(CORNER, WHEEL, 'pointer-events-none font-display text-[clamp(18px,1.9vw,27px)] italic', !calm && styles.wheelTurns)}
    >
      {spokes.map(({ index, text, notch }) => {
        const sung = index === moment.current;
        const words = text.split(/\s+/).length;
        return (
          <p
            key={`${lyrics.songId}:${index}`}
            // Only the sung line is read out; its neighbours are scenery.
            aria-hidden={!sung}
            className={cn(
              'absolute inset-x-0 top-1/2 m-0 leading-[1.14] font-extrabold',
              styles.spoke,
              NOTCH[notch + REACH],
              sung ? cn('line-clamp-2 text-balance', styles.spokeSung) : 'truncate',
            )}
          >
            {sung
              ? <Words text={text} lit={calm ? words : Math.max(1, Math.ceil(moment.progress * words))} />
              : text}
          </p>
        );
      })}
    </section>
  );
});
