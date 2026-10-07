'use client';

import type { ReactNode } from 'react';
import { m } from 'motion/react';

interface EditorialRevealProps {
  children: ReactNode;
  className?: string;
}

export default function EditorialReveal({
  children,
  className,
}: EditorialRevealProps) {
  return (
    <m.section
      className={className}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.36, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {children}
    </m.section>
  );
}
