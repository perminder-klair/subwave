import * as React from 'react';
import { Toggle } from 'sub-wave-web';

// Radix toggle retuned to the newsprint look — data-[state=on] fills with the
// accent tone. Text children fix the bare-floor RENDER_THIN render.
export const Variants = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Toggle>Shuffle</Toggle>
    <Toggle variant="outline">Repeat</Toggle>
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Toggle size="sm">Calm mode</Toggle>
    <Toggle>Waveform</Toggle>
    <Toggle size="lg">Lyrics</Toggle>
  </div>
);

export const Pressed = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Toggle defaultPressed>Live</Toggle>
    <Toggle variant="outline" defaultPressed>
      Opus stream
    </Toggle>
  </div>
);

export const States = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Toggle disabled>Archive</Toggle>
    <Toggle variant="outline" defaultPressed disabled>
      FLAC (on)
    </Toggle>
  </div>
);
