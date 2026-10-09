import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { albumSourcePool } from '../album-source.js';
import { cachedPickerSource, pickerSourceAvailable } from '../source-pool-cache.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'frequentAlbums',
  available: () => pickerSourceAvailable('frequent-albums'),
  build: ({ collect, emptyResult }) => tool({
    description: 'A varied sample from frequently scrobbled albums in this library. Familiar catalogue favourites, unrelated to the current track; use when the set can turn toward well-loved records. Empty on a server without album play history.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const rows = await cachedPickerSource('frequent-albums', async () => {
          const offset = Math.floor(Math.random() * 3) * 12;
          let albums = await subsonic.getFrequentAlbums({ size: 12, offset });
          if (!albums.length && offset) albums = await subsonic.getFrequentAlbums({ size: 12 });
          return albumSourcePool(albums);
        });
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh tracks from frequently played albums — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
