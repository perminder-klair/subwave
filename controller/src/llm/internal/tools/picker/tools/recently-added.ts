import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { albumSourcePool } from '../album-source.js';
import { cachedPickerSource, pickerSourceAvailable } from '../source-pool-cache.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'recentlyAdded',
  available: () => pickerSourceAvailable('recent-albums'),
  build: ({ collect, emptyResult }) => tool({
    description: 'A sample of tracks from recently-added albums — "new in the crates". Takes no seed, so results are unrelated to what is on air: reach for it when the set has earned a reset, not when holding a flow.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const rows = await cachedPickerSource('recent-albums', async () =>
          albumSourcePool(await subsonic.getRecentlyAddedAlbums({ size: 12 })));
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh recently-added tracks — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
