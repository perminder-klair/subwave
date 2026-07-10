import * as React from 'react';
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupText,
  InputGroupButton,
} from 'sub-wave-web';

const SearchGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
  </svg>
);

// Leading search icon addon — mirrors the LibraryPanel search field.
export const SearchField = () => (
  <div style={{ maxWidth: 380 }}>
    <InputGroup>
      <InputGroupAddon>
        <SearchGlyph />
      </InputGroupAddon>
      <InputGroupInput placeholder="Search the library…" defaultValue="talking heads" />
    </InputGroup>
  </div>
);

// Protocol prefix as a text addon on a URL field.
export const ProtocolAddon = () => (
  <div style={{ maxWidth: 380 }}>
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText>https://</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput defaultValue="getsubwave.com" />
    </InputGroup>
  </div>
);

// Trailing button addon — the listener request bar, vermilion send action.
export const TrailingButton = () => (
  <div style={{ maxWidth: 380 }}>
    <InputGroup>
      <InputGroupInput placeholder="Request a song or artist…" defaultValue="Blue Monday" />
      <InputGroupAddon align="inline-end">
        <InputGroupButton variant="accent" size="sm">Send</InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  </div>
);
