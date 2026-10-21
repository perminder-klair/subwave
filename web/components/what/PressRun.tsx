'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  m,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from 'motion/react';
import EditorialReveal from '../landing/EditorialReveal';
import { PRESS_RUN_ROWS, type PressRunPlate } from '@/lib/press-run-plates';
import { cn } from '@/lib/cn';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

// "The Press Run" — an unnumbered full-bleed interlude between PART ONE and
// PART TWO: every skin and every built-in theme as real screenshots, drifting
// by in two counter-moving bands, slow as paper through a web press. Hover
// (or focusing a plate) winds a band down over ~600 ms instead of freezing
// it; prefers-reduced-motion swaps the drift for plain scrollable strips.

function PlateCaption({ plate }: { plate: PressRunPlate }) {
  return (
    <span className="block text-[10px] font-medium tracking-[0.18em] text-muted uppercase">
      <span className="font-bold text-vermilion">PLATE No. {plate.no}&nbsp;</span>
      · {plate.skinName} × {plate.themeName}
    </span>
  );
}

function Plate({
  plate,
  onOpen,
  ghost = false,
}: {
  plate: PressRunPlate;
  onOpen: (p: PressRunPlate) => void;
  /** Copy of the sequence beyond the first, rendered to cover wide viewports
   *  in the seamless loop — hidden from the accessibility tree and tab order
   *  so nothing is announced twice. */
  ghost?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => onOpen(plate)}
      tabIndex={ghost ? -1 : 0}
      aria-hidden={ghost || undefined}
      className="group block w-[min(360px,70vw)] shrink-0 text-left"
    >
      <span
        className={cn(
          'block aspect-[16/10] overflow-hidden border border-ink bg-overlay',
          'transition-transform duration-200',
          'group-hover:-translate-y-0.5 group-focus-visible:-translate-y-0.5',
        )}
      >
        {failed ? (
          <span className="flex h-full w-full items-center justify-center text-[11px] font-bold tracking-[0.24em] text-muted uppercase">
            Plate missing
          </span>
        ) : (
          // static public/ asset in a horizontally-moving track; next/image
          // adds nothing here (no remote loader, fixed intrinsic size) —
          // @next/next/no-img-element is off project-wide (see eslint.config.mjs).
          <img
            src={plate.src}
            alt={plate.alt}
            width={1600}
            height={1000}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="block h-full w-full object-cover"
          />
        )}
      </span>
      <span className="mt-2 block">
        <PlateCaption plate={plate} />
      </span>
    </button>
  );
}

// Memoized so opening/closing the lightbox (a setActive call in the parent)
// doesn't re-render every row — `plates`/`direction`/`durationSec` are stable
// per row and `onOpen` is a useState setter, so props are shallow-equal across
// that re-render and this component (and its useAnimationFrame subscription
// below) skips re-rendering entirely.
const MarqueeRow = memo(function MarqueeRow({
  plates,
  direction,
  durationSec,
  offsetFraction = 0,
  onOpen,
}: {
  plates: PressRunPlate[];
  direction: 'left' | 'right';
  /** Seconds for one full pass of the sequence. */
  durationSec: number;
  /** Initial phase (0–1) so the two rows' seams never align. */
  offsetFraction?: number;
  onOpen: (p: PressRunPlate) => void;
}) {
  const reduced = useReducedMotion();
  // useReducedMotion() resolves to its real value as soon as the client can
  // read matchMedia, which can be at hydration itself (not after, via an
  // effect) — branching DOM structure on `reduced` directly would then mean
  // the very first client render disagrees with the SSR markup. Gate the
  // structural switch on mount instead: render the marquee (matching SSR)
  // until an effect confirms we're past hydration, then swap to the static
  // strip for reduced-motion users.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const x = useMotionValue(0);
  // 1 = drifting, 0 = paused; the spring is the "press winding down" ease.
  const throttle = useMotionValue(1);
  const factor = useSpring(throttle, { stiffness: 40, damping: 15 });
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Width in px of ONE copy of the sequence (not the whole doubled/tripled
  // track) — the wrap-around unit for `x`.
  const seqRef = useRef(0);
  // How many copies of the sequence are rendered back to back. Starts at the
  // minimum needed for a seamless loop (2); grows to cover wide viewports so
  // the track's trailing edge never pulls inside the viewport mid-drift.
  const [copies, setCopies] = useState(2);
  const copiesRef = useRef(copies);

  useEffect(() => {
    if (reduced) return;
    const el = trackRef.current;
    if (!el) return;
    const wrapper = el.parentElement;
    const measure = () => {
      // Recompute from the copies count that actually produced this
      // scrollWidth — copiesRef may already hold a newer value written by
      // this same callback below, so measure order can't corrupt seq.
      const currentCopies = copiesRef.current;
      const seq = el.scrollWidth / currentCopies;
      if (seqRef.current === 0 && seq > 0) {
        // First measure: phase-shift the band so row seams stay unaligned.
        x.set(-seq * offsetFraction);
      }
      seqRef.current = seq;
      const wrapperWidth = wrapper?.clientWidth ?? 0;
      if (seq > 0 && wrapperWidth > 0) {
        const needed = Math.max(2, Math.ceil(wrapperWidth / seq) + 1);
        if (needed !== currentCopies) {
          copiesRef.current = needed;
          setCopies(needed);
        }
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (wrapper) ro.observe(wrapper);
    return () => ro.disconnect();
  }, [reduced, offsetFraction, x]);

  // useAnimationFrame re-subscribes (cancelFrame + frame.update) whenever this
  // callback's identity changes, so it must stay stable across unrelated
  // re-renders (e.g. the parent's lightbox state) rather than being a fresh
  // inline arrow every render.
  const tick = useCallback((_: number, delta: number) => {
    const seq = seqRef.current;
    if (reduced || seq === 0) return;
    const dir = direction === 'left' ? -1 : 1;
    const pxPerMs = seq / (durationSec * 1000);
    const next = x.get() + dir * pxPerMs * delta * factor.get();
    // Wrap into [-seq, 0) so the multi-copy track loops seamlessly either way.
    x.set(((next % seq) + seq) % seq - seq);
  }, [reduced, direction, durationSec, x, factor]);

  useAnimationFrame(tick);

  if (mounted && reduced) {
    return (
      <div className="overflow-x-auto">
        <div className="flex w-max gap-6 px-6 pb-2">
          {plates.map(p => (
            <Plate key={p.id} plate={p} onOpen={onOpen} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden"
      onPointerEnter={() => throttle.set(0)}
      onPointerLeave={() => throttle.set(1)}
      onFocus={() => throttle.set(0)}
      onBlur={() => throttle.set(1)}
    >
      <m.div ref={trackRef} className="flex w-max gap-6" style={{ x }}>
        {Array.from({ length: copies }, (_, i) => i).flatMap(i => plates.map(p => (
          <Plate
            key={i === 0 ? p.id : `${p.id}-ghost-${i}`}
            plate={p}
            onOpen={onOpen}
            ghost={i > 0}
          />
        )))}
      </m.div>
    </div>
  );
});

export default function PressRun() {
  const [active, setActive] = useState<PressRunPlate | null>(null);

  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">INTERMISSION · THE FACES</p>
      <h2>Eight faces. Eight coats of paint.</h2>
      <p className="text-muted">
        Skins are the furniture; themes are the ink. Every listener picks their
        own — the broadcast underneath is the same.
      </p>

      <div className="relative left-1/2 w-screen -translate-x-1/2">
        <div className="bs-rule-double" />
        <div className="flex flex-col gap-8 py-10">
          <MarqueeRow
            plates={PRESS_RUN_ROWS[0]}
            direction="left"
            durationSec={80}
            onOpen={setActive}
          />
          <MarqueeRow
            plates={PRESS_RUN_ROWS[1]}
            direction="right"
            durationSec={92}
            offsetFraction={0.4}
            onOpen={setActive}
          />
        </div>
        <div className="bs-rule-double" />
      </div>

      <Dialog open={active !== null} onOpenChange={open => { if (!open) setActive(null); }}>
        <DialogContent className="max-w-[min(1100px,94vw)] gap-0 border-ink bg-bg p-0 sm:rounded-none">
          {active && (
            <m.figure
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
              className="m-0"
            >
              <img
                src={active.src}
                alt={active.alt}
                width={1600}
                height={1000}
                className="block h-auto w-full border-b border-ink"
              />
              <figcaption className="flex flex-col gap-1 p-4">
                <DialogTitle className="text-[11px] font-medium tracking-[0.18em] text-muted uppercase">
                  <span className="font-bold text-vermilion">PLATE No. {active.no}&nbsp;</span>
                  · {active.skinName} × {active.themeName}
                </DialogTitle>
                <DialogDescription className="text-[14px] leading-[1.5] text-ink">
                  {active.skinDescription}
                </DialogDescription>
              </figcaption>
            </m.figure>
          )}
        </DialogContent>
      </Dialog>
    </EditorialReveal>
  );
}
