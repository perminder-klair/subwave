'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/cn';

/* V3 Dialog — full-screen overlay used for the settings panel. */
export function FullDialog({ open, onOpenChange, title, children }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="v3-drawer-overlay fixed inset-0 z-40"
          style={{ background: 'var(--overlay)' }}
        />
        <Dialog.Content
          className={cn(
            'v3-drawer-content fixed z-50 bg-bg text-ink flex flex-col',
            'inset-x-0 top-0 bottom-0 outline-none',
          )}
          style={{ boxShadow: 'var(--drawer-shadow)' }}
        >
          <div
            className="flex justify-between items-baseline px-8 py-6"
            style={{ borderBottom: '1px solid var(--ink)' }}
          >
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
          <div className="flex-1 overflow-auto v3-scroll px-8 py-6">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
