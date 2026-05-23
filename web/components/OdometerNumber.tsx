'use client';

import { AnimatePresence, m } from 'motion/react';
import { cn } from '@/lib/cn';

interface OdometerNumberProps {
  value: number;
  className?: string;
}

// Vertically-sliding digit. New value rises in from below; old slides up and
// out. Used by the player TopBar listener count, the DotRail numeric tab
// counts, and the admin shell on-air strip — wherever a number visibly ticks
// rather than jumps. AnimatePresence keys on the value itself, so the slide
// fires on every change including from 0 → 1 and back.
export default function OdometerNumber({ value, className }: OdometerNumberProps) {
  return (
    <span className={cn('relative inline-flex items-baseline overflow-hidden', className)} aria-live="polite">
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={value}
          initial={{ y: -8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 8, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
          className="inline-block"
        >
          {value}
        </m.span>
      </AnimatePresence>
    </span>
  );
}
