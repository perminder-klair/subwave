// Play in order (show.playlistInOrder): the pure half of walking a show's anchor
// playlist top to bottom. One policy module because the walk is read from two
// places — the pick branch in broadcast/dj-agent.ts and the admin position peek
// in routes/shows.ts — and a second copy is how the editor's "next up" and the
// next track on air come to disagree.
//
// The ORDER is the anchor's own: music/show-playlist.ts concatenates the pinned
// playlists in playlistIds order and keeps each one's Navidrome order, deduping
// to the first occurrence. Nothing here sorts or shuffles it.

import type { PlaylistCursor } from '../schemas/playlist-cursor.js';
import { trackKey } from './recency.js';

export type { PlaylistCursor };

export type InOrderTrack = { id?: string; title?: string | null; artist?: string | null };

// The one place "inert without playlistStrict" lives for this switch. A soft
// anchor mixes other tracks in, so a running order has nothing to be true of.
// `=== true`, matching showBool()'s reading of the saved shape.
export function isInOrderShow<T extends { playlistStrict?: unknown; playlistInOrder?: unknown }>(show: T | null | undefined): show is T {
  return show?.playlistStrict === true && show?.playlistInOrder === true;
}

// Changing WHICH playlists anchor the show, or their order, restarts the walk;
// editing a playlist's contents does not. Order-sensitive on purpose — unlike
// autoPlaylistShowKey, which sorts, because here the order IS the feature.
export function anchorSignature(playlistIds: readonly unknown[] | null | undefined): string {
  return (playlistIds ?? []).filter((id): id is string => typeof id === 'string' && id !== '').join(',');
}

function identityOf(track: InOrderTrack | null | undefined): string {
  return track?.title ? trackKey(track) : '';
}

// Where the walk resumes: one past the last pick. Found by its old slot first
// (exact, and what keeps a song pinned twice from jumping back to its first
// copy), then by id, then by title|artist — the id-rotation path. A last pick
// that has since LEFT the playlist resumes AT its old slot, which its successor
// slid into. Always in [0, tracks.length).
export function resumeIndex(tracks: readonly InOrderTrack[], cursor: PlaylistCursor | null | undefined, sig: string): number {
  const n = tracks.length;
  if (!n || !cursor || cursor.sig !== sig) return 0;
  const slot = Number.isInteger(cursor.index) && cursor.index >= 0 ? cursor.index : 0;
  const isLast = (t: InOrderTrack | null | undefined) => !!t
    && ((!!cursor.lastId && t.id === cursor.lastId) || (!!cursor.lastKey && identityOf(t) === cursor.lastKey));
  if (slot < n && isLast(tracks[slot])) return (slot + 1) % n;
  const byId = cursor.lastId ? tracks.findIndex(t => t?.id === cursor.lastId) : -1;
  if (byId >= 0) return (byId + 1) % n;
  const byKey = cursor.lastKey ? tracks.findIndex(t => identityOf(t) === cursor.lastKey) : -1;
  if (byKey >= 0) return (byKey + 1) % n;
  return slot % n;
}

// The next track to air: the first ELIGIBLE one from the resume point, wrapping
// at the end (the show loops its playlist for the whole slot). At most one lap,
// so a playlist with nothing eligible answers null and the caller falls back to
// the ordinary pick paths rather than spinning. `index` is the slot in the FULL
// merged list, so a filter change never shifts the cursor.
export function nextInOrder<T extends InOrderTrack>(
  tracks: readonly T[],
  cursor: PlaylistCursor | null | undefined,
  sig: string,
  eligible: (track: T) => boolean,
): { track: T; index: number } | null {
  const n = tracks.length;
  if (!n) return null;
  const start = resumeIndex(tracks, cursor, sig);
  for (let step = 0; step < n; step++) {
    const index = (start + step) % n;
    const track = tracks[index];
    if (track && eligible(track)) return { track, index };
  }
  return null;
}

export function cursorFor(track: InOrderTrack, index: number, sig: string, at: Date = new Date()): PlaylistCursor {
  return { sig, index, lastId: String(track.id ?? ''), lastKey: identityOf(track), at: at.toISOString() };
}
