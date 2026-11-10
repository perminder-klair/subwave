import { z } from 'zod';

// Play in order (show.playlistInOrder): where each show's walk through its
// anchor playlist has got to. Persisted to state/playlist-cursors.json by
// music/playlist-cursors.ts; the walk itself is music/playlist-order.ts.
//
// The cursor names the LAST PICKED anchor track, never the next one, so an edit
// to the playlist between airings resolves against what actually went out: the
// walk finds that track again and steps past it.
export const playlistCursorSchema = z.object({
  // The anchor this position belongs to (playlistIds, in order). A different
  // anchor restarts the walk at the top.
  sig: z.string().max(2000),
  // Slot of the last pick in the merged anchor list.
  index: z.number().int().min(0),
  lastId: z.string().max(256),
  // title|artist — what finds the last pick again after a Navidrome id
  // rotation, which no remap hook reaches.
  lastKey: z.string().max(1000),
  // ISO time of the pick. Diagnostics only.
  at: z.string().max(64),
});

// Keyed by show id. Bounded because a show deletion has no cleanup hook — the
// store prunes unknown ids on write, and the cap is the backstop.
export const PLAYLIST_CURSOR_STORE_MAX = 500;

export const playlistCursorStoreSchema = z.object({
  version: z.literal(1),
  cursors: z.record(z.string().min(1).max(64), playlistCursorSchema)
    .refine(c => Object.keys(c).length <= PLAYLIST_CURSOR_STORE_MAX, `at most ${PLAYLIST_CURSOR_STORE_MAX} cursors`),
});

export type PlaylistCursor = z.output<typeof playlistCursorSchema>;
export type PlaylistCursorStore = z.output<typeof playlistCursorStoreSchema>;
