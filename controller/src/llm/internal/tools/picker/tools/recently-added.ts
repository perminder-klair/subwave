import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { albumSourcePool } from '../album-source.js';
import { cachedPickerSource, pickerSourceAvailable } from '../source-pool-cache.js';
import { definePickerTool, toolDeadlineResult } from '../defs.js';

export default definePickerTool({
  name: 'recentlyAdded',
  available: () => pickerSourceAvailable('recent-albums'),
  build: ({ collect, candidateLimit, emptyResult }) => tool({
    description: 'A sample of tracks from recently-added albums — "new in the crates". Takes no seed, so results are unrelated to what is on air: reach for it when the set has earned a reset, not when holding a flow.',
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }: { abortSignal?: AbortSignal }) => {
      try {
        const tracksPerAlbum = candidateLimit(3);
        const rows = await cachedPickerSource(`recent-albums:${tracksPerAlbum}`, async () =>
          albumSourcePool(await subsonic.getRecentlyAddedAlbums({ size: 12, signal: abortSignal }), abortSignal, tracksPerAlbum), 'recent-albums', abortSignal);
        if (abortSignal?.aborted) return toolDeadlineResult('recentlyAdded');
        const out = collect(rows);
        return out.length ? out : emptyResult(rows.length, 'no fresh recently-added tracks — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
