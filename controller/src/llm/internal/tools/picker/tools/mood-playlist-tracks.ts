import { tool } from 'ai';
import { allowsMoodPlaylistDiscovery } from '../../../../../music/discovery-policy.js';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { shuffle } from '../../../../../util/shuffle.js';
import { cachedPickerSource, pickerSourceAvailable } from '../source-pool-cache.js';
import { definePickerTool, toolDeadlineResult } from '../defs.js';

export default definePickerTool({
  name: 'moodPlaylistTracks',
  // A pinned show playlist owns this lane, even if its IDs failed to resolve.
  available: ({ scope }) => allowsMoodPlaylistDiscovery(scope) && pickerSourceAvailable('mood-playlists'),
  build: ({ collect, emptyResult }) => tool({
    description: 'Tracks from up to two Navidrome playlists whose names contain the supplied mood. A curated mood source, distinct from library mood tags. Unavailable when the show pins its own playlists; never substitutes another show’s playlist for that anchor.',
    inputSchema: z.object({ mood: z.string().min(1) }),
    execute: async ({ mood }, { abortSignal }: { abortSignal?: AbortSignal }) => {
      try {
        const playlists = await cachedPickerSource('mood-playlists', () => subsonic.getPlaylists({ signal: abortSignal }), undefined, abortSignal);
        const matched = shuffle(playlists.filter(p => p.name?.toLowerCase().includes(mood.toLowerCase()))).slice(0, 2);
        const rows: any[] = [];
        for (const playlist of matched) {
          abortSignal?.throwIfAborted();
          try { rows.push(...await cachedPickerSource(`mood-playlist:${playlist.id}`, () => subsonic.getPlaylist(playlist.id, { signal: abortSignal }), undefined, abortSignal)); } catch { /* Try the other playlist. */ }
        }
        if (abortSignal?.aborted) return toolDeadlineResult('moodPlaylistTracks');
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh tracks in mood-named playlists — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
