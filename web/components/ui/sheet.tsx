'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AnimatePresence,
  animate as motionAnimate,
  m,
  useMotionValue,
  useReducedMotion,
} from 'motion/react';
import { useDrag } from '@use-gesture/react';
import { cn } from '@/lib/cn';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  children?: ReactNode;
  container?: HTMLElement | null;
}

// Swipe threshold, distance OR velocity. Matches where iOS/Android side-sheets
// dismiss.
const DISMISS_PX = 80;
const DISMISS_VX = 0.4;

/* V3 Sheet — right-side drawer between the top and bottom bars.

   Entrance is the `v3-drawer-content` CSS keyframe; motion owns only the exit
   and the drag gesture, to avoid double-animating the slide-in. AnimatePresence
   + Radix forceMount lets the exit play before Radix unmounts.

   Swipe-to-dismiss is disabled in the contained (landing-embedded) variant,
   which lives inside a card and shouldn't slide independently, and under
   prefers-reduced-motion. */
export function Sheet({ open, onOpenChange, title, children, container }: SheetProps) {
  const contained = !!container;
  const pos = contained ? 'absolute' : 'fixed';
  const prefersReducedMotion = useReducedMotion();
  const gestureEnabled = !contained && !prefersReducedMotion;

  const x = useMotionValue(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // useMotionValue persists across the AnimatePresence mount cycle, so the
  // exit's x: 100% would carry into the next open and render the drawer
  // off-screen. useLayoutEffect runs before paint, so no wrong frame is seen.
  useLayoutEffect(() => {
    if (open) x.set(0);
  }, [open, x]);

  const bind = useDrag(
    ({ first, movement: [mx], velocity: [vx], cancel, last, event }) => {
      if (first) {
        // Body scroll wins when the touch started inside the scroll body and it
        // is scrolled below the top.
        const target = event.target as HTMLElement | null;
        const scrollEl = scrollRef.current;
        if (
          target &&
          scrollEl &&
          scrollEl.contains(target) &&
          target !== scrollEl &&
          scrollEl.scrollTop > 0
        ) {
          cancel();
          return;
        }
      }
      // Drawer slides right only.
      const clampedX = Math.max(0, mx);
      x.set(clampedX);
      if (last) {
        const shouldClose = clampedX > DISMISS_PX || vx > DISMISS_VX;
        if (shouldClose) {
          onOpenChange(false);
        } else {
          motionAnimate(x, 0, { type: 'spring', stiffness: 400, damping: 32 });
        }
      }
    },
    {
      axis: 'x',
      enabled: gestureEnabled,
      filterTaps: true,
      pointer: { touch: true },
    },
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount container={container}>
            <Dialog.Overlay asChild forceMount>
              <m.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className={cn('v3-drawer-overlay inset-0 z-40 bg-overlay', pos)}
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              forceMount
              aria-describedby={undefined}
            >
              <m.div
                initial={false}
                exit={{ x: '100%', opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}
                style={gestureEnabled ? { x } : undefined}
                // @use-gesture's bind() spreads a DOM `onAnimationStart` that
                // collides with motion's callback of the same name. The cast
                // lets the spread through; motion's own handler wins.
                {...((gestureEnabled ? bind() : {}) as Record<string, unknown>)}
                className={cn(
                  'v3-drawer-content relative z-50 flex touch-pan-y flex-col border border-ink text-ink shadow-drawer',
                  'bg-[color-mix(in_oklab,var(--bg)_30%,transparent)]',
                  '[backdrop-filter:blur(28px)_saturate(1.9)_brightness(1.07)]',
                  '[-webkit-backdrop-filter:blur(28px)_saturate(1.9)_brightness(1.07)]',
                  pos,
                  contained
                    ? 'top-16 right-4 bottom-16 w-[min(420px,calc(100%-32px))]'
                    : 'inset-x-0 top-16 bottom-16 w-full sm:top-20 sm:right-24 sm:bottom-20 sm:left-auto sm:w-[460px]',
                  'p-5 outline-none sm:p-7',
                )}
              >
                <div className="mb-5 flex items-baseline justify-between">
                  <Dialog.Title className="v3-eyebrow m-0 text-sm tracking-[0.4em]">
                    {title}
                  </Dialog.Title>
                  <Dialog.Close
                    className="v3-focus cursor-pointer text-xl leading-none"
                    aria-label="Close"
                  >
                    ×
                  </Dialog.Close>
                </div>
                <div ref={scrollRef} className="v3-scroll flex-1 overflow-auto">
                  {children}
                </div>
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
