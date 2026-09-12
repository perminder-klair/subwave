import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'topSongsByArtist',
  available: ({ sourceCaps }) => sourceCaps.hasTopSongs,
  build: ({ collect, emptyResult }) => tool({
    description: 'A named artist\'s best-known songs, ranked by popularity — good for staying in an artist\'s orbit without repeating a track. For "latest"/"newest" asks use recentByArtist instead: this ranks by plays, so it tends to return the same catalogue staples every time.',
    inputSchema: z.object({ artist: z.string() }),
    execute: async ({ artist }) => {
      try {
        const list = await subsonic.getTopSongs(artist, { count: 15 });
        // Single-artist by design — opt out of collect()'s per-artist cap.
        const out = collect(list, 8, { maxPerArtist: Infinity });
        return out.length ? out : emptyResult(list.length, 'no top-songs data for that artist — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
