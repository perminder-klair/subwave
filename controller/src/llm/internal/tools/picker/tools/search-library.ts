import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import * as library from '../../../../../music/library.js';
import * as embeddings from '../../../../../music/embeddings.js';
import { definePickerTool, toolDeadlineResult } from '../defs.js';

// A query is a name, a title or a few genre/vibe words. The cap bounds what one
// call can send to Navidrome and to the embedding provider.
const QUERY_MAX_CHARS = 200;
// The artist-respelling retry runs one search3 per word, so it is only worth
// trying on something shaped like a name.
const ARTIST_RETRY_MAX_WORDS = 6;

export default definePickerTool({
  name: 'searchLibrary',
  build: ({ collect, emptyResult, knnExclude }) => tool({
    description: 'Search the library for something NAMED — an artist, a song title, or a real genre word (e.g. "jazz", "punjabi"). Falls back to vibe search when nothing matches literally, so "punjabi r&b romantic" also works. Not for browsing by feel: a mood, an energy or "something like what\'s on now" belongs to tracksByMood, tracksByEnergy and the similarity tools, which read the station\'s own tagging instead of guessing from text.',
    inputSchema: z.object({
      query: z.string().max(QUERY_MAX_CHARS).describe('an artist name, song title, genre, or vibe'),
    }),
    execute: async ({ query }, { abortSignal }: { abortSignal?: AbortSignal }) => {
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
        // in that case. Counted on the RAW page: the blocklist and archive
        // filters run inside the search, so one blocked track on a full page
        // would otherwise read as a short one and pin page 0 again.
        //
        // abortSignal is the agent's per-tool timeout. It rides every Navidrome
        // call below, and each step checks it, so a run that has moved on stops
        // here instead of finishing its searches in the background.
        const PAGE = 25;
        const songOffset = Math.floor(Math.random() * 3) * PAGE;
        let page = await subsonic.searchPage(query, { songCount: PAGE, songOffset, signal: abortSignal });
        if (page.rawCount < PAGE && songOffset > 0) {
          page = await subsonic.searchPage(query, { songCount: PAGE, signal: abortSignal });
        }
        let songs = page.songs;
        // A lexical miss is often just a spelling/transliteration variance —
        // resolve the query as an artist and retry with the library's actual
        // spelling ("Sikandar Kahlon" → the tagged "Sikander Kahlon"). Only for
        // a name-shaped query: the resolver searches once per word.
        if (songs.length === 0 && query.trim().split(/\s+/).length <= ARTIST_RETRY_MAX_WORDS) {
          const artist = await subsonic.resolveArtist(query, { signal: abortSignal });
          if (artist && !abortSignal?.aborted) songs = (await subsonic.searchPage(artist.name, { songCount: 25, signal: abortSignal })).songs;
        }
        if (abortSignal?.aborted) return toolDeadlineResult('searchLibrary');
        const out = collect(songs);
        if (out.length > 0) return out;
        // Nothing usable from search3 — fall back to semantic embedding search
        // over the library (same path as searchByLyrics) so vibe queries still
        // return tracks. No-op when embeddings aren't set up.
        //
        // Two different situations reach here, and the model must be able to
        // tell them apart: search3 found NOTHING (a vibe query), or it found the
        // named track(s) and every one was filtered — played recently, already
        // shown, or outside a strict show. In the second case vibe neighbours
        // are lookalikes, not the thing that was named, so they carry the same
        // note emptyResult would give; on the request path that is what lets
        // the DJ say "that one just played" instead of substituting silently.
        const filteredNote = songs.length > 0 ? emptyResult(songs.length, 'these are the closest matches by feel instead, not literal matches for what was searched').note : null;
        if (embeddings.isAvailable()) {
          await library.load();
          const vec = await embeddings.embedQueryText(query.trim(), library.embeddingIndexTextMode(), { abortSignal });
          if (vec) {
            const sem = collect(library.tracksByVector(vec, 20, { excludeIds: knnExclude }));
            if (sem.length > 0) return filteredNote ? { tracks: sem, note: filteredNote } : sem;
          }
        }
        return emptyResult(songs.length, 'this search matches literal titles/artists/genres first and the vibe index found nothing — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
