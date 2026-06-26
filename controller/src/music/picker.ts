// LLM-as-DJ next-track selector — the "pool path".
//
// The controller builds a balanced candidate pool from 7 Subsonic/library
// sources and asks the LLM to pick one. Cheap, deterministic, one model call,
// works with any model. This is the stateless fallback used by the session DJ
// agent (broadcast/dj-agent.js) whenever the conversational agent is disabled
// or fails — so a pick is never missed.

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as dj from '../llm/dj.js';
import * as settings from '../settings.js';
import { bpmCompat, keyCompat } from './mix.js';
import { filterPickerCandidates, recencyWindowsForLibrary } from './recency.js';

const CANDIDATE_CAP = 18;
const HISTORY_DEPTH = 4;

// Per-source caps so the LLM sees a balanced mix rather than 15 similar songs.
const CAP_SIMILAR = 8;
const CAP_MOOD_LIBRARY = 10;
const CAP_PLAYLIST = 6;
const CAP_RECENT = 4;
const CAP_FREQUENT = 4;
const CAP_SIMILAR_ARTIST = 4;
const CAP_EMBEDDING_SIMILAR = 4;
const CAP_SONIC_SIMILAR = 4;
const CAP_AUDIO_SIMILAR = 4;
// When a show pins a genre/decade, its dedicated source is the dominant pool
// contributor (soft lean) and the unrelated discovery sources shrink by this
// factor so the genre/era actually shows up in the LLM's candidate list.
const CAP_SHOW_GENRE = 12;
// In strict mode the show-genre source becomes the dominant contributor: a
// larger cap than the soft path so genre matches fill most of the final pool
// (CANDIDATE_CAP) even after dedup / artist-cap / recency trims it.
const CAP_SHOW_GENRE_STRICT = 24;
const SHOW_NARROW_FACTOR = 0.5;

// TTL cache for sources that don't change between picks. Without this, every
// pick would re-fetch playlists, recent/frequent album lists and re-walk their
// tracks — turning ~1 Navidrome call per pick into ~15.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map();
async function memo(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = await fn();
  cache.set(key, { val, at: Date.now() });
  return val;
}

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

// --- Tempo / harmonic compatibility (Stage B, soft re-rank only) -----------
// These bias the pool ordering toward smoother transitions; they are NEVER a
// hard filter, and a track with NULL bpm/key contributes a 0 bonus (so it
// keeps its random position). An entirely un-analysed library therefore ranks
// exactly as a plain shuffle — today's behaviour.

// Pull bpm/musical_key for a candidate, from the candidate itself (library
// sources carry it via slimTrack) or a library lookup (Subsonic sources).
function analysisFor(t: any): { bpm: number | null; key: string | null } {
  if (t && (t.bpm != null || t.musicalKey != null)) {
    return { bpm: t.bpm ?? null, key: t.musicalKey ?? null };
  }
  const rec = t?.id ? library.get(t.id) : null;
  return { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
}

// bpmCompat / keyCompat now live in ./mix.js (single source of truth, shared
// with the DJ-mix transition features); imported above.

// Order the pool by a random base nudged up for tempo/harmonic compatibility
// with the current track. Random stays dominant so the pool keeps its variety
// and a NULL-analysis pool is indistinguishable from shuffle().
function softRankByCompat(pool: any[], current: { bpm: number | null; key: string | null }): any[] {
  if (current.bpm == null && current.key == null) return shuffle(pool);
  return pool
    .map((t: any) => {
      const a = analysisFor(t);
      const bonus = 0.4 * bpmCompat(current.bpm, a.bpm) + 0.3 * keyCompat(current.key, a.key);
      return { t, score: Math.random() + bonus };
    })
    .sort((x, y) => y.score - x.score)
    .map((s) => s.t);
}

// --- Show music-steering filters -------------------------------------------
// A show can pin a genre, a decade (fromYear/toYear) and an energy band. By
// default none is a hard filter: each prefers matching tracks but falls back to
// the full set when matches are too thin to fill the pool, so a sparse genre or
// an un-analysed library never starves the stream.
//
// `strict` opts the GENRE (only) into a hard filter: the off-genre discovery
// sources are genre-filtered before they enter the pool, so the pool is
// genuinely genre-dominated rather than just shrunk. The same never-starve
// fallback applies — a genre too thin to fill the pool degrades to off-genre
// tracks rather than dead air (logged by the caller). Decade and energy stay
// soft either way.

type ShowFilter = { genre?: string; fromYear?: number | null; toYear?: number | null; energy?: string; strict?: boolean } | null;

function hasMusicFilter(f: ShowFilter): boolean {
  return !!f && (!!f.genre || f.fromYear != null || f.toYear != null);
}

// Normalised genre token for fuzzy comparison — mirrors subsonic.resolveGenreName
// so the show's resolved tag and a track's tag compare the same way.
function normGenre(s: any): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Per-track genre — from the track itself (Subsonic + slimTrack library sources
// both carry it) or a library lookup. null when the track has no genre tag.
function trackGenre(t: any): string | null {
  if (t?.genre) return t.genre;
  const rec = t?.id ? library.get(t.id) : null;
  return rec?.genre ?? null;
}

// True when a track's genre matches the (already library-resolved) target genre.
// Exact-normalised match, or substring either way — same shape as
// subsonic.resolveGenreName, so "Hip-Hop" matches a "Hip Hop" tag etc.
function genreMatches(t: any, targetNorm: string): boolean {
  const g = trackGenre(t);
  if (!g) return false;
  const gn = normGenre(g);
  return !!gn && (gn === targetNorm || gn.includes(targetNorm) || targetNorm.includes(gn));
}

// Hard-prefer tracks matching the show's genre (strict mode). Unlike the soft
// energy/year leans, an untagged or off-genre track does NOT stay eligible —
// the whole point of strict is a genre-pure pool. But it FALLS BACK to the
// unfiltered set when no track matches, so a thin genre degrades to off-genre
// rather than emptying the source (never-starve, mirrors preferEnergy/inYearRange).
function preferGenre(tracks: any[], genreName?: string | null): any[] {
  if (!genreName) return tracks;
  const target = normGenre(genreName);
  if (!target) return tracks;
  const match = tracks.filter((t: any) => genreMatches(t, target));
  return match.length ? match : tracks;
}

// Per-track energy band — from the track itself (library sources carry it) or a
// library lookup (Subsonic sources don't). null when un-analysed.
function trackEnergy(t: any): string | null {
  if (t?.energy) return t.energy;
  const rec = t?.id ? library.get(t.id) : null;
  return rec?.energy ?? null;
}

// Soft-prefer tracks within [fromYear, toYear]. Unknown-year tracks are treated
// as out-of-range here, but the caller falls back to the full set when the
// in-range slice is empty, so it never hard-drops everything.
function inYearRange(tracks: any[], f: { fromYear?: number | null; toYear?: number | null }): any[] {
  if (f.fromYear == null && f.toYear == null) return tracks;
  return tracks.filter((t: any) => {
    const y = Number(t?.year);
    if (!Number.isFinite(y)) return false;
    if (f.fromYear != null && y < f.fromYear) return false;
    if (f.toYear != null && y > f.toYear) return false;
    return true;
  });
}

// Soft-prefer tracks matching the show's energy band; unknown-energy tracks
// stay eligible. Falls back to the full set when no track matches.
function preferEnergy(tracks: any[], energy?: string): any[] {
  if (!energy) return tracks;
  const match = tracks.filter((t: any) => {
    const e = trackEnergy(t);
    return e == null || e === energy;
  });
  return match.length ? match : tracks;
}

function notRecent(recentIds: Set<string>) {
  return (t: any) => t && t.id && !recentIds.has(t.id);
}

function sampleWithRecentFallback(items: any[], recentIds: Set<string>, cap: number) {
  const fresh = items.filter(notRecent(recentIds));
  return (fresh.length > 0 ? fresh : items).slice(0, cap);
}

// Walk a list of albums and return up to `perAlbum` tracks from each, capped.
async function tracksFromAlbums(albums: any[], perAlbum: number, max: number) {
  const out: any[] = [];
  for (const a of albums) {
    if (out.length >= max) break;
    try {
      const songs = await subsonic.getAlbum(a.id);
      out.push(...shuffle(songs).slice(0, perAlbum));
    } catch {}
  }
  return out;
}

async function buildCandidates(mood: string | null | undefined, recentIds: Set<string>, recentArtists: Set<string>, currentTrack: any, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, showFilter: ShowFilter = null) {
  await library.load();
  const pool: any[] = [];
  const sources: Record<string, number> = {};
  const add = (label: string, items: any[]) => {
    if (!items?.length) return;
    pool.push(...items.map((t: any) => ({ ...t, _source: label })));
    sources[label] = (sources[label] || 0) + items.length;
  };
  // When a show pins a genre/decade, shrink the unrelated discovery sources so
  // the dedicated show-genre source dominates the candidate list (soft lean).
  const narrow = hasMusicFilter(showFilter);
  const nz = (cap: number) => (narrow ? Math.max(2, Math.ceil(cap * SHOW_NARROW_FACTOR)) : cap);

  // Strict genre: resolve the show's free-text genre to the library's exact tag
  // ONCE, up front, so the off-genre discovery sources below can be hard-filtered
  // to it before they enter the pool — making the pool genuinely genre-dominated,
  // not just shrunk. Soft mode (or no genre) leaves the sources untouched (only
  // the nz() shrink applies). A resolution failure / absent genre degrades to no
  // filter so a misspelled genre never strands the show (never-starve).
  const strict = !!(showFilter?.strict && showFilter?.genre);
  let strictGenre: string | null = null;
  if (strict) {
    try { strictGenre = await subsonic.resolveGenreName(showFilter!.genre!); } catch {}
  }
  // Hard-prefer the resolved genre on a discovery source in strict mode; a no-op
  // otherwise. preferGenre always falls back to the full set when nothing in the
  // source matches, so leaning a source can only tighten genre, never starve it.
  const lean = (items: any[]) => (strict && strictGenre ? preferGenre(items, strictGenre) : items);

  // 1. Similar-songs from current track — strongest contextual signal.
  if (currentTrack?.id) {
    try {
      const similar = await subsonic.getSimilarSongs(currentTrack.id, {
        count: 20,
      });
      add('similar', sampleWithRecentFallback(lean(similar), recentIds, nz(CAP_SIMILAR)));
    } catch {}
  }

  // 1b. Embedding-KNN from current track — the controller's own semantic
  // similarity over the actual library. Catches sonic neighbours the LastFM-
  // backed `getSimilarSongs` doesn't know about — especially valuable for
  // regional / non-Western catalogues where LastFM coverage is thin. Returns
  // [] when the seed has no vector yet (fresh imports before the next tagger
  // run), so the picker silently falls through to the other sources.
  if (currentTrack?.id) {
    try {
      const knn = library.tracksLikeThis(currentTrack.id, 15);
      add('embedding-similar', sampleWithRecentFallback(lean(knn), recentIds, nz(CAP_EMBEDDING_SIMILAR)));
    } catch {}
  }

  // 1c. Sonic-similarity from current track — Navidrome's own audio-based
  // neighbours (OpenSubsonic `sonicSimilarity` extension, Navidrome ≥0.62 with
  // the plugin enabled). A third, acoustically-grounded signal alongside the
  // Last.fm graph (1) and the embedding-KNN (1b). The support probe is cached
  // 30 min in subsonic.ts, so this costs one extra call per pick only when the
  // extension is actually present; otherwise it's a silent no-op.
  if (currentTrack?.id) {
    try {
      if (await subsonic.supportsSonicSimilarity()) {
        const sonic = await subsonic.getSonicSimilarTracks(currentTrack.id, { count: 20 });
        add('sonic-similar', sampleWithRecentFallback(lean(sonic), recentIds, nz(CAP_SONIC_SIMILAR)));
      }
    } catch {}
  }

  // 1d. Audio-KNN (CLAP) — "sounds like this" over the waveform itself (timbre
  // / instrumentation / production / energy), blind to metadata. Complements
  // embedding-similar: text catches same scene/era/theme, audio catches same
  // sound — especially for thin-metadata or non-Western tracks where Last.fm +
  // lyric coverage is sparse. Returns [] when the anchor has no audio vector
  // (CLAP disabled / un-analysed), so it silently no-ops on a library without
  // audio embeddings — behaviour is identical to today's.
  //
  // When a sonic journey (Phase 2, broadcast/dj-agent.ts) is active, the anchor
  // is the journey's WAYPOINT vector rather than the current track — so the pool
  // drifts toward the destination vibe instead of hugging the current sound.
  if (audioWaypoint && audioWaypoint.length) {
    try {
      const knn = library.tracksByAudioVector(audioWaypoint, 15);
      add('audio-journey', sampleWithRecentFallback(lean(knn), recentIds, nz(CAP_AUDIO_SIMILAR)));
    } catch {}
  } else if (currentTrack?.id) {
    try {
      const knn = library.tracksLikeThisAudio(currentTrack.id, 15);
      add('audio-similar', sampleWithRecentFallback(lean(knn), recentIds, nz(CAP_AUDIO_SIMILAR)));
    } catch {}
  }

  // 1e. Show genre / decade — the soft-dominant source when a show pins a
  // genre or a year range. getRandomSongs takes genre + year-range natively in
  // one call; when a genre is set we also pull the full genre-tagged set
  // (broader than a random sample) and soft-filter it to the decade. The whole
  // collection is then energy-preferred. Never a hard filter — see helpers.
  if (hasMusicFilter(showFilter)) {
    try {
      // Reuse the strict-resolved tag when we already paid for it above; only
      // resolve here on the soft path (or if strict resolution came back null).
      let genreName: string | null = strict ? strictGenre : null;
      if (!genreName && showFilter!.genre) {
        genreName = await subsonic.resolveGenreName(showFilter!.genre);
      }
      const collected: any[] = [];
      collected.push(...await subsonic.getRandomSongs({
        size: strict ? 60 : 40,
        genre: genreName || undefined,
        fromYear: showFilter!.fromYear ?? undefined,
        toYear: showFilter!.toYear ?? undefined,
      }));
      if (genreName) {
        const g = await subsonic.getSongsByGenre(genreName, { count: strict ? 100 : 60 });
        const ranged = inYearRange(g, showFilter!);
        collected.push(...(ranged.length ? ranged : g));
      }
      const leaned = preferEnergy(collected, showFilter!.energy);
      // Strict bumps the cap so this genre-native source dominates the merged pool.
      add('show-genre', sampleWithRecentFallback(shuffle(leaned), recentIds, strict ? CAP_SHOW_GENRE_STRICT : CAP_SHOW_GENRE));
    } catch {}
  }

  // 2. Mood-tagged library (LLM-built tags, may be sparse).
  if (mood) {
    const moodHits = shuffle(lean(preferEnergy(library.songsByMood(mood), showFilter?.energy)));
    add('mood-library', sampleWithRecentFallback(moodHits, recentIds, CAP_MOOD_LIBRARY));
  }

  // 3. Mood-matched Navidrome playlists — operator's hand curation.
  if (mood) {
    try {
      const playlists = await memo('playlists', CACHE_TTL_MS, () => subsonic.getPlaylists());
      const matched = playlists.filter((p: any) => p.name?.toLowerCase().includes(mood.toLowerCase()));
      const plTracks: any[] = [];
      for (const pl of matched.slice(0, 2)) {
        try {
          const songs = await memo(`playlist:${pl.id}`, CACHE_TTL_MS, () =>
            subsonic.getPlaylist(pl.id),
          );
          plTracks.push(...songs);
        } catch {}
      }
      add('playlist', sampleWithRecentFallback(lean(shuffle(plTracks)), recentIds, nz(CAP_PLAYLIST)));
    } catch {}
  }

  // 4. Recently-added albums — "new in the crates". The memo caches a WIDE
  // (~40-track) pool; the per-pick `shuffle` then draws a fresh sample from it.
  // Memoising the narrow CAP_RECENT slice instead would freeze the same 4
  // tracks for the whole TTL — see the library-search review, finding C.
  try {
    const recentPool = await memo('recent-track-pool', CACHE_TTL_MS, async () => {
      const albums = await subsonic.getRecentlyAddedAlbums({ size: 12 });
      return tracksFromAlbums(shuffle(albums), 3, 40);
    });
    add('recent', sampleWithRecentFallback(lean(shuffle(recentPool)), recentIds, nz(CAP_RECENT)));
  } catch {}

  // 5. Frequent albums — scrobble-backed favourites. Same wide-pool-then-
  // shuffle pattern as recently-added above.
  try {
    const freqPool = await memo('frequent-track-pool', CACHE_TTL_MS, async () => {
      const albums = await subsonic.getFrequentAlbums({ size: 12 });
      return tracksFromAlbums(shuffle(albums), 3, 40);
    });
    add('frequent', sampleWithRecentFallback(lean(shuffle(freqPool)), recentIds, nz(CAP_FREQUENT)));
  } catch {}

  // 6. Similar-artist top songs — adjacency through Last.fm artist graph.
  if (currentTrack?.artist) {
    try {
      const similarArtistTracks = await memo(
        `similar-artist:${currentTrack.artist}`,
        CACHE_TTL_MS,
        async () => {
          const matches = await subsonic.searchArtists(currentTrack.artist, {
            artistCount: 1,
          });
          if (matches.length === 0) return [];
          const info = await subsonic.getArtistInfo(matches[0].id, {
            count: 5,
          });
          const similars = (info?.similarArtist || []).slice(0, 2);
          const collected: any[] = [];
          for (const sa of similars) {
            try {
              const top = await subsonic.getTopSongs(sa.name, { count: 5 });
              collected.push(...top);
            } catch {}
          }
          return collected;
        },
      );
      add(
        'similar-artist',
        sampleWithRecentFallback(lean(similarArtistTracks), recentIds, nz(CAP_SIMILAR_ARTIST)),
      );
    } catch {}
  }

  // 7. Fallback if the pool is still thin — starred + random.
  if (pool.length < 8) {
    try {
      const starred = await subsonic.getStarred();
      add('starred', sampleWithRecentFallback(shuffle(starred), recentIds, 4));
    } catch {}
    try {
      const random = await subsonic.getRandomSongs({ size: 10 });
      add('random', sampleWithRecentFallback(random, recentIds, 4));
    } catch {}
  }

  // De-dup by id, cap per artist so one name can't dominate the pool (the LLM
  // can only rotate artists across what it's handed), shuffle, cap.
  const MAX_PER_ARTIST = 3;
  const perArtist = new Map<string, number>();
  // Soft tempo/harmonic re-rank toward the current track BEFORE the cap, so
  // compatible tracks are likelier to survive the slice — never a hard filter,
  // and a no-op (pure shuffle) when the current track or the pool is
  // un-analysed. The dedup / artist-cap / recency filter below is unchanged;
  // it just walks a differently-ordered list.
  // A DJ-mode mini-run (broadcast/dj-agent.ts) overrides the re-rank anchor
  // with a deliberate tempo/key target so the pool drifts toward the run's
  // journey rather than just hugging the current track. Falls back to the
  // current track's own analysis when no run is active.
  const curAnalysis = rankTarget
    || (currentTrack?.id ? analysisFor(currentTrack) : { bpm: null, key: null });
  const final = filterPickerCandidates(softRankByCompat(pool, curAnalysis), {
    recentIds,
    recentArtists,
    artistCounts: perArtist,
    maxPerArtist: MAX_PER_ARTIST,
    cap: CANDIDATE_CAP,
  });

  // Strict-genre diagnostics for the caller's never-starve log: how much of the
  // final pool actually landed in-genre. `resolved` is null when the show's
  // genre didn't map to any library tag (strict silently degraded to soft).
  let strictInfo: { requested: string; resolved: string | null; matched: number; total: number } | null = null;
  if (strict) {
    const target = strictGenre ? normGenre(strictGenre) : '';
    strictInfo = {
      requested: showFilter!.genre!,
      resolved: strictGenre,
      matched: target ? final.filter((t: any) => genreMatches(t, target)).length : 0,
      total: final.length,
    };
  }

  return { candidates: final, sources, strictInfo };
}

function summariseRecent(queue: any) {
  const items: any[] = [];
  if (queue.current) items.push(queue.current);
  items.push(...queue.history.slice(0, HISTORY_DEPTH));
  return items
    .filter((i: any) => i?.track?.title)
    .map((i: any) => {
      const tags = i.track.id ? library.get(i.track.id) : null;
      return {
        title: i.track.title,
        artist: i.track.artist,
        moods: tags?.moods || [],
        energy: tags?.energy || null,
      };
    });
}

// ---------------------------------------------------------------------------
// Pool path — build a candidate pool, ask the LLM to choose one. Returns
// { song, reason, source } or null. Used by broadcast/dj-agent.js.
// ---------------------------------------------------------------------------

export async function pickViaPool(queue, ctx, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null) {
  await library.load();
  const windows = recencyWindowsForLibrary(library.stats().distinctArtists);
  const recentIds = queue.recentlyPlayedIds(windows.trackHours);
  const recentArtists = queue.recentArtistsSince(windows.artistHours);
  const currentTrack = queue.current?.track || null;
  // Resolve the active show once: its music-steering filters shape the pool
  // (below) and its brief steers the LLM pick (further down).
  const activeShow = settings.resolveActiveShow();
  const showFilter: ShowFilter = activeShow
    ? { genre: activeShow.genre, fromYear: activeShow.fromYear, toYear: activeShow.toYear, energy: activeShow.energy, strict: activeShow.genreStrict }
    : null;
  const { candidates, sources, strictInfo } = await buildCandidates(ctx.dominantMood, recentIds, recentArtists, currentTrack, rankTarget, audioWaypoint, showFilter);

  if (candidates.length === 0) {
    queue.log('picker', 'no candidates available, skipping LLM pick');
    return null;
  }

  queue.log(
    'picker',
    `pool ${candidates.length} (${Object.entries(sources)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')})`,
  );

  // Strict-genre visibility — make the never-starve fallback audible in the log
  // so a thin/misspelled genre isn't a silent mystery.
  if (strictInfo) {
    if (!strictInfo.resolved) {
      queue.log('picker', `strict genre "${strictInfo.requested}" not found in library — falling back to unfiltered pool`);
    } else if (strictInfo.matched === 0) {
      queue.log('picker', `strict genre ${strictInfo.resolved}: 0 in-genre candidates — falling back to off-genre to keep the stream alive`);
    } else if (strictInfo.matched < strictInfo.total) {
      queue.log('picker', `strict genre ${strictInfo.resolved}: ${strictInfo.matched}/${strictInfo.total} in-genre (off-genre allowed as fallback)`);
    } else {
      queue.log('picker', `strict genre ${strictInfo.resolved}: ${strictInfo.matched}/${strictInfo.total} in-genre`);
    }
  }

  const recentPlays = summariseRecent(queue);

  let pickRaw;
  try {
    // Same show-brief plumbing as the agent picker (dj-agent.pickSystem) —
    // this is its fallback, so it must honour the brief too.
    pickRaw = await dj.pickNextTrack({
      show: activeShow
        ? {
            name: activeShow.name,
            topic: activeShow.topic,
            genre: activeShow.genre,
            fromYear: activeShow.fromYear,
            toYear: activeShow.toYear,
            energy: activeShow.energy,
            genreStrict: activeShow.genreStrict,
          }
        : null,
      candidates: candidates.map(c => {
        const a = analysisFor(c);
        return {
          id: c.id,
          title: c.title,
          artist: c.artist,
          album: c.album || null,
          year: c.year || null,
          genre: c.genre || null,
          moods: c.moods || [],
          energy: c.energy || null,
          // Measured acoustic facts — omitted (undefined) when un-analysed so
          // the LLM only sees them when they're real.
          bpm: a.bpm ?? undefined,
          key: a.key ?? undefined,
          // Perceptual energy 0..1 (mean pace), decoupled from BPM — lets the
          // pick reason about build/release arcs, not just tempo. Omitted when
          // un-analysed.
          pace: c.paceMean ?? undefined,
          // Structural-part count over the opening (arrangement complexity).
          // Mirrors the agent picker's `sections` (llm/tools.ts slim) so the
          // shared PICKER_CRITERIA holds for both pick strategies.
          sections: Array.isArray(c.structure) && c.structure.length ? c.structure.length : undefined,
          source: c._source || null,
          // Cosine similarity to the current track for the KNN sources
          // (embedding-similar / audio-similar). Omitted for the other sources,
          // which carry no similarity score. Lets the pick reason lean on "very
          // close match" vs "loose neighbour".
          similarity: c._similarity != null ? Math.round(c._similarity * 100) / 100 : undefined,
        };
      }),
      recentPlays,
      context: ctx,
    });
  } catch (err) {
    // The LLM pick failed outright (e.g. unparseable structured output even
    // after the recovery attempt). We still hold a balanced, shuffled pool —
    // take the top candidate rather than returning null, which would starve
    // the queue and drop the stream to the generic auto.m3u playlist.
    queue.log('error', `picker LLM failed: ${err.message} — falling back to first pool candidate`);
    return {
      song: candidates[0],
      reason: 'fallback (LLM pick failed)',
      source: candidates[0]._source,
    };
  }

  const chosen = candidates.find(c => c.id === pickRaw?.id);
  if (!chosen) {
    queue.log(
      'error',
      `picker returned unknown id ${pickRaw?.id}; falling back to first candidate`,
    );
    return {
      song: candidates[0],
      reason: 'fallback (LLM returned invalid id)',
    };
  }

  return {
    song: chosen,
    reason: pickRaw.reason || null,
    source: chosen._source,
  };
}
