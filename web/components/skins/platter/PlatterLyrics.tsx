'use client';

// Platter's lyrics, in focus mode only: while a track has them the deck moves
// over (PlatterSkin, told through onPresenceChange) and the stage's left third
// holds the song's lines as spokes of one wheel, turning about a point off to
// the right, where the record is. The line being sung lies level, beside the
// record; the ones just sung fan up and away above it, the ones coming wait
// below, each fainter the further round it is. A new line turns the whole
// wheel one notch.
//
// Every line keeps its own element from the notch it enters at (invisible) to
// the one it leaves at, so a change is only ever a transition of transform and
// opacity: nothing mounts into view, and there is no filter (depth is opacity
// alone, where a blur per line cost iPad Safari a repaint each). Under lite
// mode or reduced motion the wheel steps and a whole line lights at once.
// Untimed lyrics take the same third as a column to scroll by hand: with no
// timing there is nothing to turn. The lines carry no controls; the header's
// lyrics button opens their settings (LyricsSettings).

import { memo, useEffect } from 'react';
import { cn } from '@/lib/cn';
import {
  activeLyricLineIndex,
  lyricMoment,
  plainLyricsReady,
  syncedLyricsReady,
  useLingeringPresence,
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

/** The stage's left third, which the deck gives up while lyrics are present
 *  (PlatterSkin starts the deck's stage at the same 33%). */
const THIRD = 'absolute left-8 w-[calc(33%-3.5rem)]';

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
  /** Whether lyrics are showing, so the stage can move the deck over. */
  onPresenceChange: (shown: boolean) => void;
}

export default memo(function PlatterLyrics({ track, trackStartedAt, onPresenceChange }: PlatterLyricsProps) {
  const calm = useSkinCalm();
  const positionMs = useLyricClock(track, trackStartedAt, TICK_MS);
  const { lyrics } = track;

  // Held a moment past the last line, so two tracks that both have lyrics
  // don't slide the deck out and back while the new lines load.
  const synced = syncedLyricsReady(track);
  const plain = plainLyricsReady(track);
  const present = useLingeringPresence(synced || plain);
  useEffect(() => {
    onPresenceChange(present);
  }, [present, onPresenceChange]);
  useEffect(() => () => onPresenceChange(false), [onPresenceChange]);

  if (!lyrics) return null;

  if (plain) {
    return (
      <section aria-label="Lyrics" className={cn(THIRD, 'top-20 bottom-36')}>
        {/* Keyed by track, so a new song starts at its top. */}
        <div
          key={lyrics.songId}
          tabIndex={0}
          className={cn(
            'v3-focus h-full overflow-y-auto overscroll-contain font-display text-[clamp(16px,1.6vw,22px)] leading-[1.5] italic',
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
  if (!synced) return null;

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
      // A hub line, not a box: the spokes hang off its middle, level with the
      // record.
      className={cn(THIRD, 'pointer-events-none top-[47%] h-0 font-display text-[clamp(21px,2.4vw,38px)] italic', !calm && styles.wheelTurns)}
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
              sung ? cn('line-clamp-3 text-balance', styles.spokeSung) : 'truncate',
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
