import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { definePickerTool } from '../defs.js';
import { cacheSourcePool } from '../source-pool-cache.js';

export default definePickerTool({
  name: 'tracksByMood',
  build: ({ collect, emptyResult }) => {
    const moodPool = cacheSourcePool((mood: string) => {
      const rows = library.songsByMood(mood);
      return rows;
    });
    return tool({
      description: 'Songs carrying one of the station\'s mood tags: energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural. That list is the WHOLE vocabulary — a word outside it matches nothing rather than being interpreted, so choose the closest listed mood. Optionally prefer an energy band; other tracks in the same mood fill remaining slots, under all show restrictions. An empty result names which filter emptied it: "no tracks tagged X" is a coverage gap, not an empty library.',
      inputSchema: z.object({
        mood: z.string(),
        // nullable (not optional): under AI SDK v7's `tool()` an optional field
        // makes the Zod object's input/output types diverge, collapsing the
        // schema generic to `never`. nullable keeps the key required-but-`| null`
        // (symmetric), which the model fills with null to skip the filter — the
        // collector below treats null as "no preference".
        energy: z.enum(['low', 'medium', 'high']).nullable()
          .describe('Optional energy preference — prefer that band, filling remaining slots from this mood. Strict show energy restrictions still apply. Pass null for no preference.'),
      }),
      execute: async ({ mood, energy }) => {
        try {
          await library.load();
          const moodRows = moodPool(mood);
          const out = collect(moodRows, 8, { preferredEnergy: energy ?? undefined });
          if (out.length) return out;
          if (moodRows.length === 0) {
            const covered = Object.keys(library.stats().byMood || {}).join(', ');
            return emptyResult(0, covered
              ? `no tracks tagged "${mood}" — moods with coverage in this library: ${covered}`
              : `no tracks tagged "${mood}"`);
          }
          return emptyResult(moodRows.length, 'choose from your other tool results this round');
        }
        catch (err) { return { error: (err as Error).message }; }
      },
    });
  },
});
