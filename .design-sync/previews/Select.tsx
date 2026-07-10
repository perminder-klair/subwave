import * as React from 'react';
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'sub-wave-web';

// Composition mirrors admin FestivalsSection: Trigger + Value, Content of
// Items. Closed states render statically; the open dropdown is portal-driven.
export const WithValue = () => (
  <div style={{ maxWidth: 280, display: 'grid', gap: 6 }}>
    <Label>Mood</Label>
    <Select defaultValue="rainy">
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="sunny">Sunny</SelectItem>
        <SelectItem value="rainy">Rainy</SelectItem>
        <SelectItem value="festival">Festival</SelectItem>
        <SelectItem value="latenight">Late night</SelectItem>
      </SelectContent>
    </Select>
  </div>
);

export const Placeholder = () => (
  <div style={{ maxWidth: 280, display: 'grid', gap: 6 }}>
    <Label>TTS engine</Label>
    <Select>
      <SelectTrigger>
        <SelectValue placeholder="Pick an engine…" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="piper">Piper</SelectItem>
        <SelectItem value="kokoro">Kokoro</SelectItem>
        <SelectItem value="chatterbox">Chatterbox</SelectItem>
      </SelectContent>
    </Select>
  </div>
);

export const Disabled = () => (
  <div style={{ maxWidth: 280, display: 'grid', gap: 6 }}>
    <Label>Stream bitrate</Label>
    <Select defaultValue="128" disabled>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="128">128 kbps</SelectItem>
      </SelectContent>
    </Select>
  </div>
);
