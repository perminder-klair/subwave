import { tool } from 'ai';
import { z } from 'zod';
import { definePickerTool } from '../defs.js';

// Only registered when likes influence the DJ and something is liked: the
// scope carries likes.djFavourites, resolved once per pick by livePickerScope.
// The pool picker's listener-liked source was the only place likes reached a
// candidate list; this puts the same tracks in the shared registry, so both
// selection routes can surface them rather than reading titles off a prompt.
export default definePickerTool({
  name: 'listenerFavourites',
  available: ({ scope }) => !!scope.listenerFavourites?.length,
  build: ({ collect, emptyResult, scope }) => tool({
    description: 'Tracks listeners on this station have liked recently — proven crowd-pleasers. Takes no seed, so choose the one that fits the moment rather than the first returned, and keep variety: never loop the same favourites back to back.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const tracks = (scope.listenerFavourites ?? []).map((favourite) => favourite.track);
        const out = collect(tracks);
        if (out.length) return out;
        return emptyResult(tracks.length, 'every listener favourite aired recently or falls outside this pick\'s filters — choose from your other tool results this round');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
