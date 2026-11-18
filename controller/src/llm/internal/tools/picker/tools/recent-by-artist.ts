import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'recentByArtist',
  build: ({ collect, candidateLimit, emptyResult }) => tool({
    description: 'A named artist\'s NEWEST releases in the library, latest first. Use this (not topSongsByArtist, which ranks by popularity) for "latest"/"newest"/"most recent" asks. Returns [] when the artist isn\'t in the library. Note: "latest in the library" — bounded by what has been added, not the artist\'s globally-newest release, so never present a result on air as their newest song outright.',
    inputSchema: z.object({ artist: z.string() }),
    // Strict locks need a wider shelf; collect keeps release order through the
    // filters and cap so older eligible releases cannot displace the newest.
    execute: async ({ artist }) => {
      try {
        const list = await subsonic.getRecentSongsByArtist(artist, { albums: candidateLimit(2), count: candidateLimit(6) });
        // Single-artist by design — opt out of collect()'s per-artist cap.
        const out = collect(list, 8, { maxPerArtist: Infinity, order: 'source' });
        return out.length ? out : emptyResult(list.length, 'that artist has no releases in the library — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
