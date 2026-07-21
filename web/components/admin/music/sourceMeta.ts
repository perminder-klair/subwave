// Single source of truth for the music-source picker: per-source descriptors
// and a default order. Mirrors the LLM providerMeta.ts so the Settings "Music
// source" section renders the same card-grid pattern. No React, no DOM.

export type SourceKind = 'server' | 'local';

export interface SourceMeta {
  id: string;
  // Short display name on the card.
  label: string;
  // One-line descriptor under the name.
  blurb: string;
  kind: SourceKind;
}

// Order mirrors the controller's settings.MUSIC_SOURCES. The card grid renders
// data.music.sources (server-authoritative), looking each id up here, so a
// source the server adds before this map does still renders as a bare card.
export const SOURCES: SourceMeta[] = [
  { id: 'subsonic', label: 'Navidrome / Subsonic', blurb: 'Streaming server · network', kind: 'server' },
  { id: 'local',    label: 'Local folder',         blurb: 'Files on this box · no server', kind: 'local' },
  { id: 'plex',     label: 'Plex',                  blurb: 'Plex Media Server · network', kind: 'server' },
];

export const SOURCE_META: Record<string, SourceMeta> = Object.fromEntries(
  SOURCES.map(s => [s.id, s]),
);

export const SOURCE_IDS: string[] = SOURCES.map(s => s.id);
