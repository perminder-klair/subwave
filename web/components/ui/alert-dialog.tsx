'use client';

import type { ReactNode } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { cn } from '../../lib/cn';

/* V3 AlertDialog — sharp, ink-bordered confirmation modal. Controlled: pass
   `open` + `onOpenChange`. `onConfirm` fires when the operator accepts; the
   dialog closes itself either way. `danger` paints the confirm button red for
   destructive actions (skip track, restart mixer, delete jingle).

   Enter/exit are CSS animations keyed on Radix's `data-state` (the shadcn
   approach) — `.v3-alert-overlay` / `.v3-alert-content` in globals.css fade +
   zoom in on open and out on close. Radix's Presence waits for the close
   animation to finish before unmounting, so it's smooth in BOTH directions
   without motion/asChild (which `AlertDialog.Content` doesn't compose with).
   The overlay carries a soft backdrop blur. Centering stays on the Tailwind
   `-translate-*` utilities (the CSS `translate` property in v4) so the keyframe's
   `transform: scale()` composes with it and the box zooms from its own centre. */
export interface V3AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
}

export function V3AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'confirm',
  cancelLabel = 'cancel',
  danger = false,
  onConfirm,
}: V3AlertDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="v3-alert-overlay fixed inset-0 z-[60] bg-overlay [backdrop-filter:blur(6px)_saturate(1.05)] [-webkit-backdrop-filter:blur(6px)_saturate(1.05)]" />
        <AlertDialog.Content
          className={cn(
            'v3-alert-content fixed top-1/2 left-1/2 z-[70] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 border border-ink bg-bg text-ink shadow-drawer outline-none',
          )}
        >
          <div className="border-b border-ink px-5 py-3">
            <AlertDialog.Title className="v3-eyebrow m-0 text-[11px]">
              {title}
            </AlertDialog.Title>
          </div>
          <div className="px-5 py-4">
            <AlertDialog.Description className="m-0 text-[13px] leading-[1.6] text-ink">
              {description}
            </AlertDialog.Description>
          </div>
          <div className="flex justify-end gap-2 border-t border-ink px-5 py-3">
            <AlertDialog.Cancel className="v3-eyebrow v3-focus cursor-pointer border border-ink bg-transparent px-3.5 py-1.5 text-[10px] text-ink">
              {cancelLabel}
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              className={cn(
                'v3-eyebrow v3-focus cursor-pointer border-0 px-3.5 py-1.5 text-[10px] text-white',
                danger ? 'bg-[#c5302a]' : 'bg-vermilion',
              )}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
