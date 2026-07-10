'use client';

import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from './ui/command';
import { Kbd } from './ui/kbd';

export type PlayerDrawer = 'timeline' | 'booth' | 'request' | 'schedule' | 'audio';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
  tunedIn: boolean;
  muted: boolean;
  onTune: () => void;
  onOpenDrawer: (kind: PlayerDrawer) => void;
  onToggleMute: () => void;
  onShowShortcuts: () => void;
}

interface PaletteItem {
  label: string;
  hint: string;
  onSelect: () => void;
}

/* ⌘K command palette for the listener-facing player. Scope is player
   actions only — no jumping to admin/site routes. Each item runs its
   handler and closes the palette. */
export default function CommandPalette({
  open,
  onOpenChange,
  container,
  tunedIn,
  muted,
  onTune,
  onOpenDrawer,
  onToggleMute,
  onShowShortcuts,
}: CommandPaletteProps) {
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  const items: PaletteItem[] = [
    { label: tunedIn ? 'Tune out' : 'Tune in', hint: 'Space', onSelect: run(onTune) },
    { label: 'Open Timeline', hint: '1', onSelect: run(() => onOpenDrawer('timeline')) },
    { label: 'Open Booth feed', hint: '2', onSelect: run(() => onOpenDrawer('booth')) },
    { label: 'Make a request', hint: '3', onSelect: run(() => onOpenDrawer('request')) },
    { label: 'Open Schedule', hint: '4', onSelect: run(() => onOpenDrawer('schedule')) },
    { label: 'Audio format', hint: '', onSelect: run(() => onOpenDrawer('audio')) },
    { label: muted ? 'Unmute' : 'Mute', hint: 'M', onSelect: run(onToggleMute) },
    { label: 'Keyboard shortcuts', hint: '?', onSelect: run(onShowShortcuts) },
  ];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      container={container}
      label="Command palette"
    >
      <CommandInput placeholder="Type a command…" />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        <CommandGroup heading="Player">
          {items.map((it) => (
            <CommandItem key={it.label} value={it.label} onSelect={it.onSelect}>
              <span>{it.label}</span>
              {it.hint && <Kbd>{it.hint}</Kbd>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
