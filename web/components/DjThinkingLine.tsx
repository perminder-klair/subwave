'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { selectThinkingTurn, turnClass, turnText } from '@/lib/sessionFeed';
import BoothBuddy, { type BuddyMood } from './BoothBuddy';
import type { SessionTurn } from '@/lib/types';

// Shows only the DJ's "thinking" — the latest thing said on-air ("voice") or
// the pick/request reasoning ("dj") for the track ON AIR. Aired tracks and
// system turns stay out. Renders under the track info as a small typed line;
// tapping it opens the Booth drawer with the full transcript. The Booth Sprite
// leads the line, its mood reacting to DJ activity (see useBuddyMood).

// Booth-buddy mood loop, driven by the newest DJ turn: it perks up when the DJ
// speaks ('onair') or picks ('curious'), settles back to 'content', then dozes
// off after a long quiet stretch. A poke (tap on the buddy) interrupts with a
// 'spooked' → 'curious' → 'content' startle sequence, mirroring the prototype.
const REACTION_MS: Record<'voice' | 'dj', number> = { voice: 8000, dj: 6000 };
const SLEEPY_MS = 90000;

function useBuddyMood(latest: SessionTurn | null): [BuddyMood, () => void] {
  const [mood, setMood] = useState<BuddyMood>('content');
  // Two timer pools so a turn arriving mid-poke can't cancel the startle, and a
  // `poked` lock so the turn effect doesn't overwrite 'spooked' while it plays.
  const reactTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pokeTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const poked = useRef(false);
  const clear = (ref: typeof reactTimers) => {
    ref.current.forEach(clearTimeout);
    ref.current = [];
  };

  useEffect(() => {
    if (!latest || poked.current) return;
    const cls = turnClass(latest) === 'voice' ? 'voice' : 'dj';
    setMood(cls === 'voice' ? 'onair' : 'curious');
    clear(reactTimers);
    reactTimers.current.push(
      setTimeout(() => setMood('content'), REACTION_MS[cls]),
      setTimeout(() => setMood('sleepy'), SLEEPY_MS),
    );
  }, [latest]);

  // Clear every pending timer on unmount.
  useEffect(() => () => { clear(reactTimers); clear(pokeTimers); }, []);

  const poke = useCallback(() => {
    poked.current = true;
    clear(reactTimers);
    clear(pokeTimers);
    setMood('spooked');
    pokeTimers.current.push(
      setTimeout(() => setMood('curious'), 850),
      setTimeout(() => { poked.current = false; setMood('content'); }, 2400),
    );
  }, []);

  return [mood, poke];
}

function thinkingText(turn: SessionTurn): string {
  const cls = turnClass(turn);
  const text = turnText(turn);
  return cls === 'voice' ? `"${text}"` : text;
}

// Stagger cap: total enter time stays under ~600 ms regardless of line length.
// Each child animates ~120 ms; for a 12-char line the previous default of
// 42 ms/char gives ~12*0.042+0.12 ≈ 0.62 s. For longer lines we squeeze the
// stagger so the last char still arrives by ~0.6 s.
function staggerFor(length: number): number {
  if (length <= 0) return 0;
  return Math.min(0.042, 0.5 / length);
}

const cursorChar = '▍';

// Classic leading glyph, shown in place of the buddy when the operator has the
// mascot turned off (settings.ui.boothBuddy === false).
const MARKER: Record<string, string> = { voice: '♪', dj: '◇' };

export interface DjThinkingLineProps {
  /** Live session messages, oldest first. */
  feed: SessionTurn[] | undefined;
  enabled: boolean;
  /** Subsonic id of the track on air. A `dj`/pick turn's `meta.trackId` is the
   *  *picked* song — which, because picks run at the previous track's start, is
   *  the track to play NEXT, not the one playing now. Used to skip pick
   *  reasoning that isn't about the current track (#546). */
  currentTrackId?: string | null;
  /** Station-wide Booth Sprite toggle; falls back to the classic marker when
   *  false. Defaults off (operator opts in). */
  buddyOn?: boolean;
  onOpenBooth?: () => void;
}

// `feed` is the live session's `messages` array — turns of
// { t, role, kind, text, meta }, oldest first.
export default function DjThinkingLine({ feed, enabled, currentTrackId = null, buddyOn = false, onOpenBooth }: DjThinkingLineProps) {
  // The DJ turn relevant to what's ON AIR now — see selectThinkingTurn (#546).
  const latest = useMemo<SessionTurn | null>(
    () => selectThinkingTurn(feed, currentTrackId),
    [feed, currentTrackId],
  );

  const [mood, poke] = useBuddyMood(latest);
  // Hit-test taps against the buddy so poking it startles the sprite in place,
  // while a tap on the text still opens the Booth (a drawer would otherwise
  // cover the buddy, so you'd never see the reaction).
  const buddyRef = useRef<HTMLSpanElement>(null);

  if (!enabled || !latest) return null;

  const full = thinkingText(latest);
  const cls = turnClass(latest);
  const turnId = `${latest.t}`;
  const stagger = staggerFor(full.length);

  const open = () => onOpenBooth?.();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (buddyRef.current?.contains(e.target as Node)) {
          poke();
          return;
        }
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      title="Open booth feed"
      className="v3-focus mt-[22px] mb-[10px] flex w-full max-w-[82%] cursor-pointer items-start gap-2 font-mono text-[14px] leading-[1.6] text-muted sm:text-[15px]"
    >
      {/* The Booth Sprite leads the line; tap it to poke it (hit-test in
          onClick above). When the operator turns the mascot off, fall back to
          the classic ♪/◇ marker. */}
      {buddyOn ? (
        <span ref={buddyRef} aria-hidden="true" className="mt-[1px] shrink-0">
          <BoothBuddy mood={mood} size={20} />
        </span>
      ) : (
        <span className="shrink-0 opacity-70" aria-hidden="true">
          {MARKER[cls] || '·'}
        </span>
      )}
      {/* Clamp the inline teaser so the long "extended" scripts can't grow the
          column and shove the artwork/title up under the header, or spill the
          line down over the waveform (issue #576). The clamp is tighter on
          short windows; the full text stays one tap away in the Booth (and in
          aria-label). */}
      <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere] [@media(min-height:760px)]:line-clamp-6">
        <AnimatePresence mode="wait">
          <m.span
            key={turnId}
            variants={{
              hidden:  { opacity: 0 },
              visible: { opacity: 1, transition: { staggerChildren: stagger } },
              exit:    { opacity: 0, transition: { duration: 0.12 } },
            }}
            initial="hidden"
            animate="visible"
            exit="exit"
            aria-label={full}
          >
            {Array.from(full).map((char, i) => (
              <m.span
                key={i}
                variants={{
                  hidden:  { opacity: 0, filter: 'blur(2px)' },
                  visible: { opacity: 1, filter: 'blur(0px)', transition: { duration: 0.12 } },
                }}
                aria-hidden="true"
                // Preserve whitespace but allow soft wrapping at spaces — `pre`
                // would suppress every wrap opportunity and overflow the column.
                style={{ whiteSpace: 'pre-wrap' }}
              >
                {char}
              </m.span>
            ))}
          </m.span>
        </AnimatePresence>
        <span className="v3-blink ml-px text-vermilion" aria-hidden="true">{cursorChar}</span>
      </span>
    </div>
  );
}
