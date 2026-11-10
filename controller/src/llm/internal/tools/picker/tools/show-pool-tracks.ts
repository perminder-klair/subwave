import { tool } from 'ai';
import { z } from 'zod';
import { definePickerTool } from '../defs.js';

// A strict-filter show whose eligible catalogue is this small is better handed
// over than searched. Above it, the ordinary discovery tools find enough and a
// full list would only spend tokens.
export const SMALL_SHOW_POOL_MAX = 150;

// How many of the eligible tracks one call returns. Bigger than the usual 8
// because on a small pool the searches mostly come back empty: this is the
// list the pick is chosen from.
const SHOW_POOL_CAP = 20;

// Registered only for a strict-filter show whose whole eligible catalogue is
// small (scope.showPool, sized by strictShowLibraryPool). Measured on a live
// station: a 49-track show answered 47 of 64 discovery calls with nothing in
// one hour, and the model spent its rounds searching for artists the library
// does not hold. Every result still passes collect(): the hard locks, length
// limits, exclusions and the recency guard, so nothing here widens the show.
export default definePickerTool({
  name: 'showPoolTracks',
  available: ({ scope }) => !!scope.showPool?.length && scope.showPool.length <= SMALL_SHOW_POOL_MAX,
  build: ({ collect, emptyResult, scope }) => {
    const pool = scope.showPool ?? [];
    return tool({
      description: `This show's strict music filters allow only ${pool.length} tracks in the whole library. Returns up to ${SHOW_POOL_CAP} of them that have not played recently, leaning toward the least recently aired. Call this first and choose from it: on a pool this small the search tools mostly return nothing. Takes no input.`,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const out = collect(pool, SHOW_POOL_CAP);
          if (out.length) return out;
          return emptyResult(pool.length, 'every track this show allows has played recently — choose from your other tool results this round');
        }
        catch (err) { return { error: (err as Error).message }; }
      },
    });
  },
});
