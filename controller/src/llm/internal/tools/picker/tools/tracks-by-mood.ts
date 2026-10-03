import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { definePickerTool } from '../defs.js';
import { cacheSourcePool } from '../source-pool-cache.js';

export default definePickerTool({
  name: 'tracksByMood',
  build: ({ collect, emptyResult }) => {
    const moodPool = cacheSourcePool(library.songsByMood);
    return tool({
      description: 'Songs carrying one of the station\'s mood tags: energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural. That list is the WHOLE vocabulary — a word outside it matches nothing rather than being interpreted, so choose the closest listed mood. Optionally narrow by energy. An empty result names which filter emptied it: "no tracks tagged X" is a coverage gap, not an empty library.',
      inputSchema: z.object({
        mood: z.string(),
        // nullable (not optional): under AI SDK v7's `tool()` an optional field
        // makes the Zod object's input/output types diverge, collapsing the
        // schema generic to `never`. nullable keeps the key required-but-`| null`
        // (symmetric), which the model fills with null to skip the filter — the
        // `if (energy)` guard below already treats null as "no filter".
        energy: z.enum(['low', 'medium', 'high']).nullable()
          .describe('Optional energy filter — narrows the result to that tempo/intensity band. Pass null for no filter.'),
      }),
      execute: async ({ mood, energy }) => {
        try {
          await library.load();
          const moodRows = moodPool(mood);
          const rows = energy ? moodRows.filter((r: any) => r.energy === energy) : moodRows;
          const out = collect(rows);
          if (out.length) return out;
          // Empty for three distinct reasons — tell the model which, so a
          // tag-coverage gap never reads as an empty library (observed:
          // {mood:"night", energy:"low"} → bare [] → fabricated id).
          if (energy && moodRows.length > 0 && rows.length === 0) {
            return emptyResult(0, `${moodRows.length} "${mood}" track(s) exist but none tagged ${energy} energy — the energy filter is what emptied this; choose from your other tool results this round`);
          }
          if (moodRows.length === 0) {
            const covered = Object.keys(library.stats().byMood || {}).join(', ');
            return emptyResult(0, covered
              ? `no tracks tagged "${mood}" — moods with coverage in this library: ${covered}`
              : `no tracks tagged "${mood}"`);
          }
          return emptyResult(rows.length, 'choose from your other tool results this round');
        }
        catch (err) { return { error: (err as Error).message }; }
      },
    });
  },
});
