'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/* Shared empty state for the admin console — the "there is nothing here yet"
   panel. Newsprint editorial treatment: an optional bordered icon, a Fraunces
   display-italic headline, a quiet mono caption, and an optional call to
   action. Replaces the ~dozen bare lowercase strings ("no calls yet",
   "nothing here yet") each panel used to render, and the siloed imaging
   EmptyState (which now delegates here). Copy is caller-supplied so panels can
   carry a light SUB/WAVE voice where it fits. */
export interface EmptyStateProps {
  /** A lucide icon (or any node); sits in a bordered square above the title. */
  icon?: ReactNode;
  title?: ReactNode;
  /** Short guidance under the title — what to do to fill this space. */
  description?: ReactNode;
  /** A primary action (usually a <Btn>) rendered under the description. */
  action?: ReactNode;
  /** Tighter vertical padding for inline/nested empties (e.g. inside a modal). */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  title = 'Nothing here yet',
  description,
  action,
  compact,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center',
        compact ? 'px-4 py-8' : 'px-[18px] py-11',
        className,
      )}
    >
      {icon && (
        <div className="mb-3 flex size-10 items-center justify-center border border-separator-strong text-muted [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="font-display text-[22px] leading-tight text-muted italic">{title}</div>
      {description && (
        <div className="mt-2 max-w-[48ch] font-mono text-[11px] leading-[1.7] tracking-[0.06em] [text-wrap:pretty] text-muted">
          {description}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
