import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import * as likes from '../../../../../broadcast/likes.js';
import * as settings from '../../../../../settings.js';
import { definePickerTool } from '../defs.js';

// A listener like can star a track in Navidrome, so the list is filtered to the
// operator's own curation before the model is told that is what it is
// (likes.operatorStarred, gated on likes.influenceDj).
export default definePickerTool({
  name: 'starredSongs',
  build: ({ collect, emptyResult }) => tool({
    description: "The operator's starred / favourite songs — a safe, on-brand pick and the right fallback when a sharper tool came back empty. Takes no seed, so choose the one that fits the moment rather than the first returned.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const starred = await subsonic.getStarred();
        await likes.load();
        const curated = likes.operatorStarred(starred, settings.get()?.likes);
        const res = collect(curated);
        return res.length ? res : emptyResult(curated.length, 'no usable starred songs right now — choose from your other tool results this round');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
