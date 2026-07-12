'use client';

import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef, type ReactNode } from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';

/* shadcn-style Command wrappers over `cmdk`, restyled with the newsprint
   tokens. CommandDialog is hand-built on @radix-ui/react-dialog rather than
   the stock shadcn version — this repo has no stock DialogContent, and the
   `container` prop keeps the palette inside the frame in contained mode. */

export const Command = forwardRef<
  ComponentRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn('flex h-full w-full flex-col overflow-hidden bg-bg text-ink', className)}
    {...props}
  />
));
Command.displayName = 'Command';

export interface CommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container?: HTMLElement | null;
  label?: string;
  children?: ReactNode;
}

export function CommandDialog({
  open,
  onOpenChange,
  container,
  label = 'Command palette',
  children,
}: CommandDialogProps) {
  const contained = !!container;
  const pos = contained ? 'absolute' : 'fixed';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay
          className={cn('v3-drawer-overlay inset-0 z-40 bg-overlay', pos)}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'top-[16%] left-1/2 z-50 -translate-x-1/2 outline-none',
            'w-[min(540px,calc(100vw-2rem))] border border-ink bg-bg text-ink shadow-drawer',
            '[animation:v3-fade-in_160ms_ease-out]',
            pos,
          )}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          <Command loop>{children}</Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const CommandInput = forwardRef<
  ComponentRef<typeof CommandPrimitive.Input>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input> & { wrapperClassName?: string }
>(({ className, wrapperClassName, ...props }, ref) => (
  <div className={cn("flex items-center gap-2 border-b border-ink px-4", wrapperClassName)}>
    <Search size={15} strokeWidth={1.5} className="shrink-0 text-muted" />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        'flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted',
        className,
      )}
      {...props}
    />
  </div>
));
CommandInput.displayName = 'CommandInput';

export const CommandList = forwardRef<
  ComponentRef<typeof CommandPrimitive.List>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn('v3-scroll max-h-80 overflow-x-hidden overflow-y-auto py-1', className)}
    {...props}
  />
));
CommandList.displayName = 'CommandList';

export const CommandEmpty = forwardRef<
  ComponentRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="py-6 text-center text-sm text-muted"
    {...props}
  />
));
CommandEmpty.displayName = 'CommandEmpty';

export const CommandGroup = forwardRef<
  ComponentRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      'overflow-hidden p-1',
      '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2',
      '[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase',
      '[&_[cmdk-group-heading]]:tracking-[0.3em] [&_[cmdk-group-heading]]:text-muted',
      className,
    )}
    {...props}
  />
));
CommandGroup.displayName = 'CommandGroup';

export const CommandSeparator = forwardRef<
  ComponentRef<typeof CommandPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn('h-px bg-[color:var(--separator-strong)]', className)}
    {...props}
  />
));
CommandSeparator.displayName = 'CommandSeparator';

export function CommandShortcut({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      className={cn('ml-auto text-[10px] tracking-[0.14em] text-muted uppercase', className)}
      {...props}
    />
  );
}

export const CommandItem = forwardRef<
  ComponentRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      'flex cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-sm outline-none select-none',
      'data-[selected=true]:bg-ink data-[selected=true]:text-bg',
      'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40',
      className,
    )}
    {...props}
  />
));
CommandItem.displayName = 'CommandItem';
