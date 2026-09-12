import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'similarSongs',
  available: ({ sourceCaps }) => sourceCaps.hasSimilar,
  build: ({ collect, emptyResult }) => tool({
    description: 'Songs the MUSIC SERVER considers similar to a seed track — from artist/genre relationships and listening data, not from the audio or the lyrics. Pass the currently-playing song id to keep the flow going. Works on any track, so it is the fallback when the sharper axes (tracksLikeThis, tracksThatSoundLikeThis) have no vector for the seed. Empty means no similarity data for THAT track, not a thin library.',
    inputSchema: z.object({ songId: z.string() }),
    execute: async ({ songId }) => {
      try {
        const list = await subsonic.getSimilarSongs(songId, { count: 20 });
        const out = collect(list);
        return out.length ? out : emptyResult(list.length, 'no similarity data for that track — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
