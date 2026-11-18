import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { albumSourcePool } from '../album-source.js';
import { cachedPickerSource, pickerSourceAvailable } from '../source-pool-cache.js';
import { definePickerTool, toolDeadlineResult } from '../defs.js';

export default definePickerTool({
  name: 'frequentAlbums',
  available: () => pickerSourceAvailable('frequent-albums'),
  build: ({ collect, candidateLimit, emptyResult }) => tool({
    description: 'A varied sample from frequently scrobbled albums in this library. Familiar catalogue favourites, unrelated to the current track; use when the set can turn toward well-loved records. Empty on a server without album play history.',
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }: { abortSignal?: AbortSignal }) => {
      try {
        const tracksPerAlbum = candidateLimit(3);
        const rows = await cachedPickerSource(`frequent-albums:${tracksPerAlbum}`, async () => {
          const offset = Math.floor(Math.random() * 3) * 12;
          let albums = await subsonic.getFrequentAlbums({ size: 12, offset, signal: abortSignal });
          if (!albums.length && offset) albums = await subsonic.getFrequentAlbums({ size: 12, signal: abortSignal });
          return albumSourcePool(albums, abortSignal, tracksPerAlbum);
        }, 'frequent-albums', abortSignal);
        if (abortSignal?.aborted) return toolDeadlineResult('frequentAlbums');
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh tracks from frequently played albums — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
