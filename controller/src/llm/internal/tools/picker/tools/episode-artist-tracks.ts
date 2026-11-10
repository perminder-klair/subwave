import { tool } from 'ai';
import { z } from 'zod';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'episodeArtistTracks',
  available: ({ scope }) => !!scope.episodeSource,
  build: ({ scope, collect, emptyResult }) => tool({
    description: 'The prepared artist catalogue for this episode. Call this first; all automatic picks must come from this catalogue.',
    inputSchema: z.object({}),
    execute: async () => {
      const tracks = scope.episodeSource?.tracks ?? [];
      const accepted = collect(tracks, 12);
      return accepted.length ? accepted : emptyResult(tracks.length, 'The prepared artist tracks were withheld by track recency or show filters. Never invent an id.');
    },
  }),
});
