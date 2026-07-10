import * as React from 'react';
import { ToggleGroup, ToggleGroupItem } from 'sub-wave-web';

// Segmented control (admin/ui SegmentControl) — single-select over Radix
// ToggleGroup. defaultValue pins the active segment for the static render.
export const Single = () => (
  <ToggleGroup type="single" defaultValue="moderate" style={{ justifyContent: 'flex-start' }}>
    <ToggleGroupItem value="quiet">Quiet</ToggleGroupItem>
    <ToggleGroupItem value="moderate">Moderate</ToggleGroupItem>
    <ToggleGroupItem value="aggressive">Aggressive</ToggleGroupItem>
  </ToggleGroup>
);

export const Outline = () => (
  <ToggleGroup
    type="single"
    variant="outline"
    defaultValue="opus"
    style={{ justifyContent: 'flex-start' }}
  >
    <ToggleGroupItem value="mp3">MP3</ToggleGroupItem>
    <ToggleGroupItem value="opus">Opus</ToggleGroupItem>
    <ToggleGroupItem value="flac">FLAC</ToggleGroupItem>
    <ToggleGroupItem value="aac">AAC</ToggleGroupItem>
  </ToggleGroup>
);

export const Multiple = () => (
  <ToggleGroup
    type="multiple"
    defaultValue={['weather', 'news']}
    style={{ justifyContent: 'flex-start' }}
  >
    <ToggleGroupItem value="weather">Weather</ToggleGroupItem>
    <ToggleGroupItem value="news">News</ToggleGroupItem>
    <ToggleGroupItem value="traffic">Traffic</ToggleGroupItem>
    <ToggleGroupItem value="curiosity">Curiosity</ToggleGroupItem>
  </ToggleGroup>
);

export const Sizes = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
    <ToggleGroup type="single" size="sm" defaultValue="day">
      <ToggleGroupItem value="day">Day</ToggleGroupItem>
      <ToggleGroupItem value="night">Night</ToggleGroupItem>
    </ToggleGroup>
    <ToggleGroup type="single" size="lg" defaultValue="night">
      <ToggleGroupItem value="day">Day</ToggleGroupItem>
      <ToggleGroupItem value="night">Night</ToggleGroupItem>
    </ToggleGroup>
  </div>
);
