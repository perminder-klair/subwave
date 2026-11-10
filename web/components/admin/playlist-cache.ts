'use client';

import type { QueryClient } from '@tanstack/react-query';
import { libraryKeys } from './library/queries';
import { playlistKeys } from './playlist-builder/queries';
import { showKeys } from './shows/queries';

/**
 * `/playlists` and `/dj/playlists` expose different envelopes for the same
 * Navidrome catalogue. A write receipt is not a complete summary, so mark all
 * four route owners stale and let only currently mounted consumers refetch.
 */
export async function refreshPlaylistCatalogues(
  client: QueryClient,
  detailIds: string[] = [],
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: playlistKeys.index(), exact: true }),
    client.invalidateQueries({ queryKey: libraryKeys.playlists(), exact: true }),
    client.invalidateQueries({ queryKey: showKeys.playlists(), exact: true }),
    client.invalidateQueries({ queryKey: libraryKeys.rulePlaylists(), exact: true }),
    ...detailIds.map(id => client.invalidateQueries({
      queryKey: playlistKeys.detail(id), exact: true,
    })),
  ]);
}

/** A successful delete is complete enough to remove the row without a GET. */
export function removePlaylistFromCatalogues(client: QueryClient, id: string): void {
  const remove = <T extends { id: string }>(previous: T[] | undefined): T[] | undefined =>
    previous?.filter(item => item.id !== id);
  client.setQueryData<Array<{ id: string }>>(playlistKeys.index(), remove);
  client.setQueryData<Array<{ id: string }>>(libraryKeys.playlists(), remove);
  client.setQueryData<Array<{ id: string }>>(showKeys.playlists(), remove);
  client.setQueryData<Array<{ id: string }>>(libraryKeys.rulePlaylists(), remove);
  client.removeQueries({ queryKey: playlistKeys.detail(id), exact: true });
  // Removing this row is authoritative; summaries for surviving rows may
  // already be invalid from an earlier sync/save, so do not accidentally make
  // those old counts fresh merely because setQueryData patched the deletion.
  for (const queryKey of [
    playlistKeys.index(),
    libraryKeys.playlists(),
    showKeys.playlists(),
    libraryKeys.rulePlaylists(),
  ]) {
    void client.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
  }
}
