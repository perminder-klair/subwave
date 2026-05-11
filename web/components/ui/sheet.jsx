'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/cn';

/* V3 Sheet — right-side drawer between the top and bottom bars (offset 80px
   each), 460px wide, cream background, 1px ink borders, animates in from the
   right via v3-drawer-content keyframe in globals.css. No exit animation.
   When `container` is supplied the drawer is scoped to that element (used
   for the embedded player on the landing page); otherwise it covers the
   whole viewport as before. */
export function Sheet({ open, onOpenChange, title, children, container }) {
  const contained = !!container;
  const pos = contained ? 'absolute' : 'fixed';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay
          className={cn('v3-drawer-overlay inset-0 z-40', pos)}
          style={{ background: 'var(--overlay)' }}
        />
        <Dialog.Content
          className={cn(
            'v3-drawer-content z-50 bg-bg text-ink flex flex-col',
            pos,
            contained
              ? 'top-[64px] bottom-[64px] right-[16px] w-[min(420px,calc(100%-32px))]'
              : 'top-[80px] bottom-[80px] right-[96px] w-[460px]',
            'p-7 outline-none',
          )}
          style={{
            borderLeft: '1px solid var(--ink)',
            borderRight: '1px solid var(--ink)',
            boxShadow: 'var(--drawer-shadow)',
          }}
          aria-describedby={undefined}
        >
          <div className="flex justify-between items-baseline mb-5">
            <Dialog.Title className="v3-eyebrow m-0" style={{ fontSize: 14, letterSpacing: '0.4em' }}>
              {title}
            </Dialog.Title>
            <Dialog.Close
              className="cursor-pointer text-xl leading-none v3-focus"
              aria-label="Close"
            >
              ×
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-auto v3-scroll">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
