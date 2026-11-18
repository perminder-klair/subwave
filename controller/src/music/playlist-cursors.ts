// Play in order: the durable per-show position (state/playlist-cursors.json).
// The walk is music/playlist-order.ts; this module only remembers where it got.
//
// Kept OUTSIDE library.db on purpose, as the blocklist is: a library reset wipes
// that database and must not send every in-order show back to track 1.
//
// The cursor advances when a pick is QUEUED, not when it airs (the pick branch
// in broadcast/dj-agent.ts commits after queue.push succeeds). So a pushed track
// Liquidsoap then fails to resolve is already behind the walk and the re-pick
// moves on instead of retrying a broken file forever. The cost, accepted: an
// upcoming item the operator deletes counts as played.

import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../util/atomic-file.js';
import {
  playlistCursorStoreSchema,
  PLAYLIST_CURSOR_STORE_MAX,
  type PlaylistCursor,
} from '../schemas/playlist-cursor.js';

export function createPlaylistCursorStore({ file, knownShowIds }: {
  file: string;
  // Live show ids. A cursor for a show that no longer exists is pruned on the
  // next write — DELETE /shows/:id has no hook into this store.
  knownShowIds: () => Iterable<string>;
}) {
  let cursors = new Map<string, PlaylistCursor>();
  let loaded: Promise<void> | null = null;
  let pendingMutation = Promise.resolve();

  // Order the whole mutation, including mkdir, so an earlier operation cannot
  // submit an old snapshot after a later reset or commit has reached disk.
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pendingMutation.then(operation);
    pendingMutation = next.then(() => undefined, () => undefined);
    return next;
  };

  const load = () => loaded ??= (async () => {
    try {
      const stored = playlistCursorStoreSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      cursors = new Map(Object.entries(stored.cursors));
    } catch (error) {
      // Missing = no show has played in order yet. Corrupt = start every show
      // from the top rather than refuse to pick; the next write replaces it.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        console.warn(`[playlist-cursors] unreadable ${file} — in-order shows restart from the top: ${(error as Error)?.message}`);
      }
    }
  })();

  const persist = async (next: Map<string, PlaylistCursor>) => {
    const known = new Set(knownShowIds());
    const kept = [...next].filter(([id]) => known.has(id)).slice(-PLAYLIST_CURSOR_STORE_MAX);
    cursors = new Map(kept);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify({ version: 1, cursors: Object.fromEntries(kept) }, null, 2));
  };

  return {
    load,
    async get(showId: string): Promise<PlaylistCursor | null> {
      await load();
      return cursors.get(showId) ?? null;
    },
    commit(showId: string, cursor: PlaylistCursor): Promise<void> {
      return mutate(async () => {
        await load();
        const next = new Map(cursors);
        // Re-insert so the newest cursor sits last and survives the cap.
        next.delete(showId);
        next.set(showId, cursor);
        await persist(next);
      });
    },
    // Back to the top: the next pick is the first eligible track.
    reset(showId: string): Promise<boolean> {
      return mutate(async () => {
        await load();
        if (!cursors.has(showId)) return false;
        const next = new Map(cursors);
        next.delete(showId);
        await persist(next);
        return true;
      });
    },
  };
}
