import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'sonicSimilarTracks',
  available: ({ scope }) => scope.sonicSimilarity,
  build: ({ collect, emptyResult }) => tool({
    description: 'Audio neighbours supplied by the music server’s OpenSubsonic sonicSimilarity extension. This is the server’s sonic index, independent of this station’s audio and text embedding indexes. Use a real seed track id.',
    inputSchema: z.object({ songId: z.string() }),
    execute: async ({ songId }) => {
      try {
        const list = await subsonic.getSonicSimilarTracks(songId, { count: 20 });
        const out = collect(list);
        return out.length ? out : emptyResult(list.length, 'no eligible server sonic neighbours — try another source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
