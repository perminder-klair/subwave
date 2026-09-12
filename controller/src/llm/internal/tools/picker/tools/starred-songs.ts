import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'starredSongs',
  available: ({ sourceCaps }) => sourceCaps.hasStarred,
  build: ({ collect }) => tool({
    description: "The operator's starred / favourite songs — a safe, on-brand pick and the right fallback when a sharper tool came back empty. Takes no seed, so choose the one that fits the moment rather than the first returned.",
    inputSchema: z.object({}),
    execute: async () => {
      try { return collect(await subsonic.getStarred()); }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
