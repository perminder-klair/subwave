import * as React from 'react';
import { Checkbox, Label } from 'sub-wave-web';

// Radix checkbox retuned to a 16px sharp box, ink border, ink fill + white
// check when set. Mirrors DebugPanel auto-scroll + settings toggles. Hover/
// focus are interaction-only; the static checked/unchecked states render here.
export const Unchecked = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <Checkbox id="opus" />
    <Label htmlFor="opus">Serve Opus stream</Label>
  </div>
);

export const Checked = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <Checkbox id="archive" defaultChecked />
    <Label htmlFor="archive">Hourly archive mixdowns</Label>
  </div>
);

export const Group = () => (
  <div style={{ display: 'grid', gap: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Checkbox id="flac" />
      <Label htmlFor="flac">FLAC (lossless)</Label>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Checkbox id="aac" defaultChecked />
      <Label htmlFor="aac">AAC (external players)</Label>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Checkbox id="mp3" defaultChecked disabled />
      <Label htmlFor="mp3">MP3 · always on</Label>
    </div>
  </div>
);
