import * as React from 'react';
import { Button } from 'sub-wave-web';

// The `variant` axis maps the legacy .btn tones: default/outline (1px ink
// border), solid (ink fill), accent (vermilion), destructive, secondary,
// ghost, link.
export const Variants = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Button>Default</Button>
    <Button variant="solid">Solid</Button>
    <Button variant="accent">Tune in</Button>
    <Button variant="destructive">Delete show</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="link">View schedule</Button>
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Button size="sm">Small</Button>
    <Button>Default</Button>
    <Button size="lg">Large</Button>
    <Button size="icon" aria-label="Play">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
    </Button>
  </div>
);

export const States = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Button disabled>Disabled</Button>
    <Button variant="accent" disabled>
      Disabled accent
    </Button>
    <Button variant="solid">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
      With icon
    </Button>
  </div>
);
