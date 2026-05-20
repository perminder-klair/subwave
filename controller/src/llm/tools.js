// AI SDK tool library — music-discovery tools the picker agent calls to
// explore the library before choosing the next track.
//
// Each tool returns a slim song list ({ id, title, artist, album, year,
// genre }) so the model has stable ids to reference. `buildPickerTools`
// returns a `seen` Map that accumulates every song any tool surfaced, so the
// picker can resolve the agent's chosen id back to a full track object.

import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../music/subsonic.js';
import * as library from '../music/library.js';

function slim(s) {
  return {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album || null,
    year: s.year || null,
    genre: s.genre || null,
  };
}

function artistKey(s) {
  return (s.artist || '').toLowerCase().trim();
}

// Most songs by any one artist allowed across a whole pick, mirroring
// music/picker.js's MAX_PER_ARTIST — keeps a deep catalogue artist from
// flooding the candidate pool just because random/search keeps surfacing them.
const MAX_PER_ARTIST = 3;

// Builds a fresh tool set scoped to one pick. `recentIds` (recently-played
// song ids) and `recentArtists` (lowercased recently-played artist names) are
// filtered out inside every tool so the agent never has to be told "avoid
// these" — it simply can't see them. `recentArtists` is left empty on the
// listener-request path so a request for a recent artist still resolves.
export function buildPickerTools({ recentIds = new Set(), recentArtists = new Set() } = {}) {
  const seen = new Map(); // id → slim song, accumulated across all tool calls
  const artistCounts = new Map(); // artist key → songs already accepted into `seen`

  // Filter recents, slim, and record into `seen` so the picker can resolve
  // the agent's final id choice to a full track. Drops songs by an artist that
  // played in the recent window, and caps any one artist's share of the pool.
  // cap=8 (down from 12) keeps per-tool input tokens lower for the picker
  // agent — see picker-latency notes in dj-agent.js. The seen map still
  // accumulates across the whole loop, so the agent's id space grows with
  // each tool call regardless.
  const collect = (list, cap = 8) => {
    const out = [];
    for (const s of list || []) {
      if (!s?.id || recentIds.has(s.id) || seen.has(s.id)) continue;
      const key = artistKey(s);
      if (key && recentArtists.has(key)) continue;
      if (key) {
        const n = artistCounts.get(key) || 0;
        if (n >= MAX_PER_ARTIST) continue;
        artistCounts.set(key, n + 1);
      }
      const slimmed = slim(s);
      seen.set(s.id, slimmed);
      out.push(slimmed);
      if (out.length >= cap) break;
    }
    return out;
  };

  const tools = {
    searchLibrary: tool({
      description: 'Search the music library by artist name, song title, or real genre (e.g. "jazz", "punjabi"). Returns matching songs.',
      inputSchema: z.object({
        query: z.string().describe('an artist name, song title, or genre'),
      }),
      execute: async ({ query }) => {
        try { return collect(await subsonic.search(query, { songCount: 25 })); }
        catch (err) { return { error: err.message }; }
      },
    }),

    similarSongs: tool({
      description: 'Find songs similar to a given song id. Pass the currently-playing song id to keep the flow going.',
      inputSchema: z.object({ songId: z.string() }),
      execute: async ({ songId }) => {
        try { return collect(await subsonic.getSimilarSongs(songId, { count: 20 })); }
        catch (err) { return { error: err.message }; }
      },
    }),

    topSongsByArtist: tool({
      description: 'Top songs for a named artist — good for staying in an artist\'s orbit without repeating a track.',
      inputSchema: z.object({ artist: z.string() }),
      execute: async ({ artist }) => {
        try { return collect(await subsonic.getTopSongs(artist, { count: 15 })); }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksByMood: tool({
      description: 'Songs tagged with a mood: energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural.',
      inputSchema: z.object({ mood: z.string() }),
      execute: async ({ mood }) => {
        try { await library.load(); return collect(library.songsByMood(mood)); }
        catch (err) { return { error: err.message }; }
      },
    }),

    recentlyAdded: tool({
      description: 'A sample of tracks from recently-added albums — "new in the crates".',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const albums = await subsonic.getRecentlyAddedAlbums({ size: 8 });
          const out = [];
          for (const a of albums.slice(0, 5)) {
            try { out.push(...(await subsonic.getAlbum(a.id)).slice(0, 3)); } catch {}
          }
          return collect(out);
        } catch (err) { return { error: err.message }; }
      },
    }),

    starredSongs: tool({
      description: "The operator's starred / favourite songs — always a safe, on-brand pick.",
      inputSchema: z.object({}),
      execute: async () => {
        try { return collect(await subsonic.getStarred()); }
        catch (err) { return { error: err.message }; }
      },
    }),

    randomSongs: tool({
      description: 'A random sample of songs from the library — use to break a predictable run.',
      inputSchema: z.object({}),
      execute: async () => {
        try { return collect(await subsonic.getRandomSongs({ size: 18 })); }
        catch (err) { return { error: err.message }; }
      },
    }),
  };

  return { tools, seen };
}
