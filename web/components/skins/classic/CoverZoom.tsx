'use client';

// The classic skin's enlarged cover: a press on the stage's cover grows it out
// of the thumbnail into a large cover centred over the player, with the title
// and artist under it; a press anywhere, or Escape, shrinks it back. The
// decisions live in coverZoom.ts.
//
// - It renders inside the skin, not in a portal, so the station gate's
//   `inert` wrapper covers it like the rest of the skin (web/CLAUDE.md). Its
//   z-index sits above the top bar (30) and below the tune-in overlay (50).
// - The motion is the Web Animations API on two elements: the large cover is
//   laid out at its final place and animated from the transform that puts it
//   over the thumbnail (`zoomFrom`), the backdrop fades. No `style` prop, which
//   the lint forbids. Under prefers-reduced-motion it only fades.
// - The cover is the same /cover proxy URL the thumbnail shows (512 px), so
//   the large one is already in the browser's cache and caps at 512 px to stay
//   sharp. A new track while it is open swaps the image in place.
// - Focus moves to the close target on open and back to the thumbnail after.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { zoomFrom, zoomTransform } from './coverZoom';

export interface CoverZoomProps {
  src: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  /** The thumbnail it grows out of and shrinks back into; focus returns to it. */
  origin: HTMLElement | null;
  /** Called once the closing animation has finished. */
  onClosed: () => void;
}

const OPEN_MS = 340;
const CLOSE_MS = 260;
const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

function reducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function CoverZoom({ src, title, artist, album, origin, onClosed }: CoverZoomProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const cover = coverRef.current;
    if (!backdrop || !cover || typeof cover.animate !== 'function') return;
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS * 0.8, easing: 'ease-out' });
    const from = reducedMotion() ? null : zoomFrom(origin?.getBoundingClientRect(), cover.getBoundingClientRect());
    cover.animate(
      from
        ? [{ transform: zoomTransform(from), opacity: 0.6 }, { transform: 'none', opacity: 1 }]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: from ? OPEN_MS : OPEN_MS * 0.7, easing: EASE },
    );
    closeRef.current?.focus({ preventScroll: true });
  }, [origin]);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const backdrop = backdropRef.current;
    const cover = coverRef.current;
    const done = () => {
      onClosed();
      origin?.focus({ preventScroll: true });
    };
    if (!backdrop || !cover || typeof cover.animate !== 'function') { done(); return; }
    // Measured now, not at open: the stage can have moved (lyrics, resize).
    const to = reducedMotion() ? null : zoomFrom(origin?.getBoundingClientRect(), cover.getBoundingClientRect());
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS, easing: 'ease-in', fill: 'forwards' });
    const anim = cover.animate(
      to
        ? [{ transform: 'none', opacity: 1 }, { transform: zoomTransform(to), opacity: 0.4 }]
        : [{ opacity: 1 }, { opacity: 0 }],
      { duration: CLOSE_MS, easing: EASE, fill: 'forwards' },
    );
    anim.onfinish = done;
    anim.oncancel = done;
  }, [onClosed, origin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const byline = [artist, album].filter(Boolean).join(' · ');
  const label = title ? `Cover of ${title}` : 'Album cover';

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={close}
      className="absolute inset-0 z-[45] flex cursor-zoom-out flex-col items-center justify-center gap-5 bg-[color-mix(in_oklab,var(--bg)_74%,transparent)] px-6 pt-[72px] pb-10 backdrop-blur-md"
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close the cover"
        onClick={(e) => { e.stopPropagation(); close(); }}
        className="v3-focus relative cursor-zoom-out appearance-none border-0 bg-transparent p-0"
      >
        {/* The animated box is what grows from and shrinks back into the
            thumbnail. */}
        <div ref={coverRef} className="relative">
          <div className="relative size-[min(78vmin,512px,calc(100dvh-220px))] min-h-[160px] min-w-[160px] overflow-hidden rounded-sm border border-ink bg-[var(--bg)] shadow-[0_28px_90px_-24px_color-mix(in_oklab,var(--ink)_55%,transparent)]">
            <span className="v3-cover-placeholder" aria-hidden="true" />
            {!broken && (
              <img
                key={src}
                src={src}
                alt=""
                className="absolute inset-0 h-full w-full animate-[v3-fade-in_220ms_ease-out] object-cover"
                onError={() => setBroken(true)}
              />
            )}
          </div>
        </div>
      </button>
      {(title || byline) && (
        <div className="max-w-[min(78vmin,512px)] text-center">
          {title && <p className="v3-title m-0 line-clamp-2 text-[clamp(18px,2.4vw,26px)]! text-ink">{title}</p>}
          {byline && <p className="v3-caption m-0 mt-2 truncate text-muted">{byline}</p>}
        </div>
      )}
    </div>
  );
}
