import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/subsonic.js';
import * as library from '../../../../../music/library.js';
import * as embeddings from '../../../../../music/embeddings.js';
import { requestedRecording, type RequestedRecording } from '../../../../../music/request-match.js';
import { definePickerTool, toolDeadlineResult } from '../defs.js';

// A query is a name, a title or a few genre/vibe words. The cap bounds what one
// call can send to Navidrome and to the embedding provider.
const QUERY_MAX_CHARS = 200;
// The artist-respelling retry runs one search3 per word, so it is only worth
// trying on something shaped like a name.
const ARTIST_RETRY_MAX_WORDS = 6;
// The raw rows Direct reads for a named title, in one page: this look-up is one
// search whatever it finds.
const ASK_ROWS = 100;
const ASK_CAP = 8;
const NO_ASK = { pinned: [] as any[], held: 0 };

// Fixed copy: neither line carries a word of the listener's.
const HELD_HINT = 'that is what the listener named: it is in the library but played too recently or is already queued, so tell them that, never that it is missing';
const NOT_LITERAL_NOTE = 'Nothing matched this search word for word, so these are only neighbours by feel. That does not prove the library lacks what was asked for: search a title or an artist alone if you can, and never tell the listener it is missing on this alone.';

export default definePickerTool({
  name: 'searchLibrary',
  build: ({ collect, candidateLimit, emptyResult, knnExclude, scope, seen }) => {
    // The run's one look-up by the listener's own words (#2195). buildPickerTools
    // builds this closure once per run, so it is spent by the first call.
    let pendingAsk = requestedRecording(scope.requestText);

    // Exact hits, in source order, for the head of the answer. searchPage has
    // already dropped blocked rows, so a blocked ask reads as not found and
    // never as held. `held` counts exact hits that are not free to air: collect
    // relaxes soft recency rather than starve, so a lone hit on cooldown or in
    // the queue comes back, and only the recency set can say so. It stays
    // offered, because the agent's cooldown and queue.push then refuse it by
    // name, as Direct refuses a named recording rather than swapping it. A
    // failed look-up costs nothing but itself: the model's own search still runs.
    const pinAsk = async (ask: RequestedRecording, signal?: AbortSignal) => {
      let exact: any[];
      try {
        const { songs } = await subsonic.searchPage(ask.query.slice(0, QUERY_MAX_CHARS), { songCount: ASK_ROWS, signal });
        exact = songs.filter((song) => ask.isExact(song));
      } catch {
        return NO_ASK;
      }
      // A parallel call in this round may have shown one already. That is the
      // model holding it, not the track being filtered.
      const unseen = exact.filter((song) => !seen.has(song.id));
      const pinned = collect(unseen, ASK_CAP, { order: 'source' });
      return { pinned, held: pinned.length ? pinned.filter((song) => scope.recentIds.has(song.id)).length : unseen.length };
    };

    return tool({
      description: 'Search the library for something NAMED — an artist, a song title, or a real genre word (e.g. "jazz", "punjabi"). Pass a title or an artist alone, never "X by Y": every word must match, so "by" alone finds nothing. Falls back to vibe search when nothing matches literally, so "punjabi r&b romantic" also works. Not for browsing by feel: a mood, an energy or "something like what\'s on now" belongs to tracksByMood, tracksByEnergy and the similarity tools, which read the station\'s own tagging instead of guessing from text.',
      inputSchema: z.object({
        query: z.string().max(QUERY_MAX_CHARS).describe('an artist name, song title, genre, or vibe'),
      }),
      execute: async ({ query }, { abortSignal }: { abortSignal?: AbortSignal }) => {
        // Claimed before the first await: parallel calls share this closure.
        const ask = pendingAsk;
        pendingAsk = null;
        try {
          const { pinned, held } = ask ? await pinAsk(ask, abortSignal) : NO_ASK;
          const heldNote = held ? emptyResult(held, HELD_HINT).note : null;
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
          const PAGE = candidateLimit(25);
          const songOffset = Math.floor(Math.random() * 3) * PAGE;
          let page = await subsonic.searchPage(query, { songCount: PAGE, songOffset, signal: abortSignal });
          if (page.rawCount < PAGE && songOffset > 0) {
            page = await subsonic.searchPage(query, { songCount: PAGE, signal: abortSignal });
          }
          let songs = page.songs;
          // A lexical miss is often just a spelling/transliteration variance —
          // resolve the query as an artist and retry with the library's actual
          // spelling ("Sikandar Kahlon" → the tagged "Sikander Kahlon"). Only for
          // a name-shaped query: the resolver searches once per word. Pointless
          // once the listener's own words have found the ask.
          if (songs.length === 0 && !pinned.length && !held && query.trim().split(/\s+/).length <= ARTIST_RETRY_MAX_WORDS) {
            const artist = await subsonic.resolveArtist(query, { signal: abortSignal });
            if (artist && !abortSignal?.aborted) songs = (await subsonic.searchPage(artist.name, { songCount: PAGE, signal: abortSignal })).songs;
          }
          if (abortSignal?.aborted) return toolDeadlineResult('searchLibrary');
          const out = [...pinned, ...collect(songs)];
          if (out.length > 0) return heldNote ? { tracks: out, note: heldNote } : out;
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
          // `via: 'vibe'` marks them either way: the request path's stand-in
          // check (#1979, util/request-claim.ts requestLookups) reads a literal
          // hit as the library's spelling of what the listener named, and a
          // neighbour by feel is not that. On the request path a pure vibe answer
          // says so in words too, because the model writes the listener's ack
          // from it and neighbours alone read as "not in the library" (#2195).
          const filteredNote = heldNote
            ?? (songs.length > 0 ? emptyResult(songs.length, 'these are the closest matches by feel instead, not literal matches for what was searched').note : null);
          if (embeddings.isAvailable()) {
            await library.load();
            const vec = await embeddings.embedQueryText(query.trim(), library.embeddingIndexTextMode(), { abortSignal });
            if (vec) {
              const sem = collect(library.tracksByVector(vec, candidateLimit(20), { excludeIds: knnExclude }));
              const note = filteredNote ?? (scope.requestText ? NOT_LITERAL_NOTE : null);
              if (sem.length > 0) return note ? { tracks: sem, note, via: 'vibe' } : { tracks: sem, via: 'vibe' };
            }
          }
          return held
            ? emptyResult(held, HELD_HINT)
            : emptyResult(songs.length, 'this search matches literal titles/artists/genres first and the vibe index found nothing — choose from your other tool results this round');
        }
        catch (err) { return { error: (err as Error).message }; }
      },
    });
  },
});
