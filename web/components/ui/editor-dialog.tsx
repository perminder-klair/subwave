'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, m } from 'motion/react';
import { cn } from '../../lib/cn';

/* V3 EditorDialog — the full-screen, edge-to-edge editor used for add/edit of
   shows, personas and skills. One shell, three editors, one consistent shape:

     • header  — title + sub + close, identical across all three (no actions).
     • body    — full-width, scrollable. Sections inside are separated by
                 hairline dividers (see `.card.is-flat`), never boxed cards.
     • footer  — the transport bar; ALL actions live here (save, delete,
                 run, toggles…), so the header stays uniform.

   Why full-screen rather than the centered `Modal`: a `fixed inset-0` panel has
   no width to animate, so it can't reproduce the width-jump glitch that pushed
   the shows/personas editors in-page (#694). It is built on Radix Dialog — so
   focus trap, body scroll-lock and hierarchical Escape come for free — instead
   of a hand-rolled overlay (the old glitchy skills modal).

   Motion mirrors `sheet.tsx`: AnimatePresence + Radix `forceMount` so the exit
   plays before unmount; `<m.div>` (LazyMotion is `strict` — `motion.div` is
   forbidden, see MotionProvider). The content fades + rises (transform/opacity
   only → GPU-composited, no layout shift). Reduced motion is honoured globally
   by `MotionConfig reducedMotion="user"`, so there is no per-component branch.

   It portals into `.admin-root` (falling back to <body>) so the admin-scoped
   class names (`.input` / `.btn` / `.card` / `.eyebrow` …) resolve for the
   form controls rendered inside. Controlled: pass `open` + `onOpenChange`. */
export interface EditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  sub?: ReactNode;
  footer?: ReactNode;
  /* Extra class on the content panel — lets a consumer scope its own descendant
     CSS inside (e.g. the skills editor's `.sw-seg` typographic rules). */
  className?: string;
  children?: ReactNode;
}

export function EditorDialog({
  open,
  onOpenChange,
  title,
  sub,
  footer,
  className,
  children,
}: EditorDialogProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(document.querySelector<HTMLElement>('.admin-root') || document.body);
  }, []);

  // Full-width content with generous side padding — the form fills the modal.
  const column = 'w-full px-5 sm:px-8';

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
                className="fixed inset-0 z-40 bg-overlay [backdrop-filter:blur(8px)_saturate(1.1)] [-webkit-backdrop-filter:blur(8px)_saturate(1.1)]"
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <m.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
                className={cn('fixed inset-0 z-50 flex flex-col bg-bg text-ink outline-none', className)}
              >
                {/* Sticky header — title + sub + close, identical for all editors */}
                <div className="flex-none border-b border-ink">
                  <div className={cn(column, 'flex items-center justify-between gap-3 py-3.5')}>
                    <div className="flex min-w-0 flex-1 items-baseline gap-3">
                      <Dialog.Title asChild>
                        <div className="m-0 min-w-0 flex-1 text-ink">{title}</div>
                      </Dialog.Title>
                      {sub && <div className="flex-none">{sub}</div>}
                    </div>
                    <Dialog.Close
                      className="v3-focus flex-none cursor-pointer border-0 bg-transparent p-0 text-[22px] leading-none text-muted"
                      aria-label="Close"
                    >
                      ×
                    </Dialog.Close>
                  </div>
                </div>

                {/* Scrollable body — full width */}
                <div className="v3-scroll flex-1 overflow-auto">
                  <div className={cn(column, 'py-6')}>
                    {children}
                  </div>
                </div>

                {/* Sticky footer — the transport bar; all actions live here */}
                {footer && (
                  <div className="flex-none border-t border-ink">
                    <div className={cn(column, 'py-3')}>
                      {footer}
                    </div>
                  </div>
                )}
              </m.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
