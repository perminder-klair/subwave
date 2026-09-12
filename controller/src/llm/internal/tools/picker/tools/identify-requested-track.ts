import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../../../music/source.js';
import { searchWeb, searchReady } from '../../../../../skills/web-search.js';
import { identifyTrackFromText } from '../../../prompts/request.js';
import { definePickerTool } from '../defs.js';

// Request path only, and only when a web-search provider is ready. Resolves a
// listener's DESCRIPTION of a track (not a name) to songs in the LOCAL library:
// it looks the description up on the web, identifies the most likely single
// song, then searches Navidrome for it. Every returned candidate goes through
// collect() like any other tool, so the chosen id is always real — web text only
// steers which library tracks surface, never the id space.
export default definePickerTool({
  name: 'identifyRequestedTrack',
  available: ({ scope }) => scope.resolveReferences && searchReady(),
  build: ({ collect }) => tool({
    description: 'Use when a listener DESCRIBES a track instead of naming it, OR pastes SONG LYRICS — e.g. "the song from the new Dune movie", "the one all over TikTok", or a block of lyrics in any language. Looks the text up on the web, identifies the song, and returns matching tracks FROM THIS LIBRARY. Use this (not searchLibrary) when the request looks like lyrics — repeated phrases, verse structure, non-English text that is not an artist/title; when they name an artist or title outright, use searchLibrary. (searchByLyrics finds songs ABOUT a theme — this identifies the one specific song.) Returns { identified, candidates }: even when candidates is empty, `identified` tells you what the reference meant, so you can own the miss in your ack or choose a fitting stand-in from your other results.',
    inputSchema: z.object({
      reference: z.string().min(3).describe("the listener's description of the track, verbatim"),
    }),
    execute: async ({ reference }) => {
      try {
        const web = await searchWeb(reference); // cached 30 min
        const blob = [web.answer, ...web.results.map((r) => `${r.title}: ${r.content}`)]
          .filter(Boolean).join('\n').slice(0, 2000);
        if (!blob) return { error: 'no web result for that reference' };

        const guess = await identifyTrackFromText(reference, blob);
        if (!guess) return { error: 'could not identify a specific song from that description' };

        // Resolve LOCALLY via the same path searchLibrary uses, so every id
        // lands in `seen`. Try "artist title", then a resolved-artist retry
        // (spelling/transliteration), then title-only.
        const q = [guess.artist, guess.title].filter(Boolean).join(' ');
        let songs = await subsonic.search(q, { songCount: 25 });
        if (songs.length === 0 && guess.artist) {
          const a = await subsonic.resolveArtist(guess.artist);
          if (a) songs = await subsonic.search(`${a.name} ${guess.title}`, { songCount: 25 });
        }
        if (songs.length === 0) songs = await subsonic.search(guess.title, { songCount: 25 });
        if (songs.length === 0 && guess.keyword && guess.keyword !== guess.title) {
          songs = await subsonic.search(guess.keyword, { songCount: 25 });
        }
        return { identified: guess, candidates: collect(songs) };
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
