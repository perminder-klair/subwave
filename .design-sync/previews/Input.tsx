import * as React from 'react';
import { Input, Label } from 'sub-wave-web';

// Sharp 1px-ink field on the cream field bg, 13px ink text. Mirrors the
// admin SettingsPanel text inputs. Closed static states render cleanly;
// focus ring is interaction-only.
export const Default = () => (
  <div style={{ maxWidth: 320 }}>
    <Input defaultValue="SUB/WAVE" />
  </div>
);

export const WithLabel = () => (
  <div style={{ maxWidth: 320, display: 'grid', gap: 6 }}>
    <Label htmlFor="navidrome-url">Navidrome URL</Label>
    <Input id="navidrome-url" defaultValue="http://navidrome:4533" />
  </div>
);

export const Placeholder = () => (
  <div style={{ maxWidth: 320, display: 'grid', gap: 6 }}>
    <Label htmlFor="station-title">Station title</Label>
    <Input id="station-title" placeholder="Name your station…" />
  </div>
);

export const Disabled = () => (
  <div style={{ maxWidth: 320, display: 'grid', gap: 6 }}>
    <Label htmlFor="site-url">Site URL · set via env</Label>
    <Input id="site-url" defaultValue="https://getsubwave.com" disabled />
  </div>
);
