'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { selectThinkingTurn, turnClass, turnText } from '@/lib/sessionFeed';
import BoothBuddy, { type BuddyMood } from '@/components/BoothBuddy';
import { useLiteMode } from '@/hooks/useLiteMode';
import type { SessionTurn } from '@/lib/types';

// Shows only the latest thing said on-air ("voice") or the pick/request
// reasoning ("dj") for the track ON AIR; aired tracks and system turns stay
// out.

// Mood loop driven by the newest DJ turn: 'onair' when the DJ speaks,
// 'curious' on a pick, back to 'content', then 'sleepy' after a quiet stretch.
// A poke interrupts with a 'spooked' → 'curious' → 'content' startle.
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

// Total enter time stays under ~600 ms regardless of line length. Type-on is
// word-by-word, not per character, to keep the animated element count down.
function staggerFor(count: number): number {
  if (count <= 0) return 0;
  return Math.min(0.08, 0.5 / count);
}

const cursorChar = '▍';

// Shown in place of the buddy when settings.ui.boothBuddy is false.
const MARKER: Record<string, string> = { voice: '♪', dj: '◇' };

export interface DjThinkingLineProps {
  /** Live session messages, oldest first. */
  feed: SessionTurn[] | undefined;
  enabled: boolean;
  /** Subsonic id of the track on air. A pick turn's `meta.trackId` is the
   *  NEXT track (picks run at the previous track's start), so this filters
   *  out reasoning that isn't about the current track (#546). */
  currentTrackId?: string | null;
  /** Station-wide Booth Sprite toggle; falls back to the classic marker when
   *  false. Defaults off (operator opts in). */
  buddyOn?: boolean;
  onOpenBooth?: () => void;
}

export default function DjThinkingLine({ feed, enabled, currentTrackId = null, buddyOn = false, onOpenBooth }: DjThinkingLineProps) {
  // The turn relevant to what's ON AIR now — see selectThinkingTurn (#546).
  const latest = useMemo<SessionTurn | null>(
    () => selectThinkingTurn(feed, currentTrackId),
    [feed, currentTrackId],
  );

  const [mood, poke] = useBuddyMood(latest);
  // Taps are hit-tested against the buddy: a tap on the text opens the Booth,
  // whose drawer would cover the buddy and hide the poke reaction.
  const buddyRef = useRef<HTMLSpanElement>(null);

  // MotionConfig reducedMotion="user" only drops transform animations (this
  // one is opacity+blur), and html.lite's `animation: none` can't reach a
  // JS-driven tween, so both need an explicit gate here.
  const reduced = useReducedMotion();
  const { lite } = useLiteMode();
  const instant = !!reduced || lite;

  if (!enabled || !latest) return null;

  const full = thinkingText(latest);
  const cls = turnClass(latest);
  const turnId = `${latest.t}`;
  const words = full.match(/\S+\s*/g) ?? [];
  const stagger = staggerFor(words.length);

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
      // Full width on phones; the 82% cap is a desktop line-length limit.
      className="v3-focus mt-[22px] mb-[10px] flex w-full max-w-full cursor-pointer items-start gap-2 font-mono text-[14px] leading-[1.6] text-muted sm:max-w-[82%] sm:text-[15px]"
    >
      {buddyOn ? (
        <span ref={buddyRef} aria-hidden="true" className="mt-[1px] shrink-0">
          <BoothBuddy mood={mood} size={20} />
        </span>
      ) : (
        <span className="shrink-0 opacity-70" aria-hidden="true">
          {MARKER[cls] || '·'}
        </span>
      )}
      {/* Clamped so a long script can't grow the column and shove the title
          under the header, or spill down over the waveform (issue #576).
          Tighter on short windows; the full text stays in the Booth. */}
      <span className="line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere] [@media(min-height:760px)]:line-clamp-6">
        <AnimatePresence mode="wait">
          <m.span
            key={turnId}
            variants={{
              hidden:  { opacity: 0 },
              visible: { opacity: 1, transition: { staggerChildren: instant ? 0 : stagger } },
              exit:    { opacity: 0, transition: { duration: 0.12 } },
            }}
            initial="hidden"
            animate="visible"
            exit="exit"
            aria-label={instant ? undefined : full}
          >
            {instant
              ? full
              : words.map((word, i) => (
                  <m.span
                    key={i}
                    variants={{
                      hidden:  { opacity: 0, filter: 'blur(2px)' },
                      visible: { opacity: 1, filter: 'blur(0px)', transition: { duration: 0.12 } },
                    }}
                    aria-hidden="true"
                    // `pre` would suppress every wrap opportunity and overflow
                    // the column.
                    style={{ whiteSpace: 'pre-wrap' }}
                  >
                    {word}
                  </m.span>
                ))}
          </m.span>
        </AnimatePresence>
        <span className="v3-blink ml-px text-vermilion" aria-hidden="true">{cursorChar}</span>
      </span>
    </div>
  );
}
