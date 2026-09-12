import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'songsByGenre',
  build: ({ collect, emptyResult }) => tool({
    description: 'Songs from a library genre tag, fuzzy-matched ("turkish" finds "Turkish Pop"). Use for language/country/style asks — "play something Turkish" — that searchLibrary cannot reach: genre lives in tags, not titles. An error means no genre matches that word (try a broader one); an empty result means the genre exists but has nothing fresh — the opposite problem.',
    inputSchema: z.object({ genre: z.string().describe('a genre, language, or country word, e.g. "jazz", "turkish", "punjabi"') }),
    execute: async ({ genre }) => {
      try {
        const name = await subsonic.resolveGenreName(genre);
        if (!name) return { error: `no library genre matching "${genre}"` };
        // Sampled: a random page of the genre, not the same server-ordered
        // head every call (see getSongsByGenreSampled).
        const list = await subsonic.getSongsByGenreSampled(name, { count: 50 });
        const out = collect(list);
        return out.length ? out : emptyResult(list.length, `the "${name}" genre has nothing fresh right now — choose from your other tool results this round`);
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
