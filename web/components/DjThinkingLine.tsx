'use client';

import { useMemo } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { turnClass, turnText, type TurnDisplayClass } from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';

// Shows only the DJ's "thinking" — the latest thing said on-air ("voice") or
// the latest pick/request reasoning ("dj"). Aired tracks and system turns
// stay out. Renders under the track info as a small typed line; tapping it
// opens the Booth drawer with the full transcript.
const THINKING_CLASSES = new Set<TurnDisplayClass>(['voice', 'dj']);

const MARKER: Record<string, string> = { voice: '♪', dj: '◇' };

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

export interface DjThinkingLineProps {
  /** Live session messages, oldest first. */
  feed: SessionTurn[] | undefined;
  enabled: boolean;
  onOpenBooth?: () => void;
}

// `feed` is the live session's `messages` array — turns of
// { t, role, kind, text, meta }, oldest first.
export default function DjThinkingLine({ feed, enabled, onOpenBooth }: DjThinkingLineProps) {
  // The newest voice/dj turn — what the DJ is currently "thinking".
  const latest = useMemo<SessionTurn | null>(() => {
    if (!feed?.length) return null;
    for (let i = feed.length - 1; i >= 0; i--) {
      const turn = feed[i];
      if (turn && THINKING_CLASSES.has(turnClass(turn)) && turn.text) return turn;
    }
    return null;
  }, [feed]);

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
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      title="Open booth feed"
      className="v3-focus mt-[22px] mb-[10px] flex w-full max-w-[78%] cursor-pointer items-baseline gap-2 font-mono text-[12px] leading-[1.55] text-muted"
    >
      <span className="opacity-70" aria-hidden="true">
        {MARKER[cls] || '·'}
      </span>
      <span className="[overflow-wrap:anywhere]">
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
