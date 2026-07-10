import * as React from 'react';
import { Modal, Label, Input, Button } from 'sub-wave-web';

// Centered ink-bordered dialog in the newsprint style: header (title + sub +
// close), scrollable body, sticky footer for actions. Controlled — render the
// OPEN state. Mirrors FestivalsSection's edit-festival modal.

export const EditFestival = () => (
  <Modal
    open
    onOpenChange={() => {}}
    title="edit festival"
    sub="Diwali"
    width={520}
    footer={
      <div style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Button variant="destructive" size="sm">Remove</Button>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm">Cancel</Button>
          <Button variant="accent" size="sm">Save changes</Button>
        </div>
      </div>
    }
  >
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <Label>Name</Label>
        <Input defaultValue="Diwali" placeholder="e.g. New Year's Day" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <Label>Month</Label>
          <Input defaultValue="November" />
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <Label>Day</Label>
          <Input defaultValue="1" />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <Label>Window (days)</Label>
        <Input defaultValue="3" />
      </div>
    </div>
  </Modal>
);
