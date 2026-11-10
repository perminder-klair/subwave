'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { EmptyArt, type EmptyArtKind } from '@/components/iso/EmptyArt';

/* Shared "nothing here yet" panel for the admin console. Copy is
   caller-supplied so panels can carry a light SUB/WAVE voice where it fits. */
export interface EmptyStateProps {
  /** Sits in a bordered square above the title. */
  icon?: ReactNode;
  /** A small isometric drawing above the title, in construction lines. A
   *  full-size panel with no icon gets the empty crate unless it names
   *  another; `false` leaves it bare. Compact panels never draw one. */
  art?: EmptyArtKind | false;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Tighter vertical padding for inline/nested empties. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  art,
  title = 'Nothing here yet',
  description,
  action,
  compact,
  className,
}: EmptyStateProps) {
  const drawing = compact || icon ? null : art === undefined ? 'crate' : art || null;
  return (
    <div
      // The one selectable hook on this panel: everything else here is utility
      // classes and caller-supplied copy, so a test has no other way to tell
      // "loaded and empty" apart from "still loading".
      data-testid="empty-state"
      className={cn(
        'flex flex-col items-center text-center',
        compact ? 'px-4 py-8' : 'px-[18px] py-11',
        className,
      )}
    >
      {drawing && <EmptyArt kind={drawing} className="mb-3 w-[150px] max-w-full" />}
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
