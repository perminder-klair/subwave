import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { definePickerTool } from '../defs.js';
import { cacheSourcePool } from '../source-pool-cache.js';

export default definePickerTool({
  name: 'tracksByEnergy',
  build: ({ collect, emptyResult }) => {
    const energyPool = cacheSourcePool(library.songsByEnergy);
    return tool({
      description: 'Songs at an energy level, ignoring mood entirely: low (slow/mellow), medium (mid-tempo), high (uptempo/driving). Use it to steer the room — high to lift a set, low to bring it down. For a feel AND a pace, tracksByMood takes an energy filter and returns the intersection in one call.',
      inputSchema: z.object({ energy: z.enum(['low', 'medium', 'high']) }),
      execute: async ({ energy }) => {
        try {
          await library.load();
          const list = energyPool(energy);
          const out = collect(list);
          return out.length ? out : emptyResult(list.length, `no ${energy}-energy tracks available — choose from your other tool results this round`);
        }
        catch (err) { return { error: (err as Error).message }; }
      },
    });
  },
});
