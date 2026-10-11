import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'recentlyAdded',
  build: ({ collect, emptyResult }) => tool({
    description: 'A sample of tracks from recently-added albums — "new in the crates". Takes no seed, so results are unrelated to what is on air: reach for it when the set has earned a reset, not when holding a flow.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const albums = await subsonic.getRecentlyAddedAlbums({ size: 8 });
        const newest = albums.slice(0, 5);
        const out: any[] = [];
        let failed = 0;
        for (const a of newest) {
          try { out.push(...(await subsonic.getAlbum(a.id)).slice(0, 3)); } catch { failed++; }
        }
        // Every album fetch failing is a music-server fault, not an empty
        // shelf — say so rather than answer [] (a bare [] draws a fabricated id).
        if (newest.length && failed === newest.length) {
          return { error: 'could not read the newest albums from the music server — choose from your other tool results this round' };
        }
        const res = collect(out);
        return res.length ? res : emptyResult(out.length, 'nothing usable in the newest albums right now — choose from your other tool results this round');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
