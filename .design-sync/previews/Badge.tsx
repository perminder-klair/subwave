import * as React from 'react';
import { Badge } from 'sub-wave-web';

// The legacy .tag pill — sharp corners, tiny uppercase letter-spaced text,
// 1px border. Variants map the old tones (default/ink/accent/solid).
export const Variants = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Badge>Auto DJ</Badge>
    <Badge variant="ink">On air</Badge>
    <Badge variant="accent">Live</Badge>
    <Badge variant="solid">Request</Badge>
  </div>
);

export const Moods = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Badge variant="ink">Late night</Badge>
    <Badge variant="ink">Rainy</Badge>
    <Badge variant="ink">Focus</Badge>
    <Badge variant="ink">Sunday</Badge>
  </div>
);

export const StreamTiers = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Badge variant="solid">MP3 128</Badge>
    <Badge variant="accent">Opus 48</Badge>
    <Badge>FLAC off</Badge>
    <Badge>AAC off</Badge>
  </div>
);
