import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { cachedPickerSource, pickerSourceAvailable } from '../source-pool-cache.js';
import { definePickerTool, toolDeadlineResult } from '../defs.js';

export default definePickerTool({
  name: 'similarArtistTracks',
  // A bounded global cooldown avoids spending a pass on each new seed when
  // this server supplies no artist-graph/top-song data. Re-probe after 5 min.
  available: () => pickerSourceAvailable('similar-artists:availability'),
  build: ({ collect, candidateLimit, emptyResult }) => tool({
    description: 'Top songs by neighbouring artists in the server’s similar-artist graph. Uses an artist name as its seed, rather than a song or audio vector; useful for holding an artist’s musical orbit while changing artist. Requires similar-artist and top-song data on the server.',
    inputSchema: z.object({ artist: z.string().min(1) }),
    execute: async ({ artist }, { abortSignal }: { abortSignal?: AbortSignal }) => {
      try {
        let graphProbed = false;
        const songsPerArtist = candidateLimit(5);
        const rows = await cachedPickerSource(`similar-artists:${artist.toLowerCase()}:${songsPerArtist}`, async () => {
          const matches = await subsonic.searchArtists(artist, { artistCount: 1, signal: abortSignal });
          if (!matches.length) return [];
          graphProbed = true;
          const info = await subsonic.getArtistInfo(matches[0].id, { count: 5, signal: abortSignal });
          const out: any[] = [];
          const neighbours = (info?.similarArtist ?? []).filter((artist: any) => artist.name).slice(0, 2);
          let failed = 0;
          for (const neighbour of neighbours) {
            try { out.push(...await subsonic.getTopSongs(neighbour.name, { count: songsPerArtist, signal: abortSignal })); } catch { failed++; }
          }
          abortSignal?.throwIfAborted();
          if (neighbours.length && failed === neighbours.length) throw new Error('could not read similar-artist songs from the music server');
          return out;
        }, () => graphProbed ? 'similar-artists:availability' : undefined, abortSignal);
        if (abortSignal?.aborted) return toolDeadlineResult('similarArtistTracks');
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh similar-artist top songs — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
