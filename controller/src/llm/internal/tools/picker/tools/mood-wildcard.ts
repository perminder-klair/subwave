import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { shuffle } from '../../../../../util/shuffle.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'moodWildcard',
  available: ({ stats }) => Object.values(stats.byMood ?? {}).some(count => Number(count) > 0),
  build: ({ collect, emptyResult, stats }) => tool({
    description: 'A small discovery detour into another covered library mood, excluding the current mood choices. For autonomous programming that has earned a change of mood; the Shortlist does not plan this detour when a show explicitly pins its moods. All show restrictions still apply.',
    inputSchema: z.object({ excludeMoods: z.array(z.string()) }),
    execute: async ({ excludeMoods }) => {
      try {
        await library.load();
        const excluded = new Set(excludeMoods.map(mood => mood.toLowerCase()));
        const choices = shuffle(Object.entries(stats.byMood ?? {})
          .filter(([mood, count]) => Number(count) > 0 && !excluded.has(mood.toLowerCase())).map(([mood]) => mood));
        if (!choices.length) return emptyResult(0, 'no other covered moods — choose another discovery source');
        const rows = library.songsByMood(choices[0]);
        const out = collect(rows, 3);
        return out.length ? out : emptyResult(rows.length, 'the alternative mood has no fresh eligible tracks — choose another discovery source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
