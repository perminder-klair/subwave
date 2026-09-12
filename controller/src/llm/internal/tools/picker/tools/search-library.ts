import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import * as library from '../../../../../music/library.js';
import * as embeddings from '../../../../../music/embeddings.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'searchLibrary',
  build: ({ collect, emptyResult, knnExclude }) => tool({
    description: 'Search the library for something NAMED — an artist, a song title, or a real genre word (e.g. "jazz", "punjabi"). Falls back to vibe search when nothing matches literally, so "punjabi r&b romantic" also works. Not for browsing by feel: a mood, an energy or "something like what\'s on now" belongs to tracksByMood, tracksByEnergy and the similarity tools, which read the station\'s own tagging instead of guessing from text.',
    inputSchema: z.object({
      query: z.string().describe('an artist name, song title, genre, or vibe'),
    }),
    execute: async ({ query }) => {
      try {
        // Random page (0/25/50) of the relevance ranking, mirroring
        // routes/request.ts — first-page-only made result 26+ of any query
        // unreachable, so repeated searches for the same broad term always
        // surfaced the same 25 songs.
        //
        // A deep page is only safe on a BROAD term. This tool's job is finding
        // something NAMED, so on a narrow result set a deep page is the
        // relevance TAIL: search "Karan Aujla" on a library holding 40 of that
        // artist's tracks, roll offset 25, and the model gets 15 low-relevance
        // hits — often other artists' tracks that merely mention the name — as
        // the whole basis for the pick, since on a forced-tool provider this is
        // its ONE discovery call. Falling back only on a completely EMPTY page
        // missed that: 26–75 results took the tail two thirds of the time.
        //
        // A SHORT page is the signal. A full page means at least offset+25
        // results exist (a genuinely broad term, where the deep page is
        // legitimately diverse); anything less means we ran off the end of a
        // narrow set and page 0 is the right answer. Costs one extra call only
        // in that case.
        const PAGE = 25;
        const songOffset = Math.floor(Math.random() * 3) * PAGE;
        let songs = await subsonic.search(query, { songCount: PAGE, songOffset });
        if (songs.length < PAGE && songOffset > 0) {
          songs = await subsonic.search(query, { songCount: PAGE });
        }
        // A lexical miss is often just a spelling/transliteration variance —
        // resolve the query as an artist and retry with the library's actual
        // spelling ("Sikandar Kahlon" → the tagged "Sikander Kahlon").
        if (songs.length === 0) {
          const artist = await subsonic.resolveArtist(query);
          if (artist) songs = await subsonic.search(artist.name, { songCount: 25 });
        }
        const out = collect(songs);
        if (out.length > 0) return out;
        // Lexical search3 found nothing — fall back to semantic embedding
        // search over the library (same path as searchByLyrics) so vibe
        // queries still return tracks. No-op when embeddings aren't set up.
        if (embeddings.isAvailable()) {
          await library.load();
          const vec = await embeddings.embedQueryText(query.trim(), library.embeddingIndexTextMode());
          if (vec) {
            const sem = collect(library.tracksByVector(vec, 20, { excludeIds: knnExclude }));
            if (sem.length > 0) return sem;
          }
        }
        return emptyResult(songs.length, 'this search matches literal titles/artists/genres first and the vibe index found nothing — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
