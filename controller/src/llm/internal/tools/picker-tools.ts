// AI SDK tool library — music-discovery tools the picker agent calls to
// explore the library before choosing the next track.
//
// Each tool returns a slim song list ({ id, title, artist, album, year,
// genre } plus editorial tags — moods, energy, duration_sec, instrumental —
// and measured acoustics when analysed) so the model has stable ids to
// reference and enough signal to reason about flow. `buildPickerTools`
// returns a `seen` Map that accumulates every song any tool surfaced, so the
// picker can resolve the agent's chosen id back to a full track object.

import { tool } from 'ai';
import { z } from 'zod';
import * as subsonic from '../../../music/subsonic.js';
import * as library from '../../../music/library.js';
import * as embeddings from '../../../music/embeddings.js';
import { filterPickerCandidates, durationSeconds } from '../../../music/recency.js';
import { preferGenre, preferEra } from '../../../music/show-filter.js';
import { searchWeb, searchReady } from '../../../skills/web-search.js';
import { identifyTrackFromText } from '../prompts/request.js';

function slim(s: any) {
  const base = {
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album || null,
    year: s.year || null,
    genre: s.genre || null,
  };
  // Surface the editorial tags + measured acoustic facts when known — from the
  // song itself (library sources, via slimTrack) or a library lookup (Subsonic
  // sources). Each field is omitted when absent so the agent only ever sees real
  // values. `moods`/`energy` are the station's tagging vocabulary; `instrumental`
  // is derived from vocalRanges; `pace` (0..1 perceptual energy) and `sections`
  // (structural-part count over the opening) feed FLOW reasoning per
  // PICKER_CRITERIA in llm/dj.ts.
  const src = (s.bpm != null || s.musicalKey != null || s.introMs != null)
    ? s
    : (s.id ? library.get(s.id) : null);
  // Length reads from whichever field the raw candidate carries (Subsonic
  // `duration`, library `durationSec`), so it's present even for an un-tagged
  // Subsonic track whose library lookup came back empty.
  const durationSec = durationSeconds(s) ?? durationSeconds(src);
  if (!src) {
    return durationSec != null ? { ...base, duration_sec: durationSec } : base;
  }
  // vocalRanges: [] = no vocal regions (instrumental), null/undefined = not
  // computed (unknown — omit rather than guess "has vocals").
  const instrumental = Array.isArray(src.vocalRanges) ? src.vocalRanges.length === 0 : null;
  return {
    ...base,
    ...(Array.isArray(src.moods) && src.moods.length ? { moods: src.moods } : {}),
    ...(src.energy != null ? { energy: src.energy } : {}),
    ...(durationSec != null ? { duration_sec: durationSec } : {}),
    ...(instrumental != null ? { instrumental } : {}),
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

// Builds a fresh tool set scoped to one pick. `recentIds`/`recentKeys`
// (recently-played track ids + "title|artist" keys) are filtered out inside
// every tool so the agent never has to be told "avoid these" — it simply can't
// see them. We deliberately do NOT filter by recent *artist*: the similarity
// tools (similarSongs, tracksTowardJourney, tracks*LikeThis) return tracks
// clustered around what's currently playing — i.e. the just-played artist's
// neighbours — so an artist-recency strip gutted them to ~1 result while the
// 12h track guard already prevents literal repeats (issue: thin picker pools on
// niche catalogues). Track-recency alone is enough.
export function buildPickerTools({
  recentIds = new Set<string>(),
  recentKeys = new Set<string>(),
  audioWaypoint = null,
  resolveReferences = false,
  maxDurationSec = null,
  genreLock = null,
  eraLock = null,
}: {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;        // lowercased "title|artist" — backfilled entries lack ids
  // Hard genre constraint for a strict-genre show (settings.genreStrict). When
  // set, every tool's candidates are genre-filtered (preferGenre, never-starve)
  // before recency + cap, so the agent path enforces the lock in code, not just
  // the prompt — mirroring the pool picker's strict mode. null = no lock.
  // Deliberately NOT set on the request path: an explicit listener ask wins.
  genreLock?: string | null;
  // Hard era (decade/year window) constraint, applied only for a strict show
  // (gated on the same genreStrict flag — there's no separate era-strict toggle).
  // When set, candidates are year-filtered (preferEra, never-starve) before
  // recency + cap. null / both-bounds-null = no era lock.
  eraLock?: { fromYear?: number | null; toYear?: number | null } | null;
  // Hard length cap (seconds) for autonomous picks — the active show's override
  // or the station default (issue #447). null = no cap. Deliberately NOT set on
  // the request path (djAgentRequest) so an explicit listener ask for a long
  // mix still plays.
  maxDurationSec?: number | null;
  // The active sonic journey's current waypoint vector (broadcast/dj-agent.ts).
  // When present, the tracksTowardJourney tool below is registered, closing
  // over it — the agent never sees the raw vector, only the tracks near it.
  audioWaypoint?: number[] | null;
  // Request path only (djAgentRequest): registers identifyRequestedTrack, which
  // resolves a DESCRIBED track via web search and matches it to the LOCAL
  // library. No-op unless a web-search provider is ready (searchReady()). Never
  // set on the per-track picker — see the gating note on the tool below.
  resolveReferences?: boolean;
} = {}) {
  const seen = new Map<string, any>(); // id → slim song, accumulated across all tool calls

  // Filter recents, slim, and record into `seen` so the picker can resolve
  // the agent's final id choice to a full track. Drops only recently-played
  // tracks (by id/key) and tracks already surfaced this pick; artists are NOT
  // filtered (see buildPickerTools note). cap=8 keeps per-tool input tokens
  // lower for the picker agent — see picker-latency notes in dj-agent.js. The
  // seen map still accumulates across the whole loop, so the agent's id space
  // grows with each tool call regardless.
  const collect = (list: any, cap = 8) => {
    // Strict show: filter candidates BEFORE recency + cap, so the 8 the agent
    // sees are genre-/era-pure. Both never-starve (fall back to the full list
    // when a tool returns no match), so a thin genre/era degrades to off-target
    // rather than dead air — same contract as the pool path.
    let pool = shuffle((list || []) as any[]);
    if (genreLock) pool = preferGenre(pool, genreLock);
    if (eraLock) pool = preferEra(pool, eraLock);
    const accepted = filterPickerCandidates(pool, {
      recentIds,
      recentKeys,
      seenIds: new Set(seen.keys()),
      cap,
      maxDurationSec,
    });
    const out: any[] = [];
    for (const s of accepted) {
      const slimmed = slim(s);
      seen.set(s.id, slimmed);
      out.push(slimmed);
    }
    return out;
  };

  // Snapshot the embedding index counts once at tool-build time (synchronous
  // after library.load() — pickViaAgent awaits library.load() before reaching
  // buildPickerTools, so stats() never returns its empty-sentinel zeros here).
  // Tools whose backing index is empty are conditionally registered below:
  // offering a dead tool steers the model into a ~75 s timeout before the
  // pool-fallback rescues it (the "DJ Latency 75s" spike, 18% pick failure).
  const _stats = library.stats();
  const hasTextEmbeddings  = (_stats.withEmbedding      ?? 0) > 0;
  const hasAudioEmbeddings = (_stats.withAudioEmbedding ?? 0) > 0;
  const hasEmbeddingProvider = embeddings.isAvailable();

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

    recentByArtist: tool({
      description: 'A named artist\'s NEWEST releases, latest first — songs from their most recent albums/singles. Use this (not topSongsByArtist) when the listener asks for an artist\'s "latest", "newest", "new", or "most recent" song: topSongsByArtist ranks by popularity, so it cannot answer recency. Returns [] when the artist isn\'t in the library. Note: "latest in the library" — bounded by what has been added, not the artist\'s globally-newest release.',
      inputSchema: z.object({ artist: z.string() }),
      execute: async ({ artist }) => {
        // Keep the source list tight (newest ~6 tracks): collect() shuffles, so
        // a wide pool would let the shuffle drop the actual-newest tracks,
        // defeating "latest".
        try { return collect(await subsonic.getRecentSongsByArtist(artist, { albums: 2, count: 6 })); }
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

    // Only registered when the controller's own text/mood embedding index has
    // been built (withEmbedding > 0). This tool does KNN over the seed track's
    // STORED vector (library.tracksLikeThis -> db.knnById) and never calls the
    // embedding provider at query time, so it works whenever the index exists —
    // mirroring how tracksThatSoundLikeThis gates on hasAudioEmbeddings. Without
    // an index every call returns [], and the old description said "Prefer this
    // to similarSongs", actively steering the model into a dead tool — so gate it
    // off entirely rather than offer an unusable option.
    ...(hasTextEmbeddings ? {
      tracksLikeThis: tool({
        description: 'Tracks whose mood + lyrics + metadata embed closest to a seed track — the controller\'s own semantic similarity over the actual library. Requires the mood/lyric embedding index to be built. Pass the currently-playing song id (best) OR a track title — a title is resolved to the matching track.',
        // No k input: the agent reliably picked a small k (10–20), and the
        // nearest neighbours cluster tightly + many are recently-played, so that
        // left ~1 survivor after recency filtering. Pull a wide fixed KNN (60)
        // internally — collect() still caps to 8 fresh ones. Mirrors the journey
        // tool, which also takes no args.
        inputSchema: z.object({
          songId: z.string().describe('a song id (preferred) or a track title'),
        }),
        execute: async ({ songId }) => {
          try { await library.load(); return collect(library.tracksLikeThis(songId, 60)); }
          catch (err) { return { error: err.message }; }
        },
      }),
    } : {}),

    // Only registered when the CLAP audio embedding index has been built
    // (withAudioEmbedding > 0). Without audio vectors every call returns [] —
    // gate it off so the model is never offered an option it cannot use.
    ...(hasAudioEmbeddings ? {
      tracksThatSoundLikeThis: tool({
        description: 'Tracks whose ACTUAL SOUND (timbre, instrumentation, production, energy — a CLAP audio embedding of the waveform) is closest to a seed track. Blind to tags and metadata, so it shines for instrumentals, non-English tracks, or anything with thin Last.fm coverage. Requires the audio embedding index to be built. Pass the currently-playing song id (best) OR a track title.',
        // No k input: the agent reliably picked a small k (10–20), and audio
        // neighbours cluster tightly + many are recently-played, so that left ~1
        // survivor after recency filtering. Pull a wide fixed KNN (60) internally
        // — collect() still caps to 8 fresh ones. Mirrors the journey tool, which
        // also takes no args.
        inputSchema: z.object({
          songId: z.string().describe('a song id (preferred) or a track title'),
        }),
        execute: async ({ songId }) => {
          try { await library.load(); return collect(library.tracksLikeThisAudio(songId, 60)); }
          catch (err) { return { error: err.message }; }
        },
      }),
    } : {}),

    // Only registered when both the text embedding index (withEmbedding > 0)
    // AND a text-embedding provider are available. Every code path inside
    // requires both: embed the query, then KNN over stored track vectors.
    // Without them the tool errors or returns nothing — hide it so the model
    // uses searchLibrary (lexical) or similarSongs instead.
    ...(hasTextEmbeddings && hasEmbeddingProvider ? {
      searchByLyrics: tool({
        description: 'Semantic lyric / theme search over the library. Embeds the query and returns tracks whose lyrics + metadata are closest to it. Use for thematic picks the mood vocab can\'t express — e.g. "songs about hometown", "tracks with hopeful lyrics", "feeling stuck". Requires the mood/lyric embedding index and a text-embedding provider.',
        // No k input: the agent reliably picked a small k, and recency filtering
        // then thins it further. Pull a wide fixed KNN (60) internally —
        // collect() still caps to 8 fresh ones. Mirrors the seed-similarity tools.
        inputSchema: z.object({
          query: z.string().min(3),
        }),
        execute: async ({ query }) => {
          try {
            if (!embeddings.isAvailable()) return { error: 'embeddings not configured — set settings.embedding.enabled / provider' };
            await library.load();
            const [vec] = await embeddings.embedTexts([query.trim()]);
            if (!vec) return { error: 'embedding query failed' };
            return collect(library.tracksByVector(vec, 60));
          }
          catch (err) { return { error: err.message }; }
        },
      }),
    } : {}),

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
    ...(audioWaypoint && audioWaypoint.length && hasAudioEmbeddings ? {
      tracksTowardJourney: tool({
        description: 'Tracks nearest the active sonic journey\'s CURRENT waypoint — the station is mid-arc, drifting its sound toward a destination vibe over the next few picks. When the event says a journey is active, call this and strongly prefer one of its tracks: each one moves the sound a step along the arc. Takes no input.',
        inputSchema: z.object({}),
        execute: async () => {
          // Pull a wide KNN (60) around the waypoint: the nearest neighbours
          // cluster tightly and many will be recently-played, so a small k left
          // the agent with ~1 candidate. collect() still caps to 8 fresh ones.
          try { await library.load(); return collect(library.tracksByAudioVector(audioWaypoint, 60)); }
          catch (err) { return { error: err.message }; }
        },
      }),
    } : {}),

    // Request path only, and only when a web-search provider is ready. Resolves a
    // listener's DESCRIPTION of a track (not a name) to songs in the LOCAL
    // library: it looks the description up on the web, identifies the most likely
    // single song, then searches Navidrome for it. Every returned candidate goes
    // through collect() like any other tool, so the chosen id is always real —
    // web text only steers which library tracks surface, never the id space.
    ...(resolveReferences && searchReady() ? {
      identifyRequestedTrack: tool({
        description: 'Use when a listener DESCRIBES a track instead of naming it, OR pastes SONG LYRICS. Examples: "the song from the new Dune movie", "the one all over TikTok", or a block of lyrics in any language. Looks the text up on the web, identifies the most likely song, then returns matching tracks FROM THIS LIBRARY (or none if we do not have it). USE THIS (not searchLibrary) when the request looks like lyrics — repeated phrases, verse structure, or text in a non-English language that is not an artist/title. If the listener names an artist or title outright, use searchLibrary instead — not this. searchLibrary matches titles and artists; it cannot identify a song from its lyrics. (Distinct from searchByLyrics, which finds songs ABOUT a theme — this identifies the one specific song whose exact words the listener pasted.) Returns { identified, candidates }: even when candidates is empty, `identified` tells you what the reference meant so you can pivot (e.g. topSongsByArtist) or tell the listener it is not in the library.',
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
          } catch (err) { return { error: err.message }; }
        },
      }),
    } : {}),
  };

  return { tools, seen };
}
