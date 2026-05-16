'use client';

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/cn';

/* V3 Modal — centered, ink-bordered dialog in the admin newsprint style.
   shadcn-style composition: a header (title + sub + close), a scrollable
   body, and an optional sticky footer for actions.

   It portals into `.admin-root` rather than <body> so the admin-scoped CSS
   (`.input` / `.select` / `.textarea` / `.btn` / `.eyebrow` …) resolves for
   form controls rendered inside it. Falls back to <body> outside the admin
   shell. Controlled: pass `open` + `onOpenChange`. */
export function Modal({
  open,
  onOpenChange,
  title,
  sub,
  children,
  footer,
  width = 560,
}) {
  const [container, setContainer] = useState(null);
  useEffect(() => {
    setContainer(document.querySelector('.admin-root') || document.body);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay
          className="v3-drawer-overlay fixed inset-0 z-40"
          style={{ background: 'var(--overlay)' }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'v3-modal-pop fixed z-50 left-1/2 top-1/2 outline-none flex flex-col',
          )}
          style={{
            // Persistent centering transform — the v3-modal-pop keyframe
            // overrides this while animating, then falls back to it on finish.
            // Without it the element snaps to its own top-left at 50%/50%.
            transform: 'translate(-50%, -50%)',
            width: `min(${width}px, calc(100vw - 2rem))`,
            maxHeight: 'calc(100vh - 3rem)',
            background: 'var(--card-bg, var(--bg))',
            color: 'var(--ink)',
            border: '1px solid var(--ink)',
            boxShadow: 'var(--drawer-shadow)',
          }}
        >
          <div
            className="flex items-baseline justify-between gap-3 px-5 py-3"
            style={{ borderBottom: '1px solid var(--ink)' }}
          >
            <div className="flex items-baseline gap-3 min-w-0">
              <Dialog.Title
                className="eyebrow m-0"
                style={{ color: 'var(--ink)', whiteSpace: 'nowrap' }}
              >
                {title}
              </Dialog.Title>
              {sub && <span className="caption truncate">{sub}</span>}
            </div>
            <Dialog.Close
              className="cursor-pointer v3-focus"
              aria-label="Close"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                fontSize: 22,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-auto v3-scroll px-5 py-4">{children}</div>

          {footer && (
            <div
              className="flex items-center justify-end gap-2 px-5 py-3"
              style={{ borderTop: '1px solid var(--ink)' }}
            >
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
