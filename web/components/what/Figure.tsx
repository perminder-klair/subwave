'use client';

import { m } from 'motion/react';
import { cn } from '@/lib/cn';

interface FigureProps {
  src?: string;
  alt?: string;
  caption?: string;
  label?: string;
  ratio?: '16 / 10' | '9 / 16';
  /** Intrinsic pixel size of `src` — reserves the box before load (no CLS). */
  width?: number;
  height?: number;
}

// Screenshot slot for the /what feature story. While `src` is empty it renders
// a labelled placeholder box; pass `src` later and the same component swaps in
// the real image — no layout change.
//
// Mount-driven stagger: image fades first, caption fades + rises 180 ms
// behind. Mimics reading order. No scroll trigger — everything settles as the
// page loads.
export default function Figure({
  src,
  alt,
  caption,
  label,
  ratio = '16 / 10',
  width,
  height,
}: FigureProps) {
  const aspectClass = ratio === '9 / 16' ? 'aspect-[9/16]' : 'aspect-[16/10]';
  return (
    <figure className="m-0 flex flex-col gap-2">
      {src ? (
        <m.img
          src={src}
          alt={alt || caption || label || ''}
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
          className="block h-auto w-full border border-ink object-contain"
        />
      ) : (
        <m.div
          role="img"
          aria-label={alt || `Placeholder: ${label}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
          className={cn(
            'flex items-center justify-center border border-dashed border-separator-strong bg-overlay p-4 text-center',
            aspectClass,
          )}
        >
          <span className="text-[11px] font-bold tracking-[0.24em] text-muted uppercase">
            {label || 'Screenshot'}
          </span>
        </m.div>
      )}
      {caption && (
        <m.figcaption
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, delay: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
          className="text-[10px] font-medium tracking-[0.18em] text-muted uppercase"
        >
          <span className="font-bold text-vermilion">FIG.&nbsp;</span>
          {caption}
        </m.figcaption>
      )}
    </figure>
  );
}
