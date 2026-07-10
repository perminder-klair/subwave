import * as React from 'react';
import { Sheet, Label, Input, Button } from 'sub-wave-web';

// Right-side drawer, glassy cream wash over a backdrop blur, 1px ink borders.
// Used on the listener side as the request drawer. Render the OPEN state with a
// no-op onOpenChange (swipe-to-dismiss / exit animation can't render statically).

export const RequestDrawer = () => (
  <Sheet open onOpenChange={() => {}} title="REQUEST">
    <div style={{ display: 'grid', gap: 18 }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.75 }}>
        Ask the DJ for a track. If it&apos;s in the library, it slots into the
        queue with a quick intro — no promises on timing.
      </p>
      <div style={{ display: 'grid', gap: 6 }}>
        <Label>Artist or song</Label>
        <Input defaultValue="Khruangbin — August 10" placeholder="e.g. Bonobo — Kerala" />
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <Label>Note to the DJ (optional)</Label>
        <Input placeholder="for the drive home" />
      </div>
      <Button variant="accent">Send request</Button>

      <div style={{ borderTop: '1px solid var(--ink)', paddingTop: 14, display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.3em', textTransform: 'uppercase', opacity: 0.55 }}>
          Recently played requests
        </div>
        <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>Men I Trust — Show Me How</span>
            <span style={{ opacity: 0.5 }}>12m ago</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>Portishead — Roads</span>
            <span style={{ opacity: 0.5 }}>34m ago</span>
          </div>
        </div>
      </div>
    </div>
  </Sheet>
);
