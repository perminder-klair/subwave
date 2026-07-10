import * as React from 'react';
import { Kbd } from 'sub-wave-web';

// Newsprint key-cap badge — used by the ⌘K command palette and the shortcuts
// help dialog. Mono, hairline soft border.
export const Single = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Kbd>?</Kbd>
    <Kbd>R</Kbd>
    <Kbd>Esc</Kbd>
    <Kbd>Space</Kbd>
  </div>
);

export const Combos = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Kbd>⌘K</Kbd>
    <Kbd>Ctrl K</Kbd>
    <Kbd>⌘⇧P</Kbd>
  </div>
);

export const InRow = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      maxWidth: 300,
    }}
  >
    <span style={{ fontSize: 13, color: 'var(--muted)' }}>Command palette</span>
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </span>
  </div>
);
