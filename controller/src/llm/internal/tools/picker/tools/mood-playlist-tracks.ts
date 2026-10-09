import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { shuffle } from '../../../../../util/shuffle.js';
import { cachedPickerSource, pickerSourceAvailable } from '../source-pool-cache.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'moodPlaylistTracks',
  // A pinned show playlist owns this lane, even if its IDs failed to resolve.
  available: ({ scope }) => !scope.hasPlaylistAnchor && !scope.playlistTracks?.length && !scope.playlistLock && pickerSourceAvailable('mood-playlists'),
  build: ({ collect, emptyResult }) => tool({
    description: 'Tracks from up to two Navidrome playlists whose names contain the supplied mood. A curated mood source, distinct from library mood tags. Unavailable when the show pins its own playlists; never substitutes another show’s playlist for that anchor.',
    inputSchema: z.object({ mood: z.string().min(1) }),
    execute: async ({ mood }) => {
      try {
        const playlists = await cachedPickerSource('mood-playlists', () => subsonic.getPlaylists());
        const matched = shuffle(playlists.filter(p => p.name?.toLowerCase().includes(mood.toLowerCase()))).slice(0, 2);
        const rows: any[] = [];
        for (const playlist of matched) {
          try { rows.push(...await cachedPickerSource(`mood-playlist:${playlist.id}`, () => subsonic.getPlaylist(playlist.id))); } catch { /* Try the other playlist. */ }
        }
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh tracks in mood-named playlists — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
