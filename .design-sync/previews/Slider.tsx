import * as React from 'react';
import { Slider, Label } from 'sub-wave-web';

// Radix slider: thin ink-tinted track, filled range, round thumb. Used for
// continuous radio settings like crossfade length and jingle frequency. Radix
// takes an array value; drag is interaction-only so a fixed default renders.
export const Default = () => (
  <div style={{ maxWidth: 340, display: 'grid', gap: 10 }}>
    <Label>Crossfade · 6s</Label>
    <Slider defaultValue={[6]} min={0} max={12} step={1} />
  </div>
);

export const Stepped = () => (
  <div style={{ maxWidth: 340, display: 'grid', gap: 10 }}>
    <Label>Jingle · 1 per 5 tracks</Label>
    <Slider defaultValue={[5]} min={1} max={12} step={1} />
  </div>
);

export const Full = () => (
  <div style={{ maxWidth: 340, display: 'grid', gap: 10 }}>
    <Label>Voice ducking depth · 100%</Label>
    <Slider defaultValue={[100]} min={0} max={100} step={5} />
  </div>
);

export const Disabled = () => (
  <div style={{ maxWidth: 340, display: 'grid', gap: 10 }}>
    <Label>Stream bitrate · locked</Label>
    <Slider defaultValue={[128]} min={64} max={320} step={32} disabled />
  </div>
);
