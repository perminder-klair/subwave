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

// Compile a list of user-supplied exclude patterns into regexes. Each pattern
// is treated as a case-insensitive phrase; word boundaries are added on
// word-char edges (so "live" won't match "alive", but "(live)" matches
// literally). Called at filter time (once per pick) so settings changes take
// effect without restart; the overhead is negligible.
function buildExcludeRegexes(patterns: string[]): RegExp[] {
  return patterns.map(pattern => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = /^\w/.test(pattern) ? '\\b' : '';
    const suffix = /\w$/.test(pattern) ? '\\b' : '';
    return new RegExp(prefix + escaped + suffix, 'i');
  });
}

// Returns true if the track passes the current picker exclude filters.
// `patterns` is the effective list from settings.getPickerConfig() — pass it
// explicitly so callers can resolve the correct station/show context once and
// reuse across a whole candidate list rather than hitting settings N times.
export function isRadioPickable(title: string, album: string | null | undefined, patterns: string[]): boolean {
  if (!patterns.length) return true;
  const regexes = buildExcludeRegexes(patterns);
  const t = title ?? '';
  const a = album ?? '';
  return !regexes.some(re => re.test(t) || re.test(a));
}

function slim(s: any) {
  const base = {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album || null,
    year: s.year || null,
    genre: s.genre || null,
    ...(s.duration != null ? { duration: Math.round(s.duration) } : {}),
  };
  // Surface measured tempo/key when known — from the song itself (library
  // sources) or a library lookup (Subsonic sources). Omitted when un-analysed
  // so the agent only ever sees real values.
  const src = (s.bpm != null || s.musicalKey != null || s.introMs != null)
    ? s
    : (s.id ? library.get(s.id) : null);
  if (!src) return base;
  return {
    ...base,
    ...(src.bpm != null ? { bpm: src.bpm } : {}),
    ...(src.musicalKey != null ? { key: src.musicalKey } : {}),
    ...(src.introMs != null ? { intro_ms: src.introMs } : {}),
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
//
// `maxDurationSec` and `excludePatterns` come from settings.getPickerConfig()
// (station-wide or per-show override). Callers should resolve these once and
// pass them in; defaults are applied here if absent for call-site safety.
export function buildPickerTools({
  recentIds = new Set<string>(),
  recentKeys = new Set<string>(),
  recentArtists = new Set<string>(),
  maxDurationSec = 600,
  excludePatterns = [] as string[],
}: {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;        // lowercased "title|artist" — backfilled entries lack ids
  recentArtists?: Set<string>;
  maxDurationSec?: number;
  excludePatterns?: string[];
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
    const withinLength = (list || []).filter((s: any) =>
      (!s.duration || s.duration <= maxDurationSec) && isRadioPickable(s.title ?? '', s.album, excludePatterns));
    const accepted = filterPickerCandidates(shuffle(withinLength as any[]), {
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
          const out = collect(await subsonic.search(query, { songCount: 25 }));
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
  };

  return { tools, seen };
}
