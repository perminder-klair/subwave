'use client';

import { useEffect, useRef, useState } from 'react';
import { animate } from 'motion/react';

interface CountUpProps {
  value: number;
  className?: string;
}

// Honour reduced-motion at call time (a mid-session setting change is respected)
// — matches the pattern in TransportBar.
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// A number that smoothly climbs from its previous value to the next, rendered
// with thousands separators (en-US, fixed so it doesn't drift with the
// browser locale). Unlike OdometerNumber (a whole-value digit swap), this
// tweens through the in-between integers — the right feel for a large, slowly
// rising counter like the LLM token total polled every ~5s.
export default function CountUp({ value, className }: CountUpProps) {
  const [display, setDisplay] = useState(value);
  // Seed with the first value so mount snaps to it rather than sweeping 0 → N.
  const prevRef = useRef(value);

  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = value;
    if (from === value) return;
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    const controls = animate(from, value, {
      duration: 0.9,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value]);

  return (
    <span className={className} aria-live="polite">
      {display.toLocaleString('en-US')}
    </span>
  );
}
