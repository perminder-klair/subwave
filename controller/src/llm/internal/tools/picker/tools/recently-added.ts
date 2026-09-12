import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'recentlyAdded',
  available: ({ sourceCaps }) => sourceCaps.hasRecentlyAdded,
  build: ({ collect }) => tool({
    description: 'A sample of tracks from recently-added albums — "new in the crates". Takes no seed, so results are unrelated to what is on air: reach for it when the set has earned a reset, not when holding a flow.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const albums = await subsonic.getRecentlyAddedAlbums({ size: 8 });
        const out: any[] = [];
        for (const a of albums.slice(0, 5)) {
          try { out.push(...(await subsonic.getAlbum(a.id)).slice(0, 3)); } catch {}
        }
        return collect(out);
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
