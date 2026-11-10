'use client';

import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';

interface MotionProviderProps {
  children: ReactNode;
}

// Use m.* with LazyMotion to keep the full motion bundle out. Reduced motion follows the OS preference.
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
