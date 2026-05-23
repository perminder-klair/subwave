'use client';

import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';

interface MotionProviderProps {
  children: ReactNode;
}

// Single root motion provider for the whole app.
//
// LazyMotion + domAnimation keeps the bundle to ~12 kB gzip vs ~30 kB for the
// full motion features. `strict` forbids the non-lazy <motion.div> import so
// nobody accidentally pulls in the full bundle later — use <m.div> instead.
//
// reducedMotion="user" honors the OS preference for every motion component
// without per-component code. The default transition mirrors the cubic-bezier
// already used by the V3 CSS keyframes (v3-slide-in-right, v3-modal-pop) so
// motion-driven transitions feel like the same family.
export default function MotionProvider({ children }: MotionProviderProps) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig
        reducedMotion="user"
        transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
