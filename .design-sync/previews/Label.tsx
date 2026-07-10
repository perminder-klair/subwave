import * as React from 'react';
import { Label, Input, Textarea } from 'sub-wave-web';

// The newsprint field-label: tiny uppercase JetBrains-Mono caption with wide
// letter-spacing, ink coloured. Standalone and paired with the fields it names.
export const Standalone = () => <Label>Now playing</Label>;

export const WithInput = () => (
  <div style={{ maxWidth: 320, display: 'grid', gap: 6 }}>
    <Label htmlFor="admin-user">Admin username</Label>
    <Input id="admin-user" defaultValue="operator" />
  </div>
);

export const WithTextarea = () => (
  <div style={{ maxWidth: 360, display: 'grid', gap: 6 }}>
    <Label htmlFor="station-id-brief">Station ID brief</Label>
    <Textarea
      id="station-id-brief"
      rows={2}
      defaultValue={'One line, dry, no music — just remind them what they are listening to.'}
    />
  </div>
);

export const Stacked = () => (
  <div style={{ display: 'grid', gap: 14 }}>
    <Label>Broadcast bitrate</Label>
    <Label>DJ frequency</Label>
    <Label>Dominant mood</Label>
  </div>
);
