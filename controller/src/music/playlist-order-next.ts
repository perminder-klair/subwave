// Play in order: the impure half — resolve a show's anchor, the part of it that
// can air, and its saved position into the next track. Shared by the pick branch
// (broadcast/dj-agent.ts) and the editor's position peek (routes/shows.ts), so
// "next up" in the admin and the next pick on air are one computation.

import { join } from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds } from './show-playlist.js';
import { airableAnchorTracks } from './show-recency.js';
import { resolveStrictGenres } from './picker.js';
import { anchorSignature, cursorFor, isInOrderShow, nextInOrder } from './playlist-order.js';
import { createPlaylistCursorStore } from './playlist-cursors.js';

export const playlistCursors = createPlaylistCursorStore({
  file: join(config.stateDir, 'playlist-cursors.json'),
  knownShowIds: () => (settings.get().shows ?? []).map((s: any) => s?.id).filter(Boolean),
});

export type InOrderNext =
  | { ok: true; track: any; index: number; total: number; sig: string; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

// `busyIds` are tracks already queued or on air (queue.queuedIds()). They are
// stepped over rather than picked, because queue.push() would refuse them as
// duplicates (#619) — after a link had already been written for them.
//
// Blocked tracks never reach here: subsonic.getPlaylist already drops them. What
// is applied here are the show's own hard filters, through the SAME
// airableAnchorTracks the no-repeat guard counts with.
export async function resolveInOrderNext(
  show: any,
  { busyIds = new Set<string>() }: { busyIds?: ReadonlySet<string> } = {},
): Promise<InOrderNext> {
  if (!isInOrderShow(show) || !show?.id) return { ok: false, reason: 'not an in-order show', warnings: [] };
  const pool = await resolveShowPlaylistPool(show);
  if (!pool) return { ok: false, reason: 'its anchor playlist(s) resolved to no tracks', warnings: [] };
  const excludedIds = await resolveExcludedPlaylistIds(show);
  const { genres, warnings } = await resolveStrictGenres({ strict: !!show.filtersStrict, genres: show.genres ?? [] });
  const airable = airableAnchorTracks(pool.tracks, {
    show,
    excludedIds,
    resolvedGenres: genres,
    minTrackSec: settings.effectiveMinTrackSec(show),
    maxTrackSec: settings.effectiveTrackLengthLimits(show).selectionMaxSec,
  });
  if (!airable.length) {
    return { ok: false, reason: 'no track in its anchor passes the show\'s filters (exclusions, length limits, strict locks)', warnings };
  }
  const airableIds = new Set<string>(airable.map(t => t.id));
  const sig = anchorSignature(show.playlistIds);
  const cursor = await playlistCursors.get(show.id);
  const next = nextInOrder(pool.tracks, cursor, sig, t => airableIds.has(t.id) && !busyIds.has(t.id));
  if (!next) return { ok: false, reason: 'every eligible anchor track is already queued or on air', warnings };
  return { ok: true, track: next.track, index: next.index, total: pool.tracks.length, sig, warnings };
}

export function commitInOrderPick(showId: string, track: any, index: number, sig: string): Promise<void> {
  return playlistCursors.commit(showId, cursorFor(track, index, sig));
}
