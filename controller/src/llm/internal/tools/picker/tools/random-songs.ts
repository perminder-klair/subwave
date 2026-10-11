import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'randomSongs',
  build: ({ collect, emptyResult }) => tool({
    description: 'A random sample from the whole library — a legitimate variety move, not a last resort: use it to break a run that has become predictable, or to reach shelves the similarity tools never surface. Unfiltered by mood, genre or flow, so pick the track that fits the moment rather than the first one back; for unaired material specifically, deepCuts is the sharper tool.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const songs = await subsonic.getRandomSongs({ size: 18 });
        const res = collect(songs);
        return res.length ? res : emptyResult(songs.length, 'this random draw came back with nothing usable — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
