import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'recentByArtist',
  build: ({ collect, emptyResult }) => tool({
    description: 'A named artist\'s NEWEST releases in the library, latest first. Use this (not topSongsByArtist, which ranks by popularity) for "latest"/"newest"/"most recent" asks. Returns [] when the artist isn\'t in the library. Note: "latest in the library" — bounded by what has been added, not the artist\'s globally-newest release, so never present a result on air as their newest song outright.',
    inputSchema: z.object({ artist: z.string() }),
    // Keep the source list tight (newest ~6 tracks): collect() shuffles, so
    // a wide pool would let the shuffle drop the actual-newest tracks,
    // defeating "latest".
    execute: async ({ artist }) => {
      try {
        const list = await subsonic.getRecentSongsByArtist(artist, { albums: 2, count: 6 });
        // Single-artist by design — opt out of collect()'s per-artist cap.
        const out = collect(list, 8, { maxPerArtist: Infinity });
        return out.length ? out : emptyResult(list.length, 'that artist has no releases in the library — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
