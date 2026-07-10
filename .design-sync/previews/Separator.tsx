import * as React from 'react';
import { Separator } from 'sub-wave-web';

// Hairline rule over Radix Separator — horizontal by default, vertical for
// inline dividers between metadata.
export const Horizontal = () => (
  <div style={{ maxWidth: 320 }}>
    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Now playing</div>
    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
      Burial — Archangel
    </div>
    <Separator />
    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
      Up next, picked by the AI DJ
    </div>
  </div>
);

export const Vertical = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      height: 20,
      fontSize: 12,
      color: 'var(--muted)',
    }}
  >
    <span>128 kbps</span>
    <Separator orientation="vertical" />
    <span>MP3</span>
    <Separator orientation="vertical" />
    <span>42 listeners</span>
  </div>
);

export const InList = () => (
  <div style={{ maxWidth: 320, fontSize: 13, color: 'var(--ink)' }}>
    <div style={{ padding: '8px 0' }}>Late Night Drift</div>
    <Separator />
    <div style={{ padding: '8px 0' }}>Sunday Broadsheet</div>
    <Separator />
    <div style={{ padding: '8px 0' }}>Rainy Day Reads</div>
  </div>
);
