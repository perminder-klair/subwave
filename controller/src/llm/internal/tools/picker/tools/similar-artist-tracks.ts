import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { cachedPickerSource } from '../source-pool-cache.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'similarArtistTracks',
  build: ({ collect, emptyResult }) => tool({
    description: 'Top songs by neighbouring artists in the server’s similar-artist graph. Uses an artist name as its seed, rather than a song or audio vector; useful for holding an artist’s musical orbit while changing artist. Requires similar-artist and top-song data on the server.',
    inputSchema: z.object({ artist: z.string().min(1) }),
    execute: async ({ artist }) => {
      try {
        const rows = await cachedPickerSource(`similar-artists:${artist.toLowerCase()}`, async () => {
          const matches = await subsonic.searchArtists(artist, { artistCount: 1 });
          if (!matches.length) return [];
          const info = await subsonic.getArtistInfo(matches[0].id, { count: 5 });
          const out: any[] = [];
          for (const neighbour of (info?.similarArtist ?? []).slice(0, 2)) {
            if (!neighbour.name) continue;
            try { out.push(...await subsonic.getTopSongs(neighbour.name, { count: 5 })); } catch { /* Other neighbours can still contribute. */ }
          }
          return out;
        });
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh similar-artist top songs — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
