import { tool } from 'ai';
import { z } from 'zod';
import { definePickerTool } from '../defs.js';

// Only registered when the active show is anchored to Navidrome playlist(s).
// Returns a sample of the operator's hand-picked tracks for this show. In a
// STRICT playlist show this is the only source that's guaranteed to return
// in-set tracks (every other tool is hard-intersected with the lock), so the
// agent should lead with it; in a SOFT show it's the strongly-preferred source.
export default definePickerTool({
  name: 'showPlaylistTracks',
  available: ({ scope, sourceCaps }) => sourceCaps.hasPlaylists && !!(scope.playlistTracks && scope.playlistTracks.length),
  build: ({ collect, emptyResult, scope }) => tool({
    description: "Tracks from the show's pinned playlist(s) — the operator's hand-picked selection for this show. Prefer these: call this first and choose from what it returns. Takes no input.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const playlistTracks = scope.playlistTracks ?? [];
        const out = collect(playlistTracks, 12);
        // The show's mandated source must never return a bare [] — with the
        // strict music locks also applied here, an un-tagged playlist can
        // filter to empty, and pickSystem simultaneously tells the model
        // "every pick MUST come from it". A note-less [] is the documented
        // fabrication trigger; emptyResult carries the "never invent an id"
        // rule and explains WHY (recency vs strict filters).
        if (out.length) return out;
        return emptyResult(playlistTracks.length, 'the pinned playlist tracks were all filtered out by recency or this show\'s strict music filters — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
