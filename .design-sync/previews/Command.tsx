import * as React from 'react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  Kbd,
} from 'sub-wave-web';

// The listener ⌘K palette rendered inline — CommandDialog itself is
// portal-driven, so previews compose the inner Command directly and wrap it
// in the ink frame the dialog would supply. Mirrors CommandPalette.tsx:
// grouped items, each trailing a Kbd shortcut hint. cmdk auto-selects the
// first item, so the ink-fill highlight row renders statically.
export const Palette = () => (
  <div style={{ maxWidth: 440, border: '1px solid var(--ink)' }}>
    <Command>
      <CommandInput placeholder="Type a command…" />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        <CommandGroup heading="Player">
          <CommandItem value="tune in"><span>Tune in</span><Kbd>Space</Kbd></CommandItem>
          <CommandItem value="timeline"><span>Open Timeline</span><Kbd>1</Kbd></CommandItem>
          <CommandItem value="booth"><span>Open Booth feed</span><Kbd>2</Kbd></CommandItem>
          <CommandItem value="request"><span>Make a request</span><Kbd>3</Kbd></CommandItem>
        </CommandGroup>
        <CommandGroup heading="Session">
          <CommandItem value="mute"><span>Mute</span><Kbd>M</Kbd></CommandItem>
          <CommandItem value="shortcuts"><span>Keyboard shortcuts</span><Kbd>?</Kbd></CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  </div>
);

// Empty result: a query that matches nothing collapses the list to the
// CommandEmpty caption. The controlled input value keeps it fixed for capture.
export const NoResults = () => (
  <div style={{ maxWidth: 440, border: '1px solid var(--ink)' }}>
    <Command>
      <CommandInput value="reboot the transmitter" />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        <CommandGroup heading="Player">
          <CommandItem value="tune in"><span>Tune in</span><Kbd>Space</Kbd></CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  </div>
);
