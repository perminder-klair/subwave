'use client';

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { cn } from '../../lib/cn';

/* V3 AlertDialog — sharp, ink-bordered confirmation modal. Controlled: pass
   `open` + `onOpenChange`. `onConfirm` fires when the operator accepts; the
   dialog closes itself either way. `danger` paints the confirm button red for
   destructive actions (skip track, restart mixer, delete jingle). */
export function V3AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'confirm',
  cancelLabel = 'cancel',
  danger = false,
  onConfirm,
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className="v3-drawer-overlay fixed inset-0 z-40"
          style={{ background: 'var(--overlay)' }}
        />
        <AlertDialog.Content
          className={cn(
            'fixed z-50 bg-bg text-ink outline-none',
            'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            'w-[calc(100vw-2rem)] max-w-md',
          )}
          style={{ border: '1px solid var(--ink)', boxShadow: 'var(--drawer-shadow)' }}
        >
          <div
            className="px-5 py-3"
            style={{ borderBottom: '1px solid var(--ink)' }}
          >
            <AlertDialog.Title className="v3-eyebrow m-0" style={{ fontSize: 11 }}>
              {title}
            </AlertDialog.Title>
          </div>
          <div className="px-5 py-4">
            <AlertDialog.Description
              className="m-0"
              style={{ color: 'var(--ink)', fontSize: 13, lineHeight: 1.6 }}
            >
              {description}
            </AlertDialog.Description>
          </div>
          <div
            className="flex justify-end gap-2 px-5 py-3"
            style={{ borderTop: '1px solid var(--ink)' }}
          >
            <AlertDialog.Cancel
              className="v3-eyebrow v3-focus cursor-pointer"
              style={{
                background: 'transparent',
                color: 'var(--ink)',
                border: '1px solid var(--ink)',
                padding: '6px 14px',
                fontSize: 10,
              }}
            >
              {cancelLabel}
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              className="v3-eyebrow v3-focus cursor-pointer"
              style={{
                background: danger ? '#c5302a' : 'var(--accent)',
                color: '#fff',
                border: 'none',
                padding: '6px 14px',
                fontSize: 10,
              }}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
