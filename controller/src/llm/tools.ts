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
import * as embeddings from '../music/embeddings.js';
import { filterPickerCandidates } from '../music/recency.js';

function slim(s: any) {
  const base = {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album || null,
    year: s.year || null,
    genre: s.genre || null,
  };
  // Surface measured acoustic facts when known — from the song itself (library
  // sources, via slimTrack) or a library lookup (Subsonic sources). Each field
  // is omitted when un-analysed so the agent only ever sees real values.
  // `pace` (0..1 perceptual energy) and `sections` (structural-part count over
  // the opening) feed FLOW reasoning per PICKER_CRITERIA in llm/dj.ts.
  const src = (s.bpm != null || s.musicalKey != null || s.introMs != null)
    ? s
    : (s.id ? library.get(s.id) : null);
  if (!src) return base;
  return {
    ...base,
    ...(src.bpm != null ? { bpm: src.bpm } : {}),
    ...(src.musicalKey != null ? { key: src.musicalKey } : {}),
    ...(src.introMs != null ? { intro_ms: src.introMs } : {}),
    ...(src.paceMean != null ? { pace: src.paceMean } : {}),
    ...(Array.isArray(src.structure) && src.structure.length ? { sections: src.structure.length } : {}),
  };
}

// Navidrome (and library.songsByMood) return results in deterministic order:
// `tracksByMood("night")` always returns the same first N of 89 night-tagged
// songs; `topSongsByArtist("Karan Aujla")` always returns the same top-N by
// play count. With `cap=8` the agent sees the same handful no matter how many
// times it asks. Shuffling here turns each call into a fresh sample — the same
// fix `music/picker.js` already applies at pool-build time.
function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

// Most songs by any one artist allowed across a whole pick. The recent-artists
// window (passed by dj-agent.pickViaAgent) already blocks any artist heard in
// the last 2h, so this cap only matters when multiple tools (searchLibrary +
// topSongsByArtist + similarSongs) surface the same artist within one pick.
// 2 is tighter than the previous 3 to reduce in-pool fixation on deep
// catalogues — per-tool cap=8 still leaves plenty of candidates overall.
const MAX_PER_ARTIST = 2;

// Builds a fresh tool set scoped to one pick. `recentIds` (recently-played
// song ids) and `recentArtists` (lowercased recently-played artist names) are
// filtered out inside every tool so the agent never has to be told "avoid
// these" — it simply can't see them. `recentArtists` is left empty on the
// listener-request path so a request for a recent artist still resolves.
export function buildPickerTools({
  recentIds = new Set<string>(),
  recentKeys = new Set<string>(),
  recentArtists = new Set<string>(),
  audioWaypoint = null,
}: {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;        // lowercased "title|artist" — backfilled entries lack ids
  recentArtists?: Set<string>;
  // The active sonic journey's current waypoint vector (broadcast/dj-agent.ts).
  // When present, the tracksTowardJourney tool below is registered, closing
  // over it — the agent never sees the raw vector, only the tracks near it.
  audioWaypoint?: number[] | null;
} = {}) {
  const seen = new Map<string, any>(); // id → slim song, accumulated across all tool calls
  const artistCounts = new Map<string, number>(); // artist key → songs already accepted into `seen`

  // Filter recents, slim, and record into `seen` so the picker can resolve
  // the agent's final id choice to a full track. Drops songs by an artist that
  // played in the recent window, and caps any one artist's share of the pool.
  // cap=8 (down from 12) keeps per-tool input tokens lower for the picker
  // agent — see picker-latency notes in dj-agent.js. The seen map still
  // accumulates across the whole loop, so the agent's id space grows with
  // each tool call regardless.
  const collect = (list: any, cap = 8) => {
    const accepted = filterPickerCandidates(shuffle((list || []) as any[]), {
      recentIds,
      recentKeys,
      recentArtists,
      seenIds: new Set(seen.keys()),
      artistCounts,
      maxPerArtist: MAX_PER_ARTIST,
      cap,
    });
    const out: any[] = [];
    for (const s of accepted) {
      const slimmed = slim(s);
      seen.set(s.id, slimmed);
      out.push(slimmed);
    }
    return out;
  };

  const tools = {
    searchLibrary: tool({
      description: 'Search the music library. Matches a literal artist name, song title, or real genre (e.g. "jazz", "punjabi") first; if nothing matches it falls back to semantic / vibe search, so descriptive multi-word queries like "punjabi r&b romantic" also work. Returns matching songs.',
      inputSchema: z.object({
        query: z.string().describe('an artist name, song title, genre, or vibe'),
      }),
      execute: async ({ query }) => {
        try {
          let songs = await subsonic.search(query, { songCount: 25 });
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
          if (!embeddings.isAvailable()) return out;
          await library.load();
          const [vec] = await embeddings.embedTexts([query.trim()]);
          if (!vec) return out;
          return collect(library.tracksByVector(vec, 20));
        }
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

    songsByGenre: tool({
      description: 'Songs from a library genre tag, fuzzy-matched ("turkish" finds "Turkish Pop"). Use for language/country/style asks — "play something Turkish" — that searchLibrary cannot reach: genre lives in tags, not titles.',
      inputSchema: z.object({ genre: z.string().describe('a genre, language, or country word, e.g. "jazz", "turkish", "punjabi"') }),
      execute: async ({ genre }) => {
        try {
          const name = await subsonic.resolveGenreName(genre);
          if (!name) return { error: `no library genre matching "${genre}"` };
          return collect(await subsonic.getSongsByGenre(name, { count: 50 }));
        }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksByMood: tool({
      description: 'Songs tagged with a mood: energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural. Optionally constrain by energy level (low|medium|high).',
      inputSchema: z.object({
        mood: z.string(),
        energy: z.enum(['low', 'medium', 'high']).optional()
          .describe('Optional energy filter — narrows the result to that tempo/intensity band.'),
      }),
      execute: async ({ mood, energy }) => {
        try {
          await library.load();
          let rows = library.songsByMood(mood);
          if (energy) rows = rows.filter((r: any) => r.energy === energy);
          return collect(rows);
        }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksByEnergy: tool({
      description: 'Songs tagged with a specific energy level: low (slow / mellow / ambient), medium (mid-tempo / steady), or high (uptempo / driving). Use for time-of-day or activity-based picks the mood vocab alone can\'t express — e.g. high for a workout, low for a wind-down, medium for a commute.',
      inputSchema: z.object({ energy: z.enum(['low', 'medium', 'high']) }),
      execute: async ({ energy }) => {
        try { await library.load(); return collect(library.songsByEnergy(energy)); }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksLikeThis: tool({
      description: 'Tracks whose mood + lyrics + metadata embed closest to a seed track — the controller\'s own semantic similarity over the actual library. Prefer this to similarSongs when "more of this vibe" matters more than "more by this artist". Pass the currently-playing song id (best) OR a track title — a title is resolved to the matching track. Returns [] only if neither a song id nor a title match anything embedded.',
      inputSchema: z.object({
        songId: z.string().describe('a song id (preferred) or a track title'),
        k: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ songId, k }) => {
        try { await library.load(); return collect(library.tracksLikeThis(songId, k)); }
        catch (err) { return { error: err.message }; }
      },
    }),

    tracksThatSoundLikeThis: tool({
      description: 'Tracks whose ACTUAL SOUND (timbre, instrumentation, production, energy — a CLAP audio embedding of the waveform) is closest to a seed track. Unlike tracksLikeThis (which compares mood/lyrics/metadata), this is blind to tags and metadata, so it shines for instrumentals, non-English tracks, or anything with thin Last.fm coverage. Pass the currently-playing song id (best) OR a track title. Returns [] only when neither matches anything with an audio embedding (audio analysis not enabled / not yet run).',
      inputSchema: z.object({
        songId: z.string().describe('a song id (preferred) or a track title'),
        k: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ songId, k }) => {
        try { await library.load(); return collect(library.tracksLikeThisAudio(songId, k)); }
        catch (err) { return { error: err.message }; }
      },
    }),

    searchByLyrics: tool({
      description: 'Semantic lyric / theme search over the library. Embed the query and return tracks whose lyrics + metadata are closest to it. Use for thematic picks the mood vocab can\'t express — e.g. "songs about hometown", "tracks with hopeful lyrics", "feeling stuck". Tracks without lyrics or without embeddings simply rank low; the search still returns the best of what it has.',
      inputSchema: z.object({
        query: z.string().min(3),
        k: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ query, k }) => {
        try {
          if (!embeddings.isAvailable()) return { error: 'embeddings not configured — set settings.embedding.enabled / provider' };
          await library.load();
          const [vec] = await embeddings.embedTexts([query.trim()]);
          if (!vec) return { error: 'embedding query failed' };
          return collect(library.tracksByVector(vec, k));
        }
        catch (err) { return { error: err.message }; }
      },
    }),

    recentlyAdded: tool({
      description: 'A sample of tracks from recently-added albums — "new in the crates".',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const albums = await subsonic.getRecentlyAddedAlbums({ size: 8 });
          const out: any[] = [];
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

    // Only registered while a sonic journey is active (the event message tells
    // the agent when that is). Closes over the journey's current waypoint, so
    // calling it returns the tracks that carry the sound one step along the
    // arc toward the destination vibe.
    ...(audioWaypoint && audioWaypoint.length ? {
      tracksTowardJourney: tool({
        description: 'Tracks nearest the active sonic journey\'s CURRENT waypoint — the station is mid-arc, drifting its sound toward a destination vibe over the next few picks. When the event says a journey is active, call this and strongly prefer one of its tracks: each one moves the sound a step along the arc. Takes no input.',
        inputSchema: z.object({}),
        execute: async () => {
          try { await library.load(); return collect(library.tracksByAudioVector(audioWaypoint, 20)); }
          catch (err) { return { error: err.message }; }
        },
      }),
    } : {}),
  };

  return { tools, seen };
}
