import * as React from 'react';
import { Switch, Label } from 'sub-wave-web';

// Sharp 38×20 ink box, square thumb that slides right and fills white over the
// vermilion track when on. Mirrors the admin Toggle rows in SettingsPanel.
// The slide is a transition; the static on/off end states render here.
export const Off = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
    <Switch id="banter-off" />
    <Label htmlFor="banter-off">Guest banter</Label>
  </div>
);

export const On = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
    <Switch id="picker-on" defaultChecked />
    <Label htmlFor="picker-on">AI picker agent</Label>
  </div>
);

export const Rows = () => (
  <div style={{ display: 'grid', gap: 14, maxWidth: 300 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Label htmlFor="calm">Calm mode visualiser</Label>
      <Switch id="calm" defaultChecked />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Label htmlFor="exempt">Exempt listener requests</Label>
      <Switch id="exempt" />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Label htmlFor="studio-bed">Studio bed · env-locked</Label>
      <Switch id="studio-bed" defaultChecked disabled />
    </div>
  </div>
);
