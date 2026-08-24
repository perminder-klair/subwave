'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, m } from 'motion/react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

/* Full-screen, edge-to-edge editor for add/edit of shows, personas and skills.
   Header carries title/sub/close only; ALL actions live in the footer transport
   bar, so the header stays uniform across the three editors.

   Full-screen rather than the centered `Modal` because a `fixed inset-0` panel
   has no width to animate, so it can't reproduce the width-jump glitch that
   pushed the shows/personas editors in-page (#694). Built on Radix Dialog for
   focus trap, body scroll-lock and hierarchical Escape.

   Motion mirrors `sheet.tsx`: AnimatePresence + Radix `forceMount` so the exit
   plays before unmount, and `<m.div>` because LazyMotion is `strict` (see
   MotionProvider). Reduced motion is honoured globally by `MotionConfig`, so
   there is no per-component branch.

   Portals into `.admin-root` (falling back to <body>) so the admin-scoped class
   names resolve for the form controls inside. */
export interface EditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  title?: ReactNode;
  sub?: ReactNode;
  footer?: ReactNode;
  /* Lets a consumer scope its own descendant CSS inside the content panel. */
  className?: string;
  children?: ReactNode;
}

export function EditorDialog({
  open,
  onOpenChange,
  busy = false,
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
                aria-busy={busy || undefined}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
                className={cn('fixed inset-0 z-50 flex flex-col bg-bg text-ink outline-none', className)}
              >
                <div className="flex-none border-b border-ink">
                  <div className={cn(column, 'flex items-center justify-between gap-3 py-3.5')}>
                    <div className="flex min-w-0 flex-1 items-baseline gap-3">
                      <Dialog.Title asChild>
                        <div className="m-0 min-w-0 flex-1 text-ink">{title}</div>
                      </Dialog.Title>
                      {sub && <div className="flex-none">{sub}</div>}
                    </div>
                    <Dialog.Close
                      disabled={busy}
                      className="v3-focus flex-none cursor-pointer border-0 bg-transparent p-0 text-[22px] leading-none text-muted"
                      aria-label="Close"
                    >
                      ×
                    </Dialog.Close>
                  </div>
                </div>

                <div className="v3-scroll flex-1 overflow-auto">
                  <div className={cn(column, 'py-6')}>
                    {children}
                  </div>
                </div>

                {/* Padding is tighter on a phone: the footer is fixed furniture
                    stealing height from the form above it. */}
                {footer && (
                  <div className="flex-none border-t border-ink">
                    <div className={cn(column, 'py-2 sm:py-3')}>
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

/* EditorFooter — the transport bar shared by the shows / personas / skills
   editors. Data-driven because a plain flex-wrap row falls apart on a phone:
   the skills bar alone is ~600px of transport and wrapped into four rows.

   `primary` (close/save) always stays visible on one row; `actions` render
   inline from `sm:` up and collapse into a `⋯` overflow menu below it; `status`
   gets its own line so a long validation message never pushes buttons around.

   Both branches are rendered and CSS-hidden rather than picked by
   `useIsMobile`, so the footer is stable through hydration — a first paint with
   the wrong branch would jump the whole panel. */
export interface EditorAction {
  id: string;
  /** Text only: it doubles as the overflow-menu row. */
  label: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'solid' | 'accent' | 'danger';
  disabled?: boolean;
  title?: string;
  /** Left off the bar entirely, so call sites need no `&&` gymnastics. */
  hidden?: boolean;
  icon?: ReactNode;
}

const TONE_VARIANT = {
  default: 'default',
  solid: 'solid',
  accent: 'accent',
  danger: 'destructive',
} as const;

/* Default size on a phone, `lg` from sm: up; mirrors buttonVariants' `lg`. */
const RESPONSIVE_SIZE = 'sm:px-[22px] sm:py-[11px] sm:text-[11px]';

function ActionButton({ action, className }: { action: EditorAction; className?: string }) {
  return (
    <Button
      type="button"
      variant={TONE_VARIANT[action.tone || 'default']}
      onClick={action.onClick}
      disabled={action.disabled}
      title={action.title}
      className={cn(RESPONSIVE_SIZE, className)}
    >
      {action.icon}
      {action.label}
    </Button>
  );
}

export interface EditorFooterProps {
  /** Rendered on its own row above the buttons. */
  status?: ReactNode;
  /** Always-visible control that isn't a button. */
  extra?: ReactNode;
  /** Inline on desktop, `⋯` overflow menu on a phone. */
  actions?: EditorAction[];
  /** Always visible, always last. */
  primary?: EditorAction[];
}

export function EditorFooter({ status, extra, actions = [], primary = [] }: EditorFooterProps) {
  const visible = actions.filter(a => !a.hidden);
  const primaryVisible = primary.filter(a => !a.hidden);

  return (
    <div className="flex w-full flex-col gap-2">
      {status && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] leading-snug text-muted">
          {status}
        </div>
      )}
      <div className="flex items-center gap-2 sm:gap-3">
        {extra}

        {visible.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="default"
                size="icon"
                className="sm:hidden"
                aria-label="More actions"
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-[11rem]">
              {visible.map(a => (
                <DropdownMenuItem
                  key={a.id}
                  disabled={a.disabled}
                  onSelect={a.onClick}
                  className={cn(a.tone === 'danger' && 'text-[var(--danger)]')}
                >
                  {a.icon}
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {visible.length > 0 && (
          <div className="hidden flex-wrap items-center gap-2 sm:flex sm:gap-3">
            {visible.map(a => <ActionButton key={a.id} action={a} />)}
          </div>
        )}

        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
          {primaryVisible.map(a => <ActionButton key={a.id} action={a} />)}
        </div>
      </div>
    </div>
  );
}
