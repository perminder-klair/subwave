import * as React from 'react';
import { FullDialog, Label, Input, Button } from 'sub-wave-web';

// Full-screen overlay used for the settings panel: header (eyebrow title +
// close) and a scrollable body. No footer — settings save inline. Render the
// OPEN state with a no-op onOpenChange.

export const Settings = () => (
  <FullDialog open onOpenChange={() => {}} title="STATION SETTINGS">
    <div style={{ display: 'grid', gap: 28, maxWidth: 640 }}>
      <section style={{ display: 'grid', gap: 14 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.3em', textTransform: 'uppercase', opacity: 0.55 }}>
          Stream
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <Label>MP3 bitrate</Label>
            <Input defaultValue="128 kbps" />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <Label>Crossfade (seconds)</Label>
            <Input defaultValue="6" />
          </div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 14, borderTop: '1px solid var(--ink)', paddingTop: 20 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.3em', textTransform: 'uppercase', opacity: 0.55 }}>
          DJ
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <Label>Station name</Label>
          <Input defaultValue="SUB/WAVE" />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <Label>Talk frequency</Label>
          <Input defaultValue="moderate" />
        </div>
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="accent">Save settings</Button>
      </div>
    </div>
  </FullDialog>
);
