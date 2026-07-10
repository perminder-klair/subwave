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
import { nearestId } from '../llm/sdk.js';
import { logEvent } from '../observability/events.js';
import * as settings from '../settings.js';
import { bpmCompat, keyCompat } from './mix.js';
import { shuffle } from '../util/shuffle.js';
import { filterPickerCandidates, recencyWindowsForLibrary, effectiveNoRepeatWindow } from './recency.js';
import { normGenre, genreMatches, preferGenre, preferEra, inYearRange, preferEnergy, preferEnergyStrict, preferMood, hasEraBound, eraSpan, type YearRange } from './show-filter.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds, type PlaylistPool } from './show-playlist.js';

// A track flowing through the pool builder — a raw Subsonic child, a slimTrack
// library row, or a Last.fm-derived stub, tagged with the internal _source /
// _similarity the pool stamps on. Every field is optional because each source
// carries a different subset; the picker reads only these. Structurally a
// superset of show-filter's FilterTrack and recency's CandidateLike, so it
// flows into both without a cast.
interface Candidate {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  genre?: string | null;
  duration?: number | null;
  moods?: string[] | null;
  energy?: string | null;
  paceMean?: number | null;
  bpm?: number | null;
  key?: string | null;
  structure?: unknown[] | null;
  _source?: string | null;
  _similarity?: number | null;
}

// A play-history entry as summariseRecent reads it — the live queue wraps each
// track in `{ track }`. `track` is required here so the recent-summary mapper
// can read title/artist/id without re-guarding what the `current`/`history`
// guards already established.
interface QueueEntry {
  track: Candidate;
}

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
// A show anchored to Navidrome playlist(s): the union is the dominant source
// (soft) or — after the strict end-filter below — the show's entire universe.
// Mirrors the show-genre caps so playlist tracks fill most of the final pool.
const CAP_SHOW_PLAYLIST = 12;
const CAP_SHOW_PLAYLIST_STRICT = 24;
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

// --- Tempo / harmonic compatibility (Stage B, soft re-rank only) -----------
// These bias the pool ordering toward smoother transitions; they are NEVER a
// hard filter, and a track with NULL bpm/key contributes a 0 bonus (so it
// keeps its random position). An entirely un-analysed library therefore ranks
// exactly as a plain shuffle — today's behaviour.

// Pull bpm/musical_key for a candidate — library.bpmKeyFor prefers the
// analyzer's numbers over the candidate's own fields (a Subsonic candidate's
// bpm is Navidrome's ID3-derived value, 0 on un-tagged files; #862). Also
// carries the boundary keys (keyStart/keyEnd, feature: key ranges).
function analysisFor(t: Candidate): { bpm: number | null; key: string | null; keyStart?: string | null; keyEnd?: string | null } {
  return library.bpmKeyFor(t);
}

// bpmCompat / keyCompat now live in ./mix.js (single source of truth, shared
// with the DJ-mix transition features); imported above.

// Order the pool by a random base nudged up for tempo/harmonic compatibility
// with the current track. Random stays dominant so the pool keeps its variety
// and a NULL-analysis pool is indistinguishable from shuffle(). Key compares
// the pair the transition actually meets — the anchor's ENDING key against
// each candidate's OPENING key (feature: key ranges) — falling back to the
// dominant keys (a mini-run rankTarget carries only a dominant key).
function softRankByCompat(pool: Candidate[], current: { bpm: number | null; key: string | null; keyEnd?: string | null }): Candidate[] {
  if (current.bpm == null && current.key == null) return shuffle(pool);
  return pool
    .map((t) => {
      const a = analysisFor(t);
      const bonus = 0.4 * bpmCompat(current.bpm, a.bpm) + 0.3 * keyCompat(current.keyEnd ?? current.key, a.keyStart ?? a.key);
      return { t, score: Math.random() + bonus };
    })
    .sort((x, y) => y.score - x.score)
    .map((s) => s.t);
}

// --- Show music-steering filters -------------------------------------------
// A show can pin a mood, a genre, a decade (fromYear/toYear) and an energy
// band. By default none is a hard filter: each prefers matching tracks but
// falls back to the full set when matches are too thin to fill the pool, so a
// sparse genre or an un-analysed library never starves the stream.
//
// `strict` (show.filtersStrict) opts EVERY set filter into a hard filter: the
// discovery sources are mood/genre/era/energy-filtered before they enter the
// pool, so the pool is genuinely filter-dominated rather than just shrunk. The
// same never-starve fallback applies per dimension — a constraint too thin to
// fill the pool degrades to off-filter tracks rather than dead air (logged by
// the caller for genre).

// Multi-value lists (#929): OR within an attribute, AND across attributes.
// Empty list = no constraint on that attribute.
type ShowFilter = { moods: string[]; genres: string[]; eras: YearRange[]; energies: string[]; strict?: boolean } | null;

function hasMusicFilter(f: ShowFilter): boolean {
  return !!f && (f.genres.length > 0 || hasEraBound(f.eras));
}

// Genre / energy / era helpers (normGenre / genreMatches / preferGenre /
// preferEnergy / inYearRange) live in ./show-filter.js — shared with the agent
// picker's discovery tools so every path agrees on what "in-genre" / "in-era" /
// "in-energy" means. Caller here keeps its own never-starve fallback for the
// year window (the in-range-or-full pattern below).

function notRecent(recentIds: Set<string>) {
  return (t: Candidate) => t && t.id && !recentIds.has(t.id);
}

function sampleWithRecentFallback(items: Candidate[], recentIds: Set<string>, cap: number): Candidate[] {
  const fresh = items.filter(notRecent(recentIds));
  return (fresh.length > 0 ? fresh : items).slice(0, cap);
}

// Walk a list of albums and return up to `perAlbum` tracks from each, capped.
async function tracksFromAlbums(albums: { id: string }[], perAlbum: number, max: number) {
  const out: Candidate[] = [];
  for (const a of albums) {
    if (out.length >= max) break;
    try {
      const songs = await subsonic.getAlbum(a.id);
      out.push(...shuffle(songs).slice(0, perAlbum));
    } catch {}
  }
  return out;
}

async function buildCandidates(mood: string | null | undefined, recentIds: Set<string>, recentArtists: Set<string>, currentTrack: Candidate | null, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, showFilter: ShowFilter = null, hardRecentIds: Set<string> = new Set(), hardRecentKeys: Set<string> = new Set(), playlistPool: PlaylistPool | null = null, playlistStrict = false) {
  await library.load();
  const pool: Candidate[] = [];
  const sources: Record<string, number> = {};
  const add = (label: string, items: Candidate[]) => {
    if (!items?.length) return;
    pool.push(...items.map((t) => ({ ...t, _source: label })));
    sources[label] = (sources[label] || 0) + items.length;
  };
  // A non-empty playlist anchor on this show: the union of its tracks. Strict
  // mode (below) hard-filters the final pool to it; soft just lets it dominate.
  const hasPlaylist = !!playlistPool?.tracks?.length;
  const strictPlaylist = hasPlaylist && playlistStrict;
  // When a show pins a genre/decade OR a playlist, shrink the unrelated
  // discovery sources so the dedicated show source dominates the candidate list.
  const narrow = hasMusicFilter(showFilter) || hasPlaylist;
  const nz = (cap: number) => (narrow ? Math.max(2, Math.ceil(cap * SHOW_NARROW_FACTOR)) : cap);

  // Strict filters (show.filtersStrict): every SET filter — genre, era, mood,
  // energy — becomes a hard filter on the discovery sources before they enter
  // the pool, making the pool genuinely filter-dominated, not just shrunk.
  // Each dimension keeps its own never-starve fallback (preferGenre/preferEra/
  // preferMood/preferEnergyStrict all fall back to the full set on zero
  // matches), so a thin constraint degrades rather than strands the show.
  // Soft mode leaves the sources untouched (only the nz() shrink applies).
  const strict = !!(showFilter?.strict
    && (showFilter.genres.length || showFilter.moods.length || showFilter.energies.length
      || hasEraBound(showFilter.eras)));
  // Resolve the show's free-text genres to the library's exact tags ONCE, up
  // front. A resolution failure drops that entry (never-starve: none resolving
  // means no genre filter at all, so misspelled genres never strand the show).
  const strictGenres: string[] = [];
  if (strict && showFilter?.genres.length) {
    for (const g of showFilter.genres) {
      try {
        const resolved = await subsonic.resolveGenreName(g);
        if (resolved) strictGenres.push(resolved);
      } catch {}
    }
  }
  // Hard-prefer every set filter on a discovery source in strict mode; a no-op
  // otherwise. Each prefer* falls back to the full set when nothing in the
  // source matches, so leaning a source can only tighten, never starve it.
  const lean = (items: Candidate[]): Candidate[] => {
    if (!strict) return items;
    let out = items;
    if (strictGenres.length) out = preferGenre(out, strictGenres);
    out = preferEra(out, showFilter!.eras);
    out = preferMood(out, showFilter!.moods);
    out = preferEnergyStrict(out, showFilter!.energies);
    return out;
  };

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

  // 1e. Show genres / decades — the soft-dominant source when a show pins
  // genres or year windows. getRandomSongs takes ONE genre + ONE contiguous
  // year range natively, so with multiple values we call per genre (splitting
  // the size budget) against the eras' coarse envelope (eraSpan), then post-
  // filter the genre-tagged sets to the exact era union (inYearRange). The
  // whole collection is then energy-preferred. Never a hard filter — see helpers.
  if (hasMusicFilter(showFilter)) {
    try {
      // Reuse the strict-resolved tags when we already paid for them above;
      // only resolve here on the soft path (or if strict resolution came back
      // empty). Unresolvable genres drop out (never-starve).
      const genreNames: string[] = strict ? [...strictGenres] : [];
      if (!genreNames.length && showFilter!.genres.length) {
        for (const g of showFilter!.genres) {
          try {
            const resolved = await subsonic.resolveGenreName(g);
            if (resolved) genreNames.push(resolved);
          } catch {}
        }
      }
      const span = eraSpan(showFilter!.eras);
      const collected: Candidate[] = [];
      const randomSize = strict ? 60 : 40;
      const genreSetSize = strict ? 100 : 60;
      for (const genreName of genreNames.length ? genreNames : [undefined]) {
        collected.push(...await subsonic.getRandomSongs({
          size: Math.ceil(randomSize / Math.max(1, genreNames.length)),
          genre: genreName,
          fromYear: span.fromYear ?? undefined,
          toYear: span.toYear ?? undefined,
        }));
        if (genreName) {
          const g = await subsonic.getSongsByGenre(genreName, { count: Math.ceil(genreSetSize / genreNames.length) });
          const ranged = inYearRange(g, showFilter!.eras);
          collected.push(...(ranged.length ? ranged : g));
        }
      }
      // The random fetch used the coarse era envelope — tighten to the exact
      // window union here (never-starve: keep the envelope set if the exact
      // union would empty the source).
      const exact = hasEraBound(showFilter!.eras) ? inYearRange(collected, showFilter!.eras) : collected;
      // Genre/era are already native to this source; lean() adds the strict
      // mood/energy filters on top (no-op in soft mode).
      const leaned = lean(preferEnergy(exact.length ? exact : collected, showFilter!.energies));
      // Strict bumps the cap so this genre-native source dominates the merged pool.
      add('show-genre', sampleWithRecentFallback(shuffle(leaned), recentIds, strict ? CAP_SHOW_GENRE_STRICT : CAP_SHOW_GENRE));
    } catch {}
  }

  // 1f. Show-anchored Navidrome playlist(s) — the operator's explicit per-show
  // curation. In strict mode this is the show's entire universe (the final pool
  // is hard-filtered to its ids below); in soft mode it's just the dominant
  // source, with the discovery sources contributing a (narrowed) minority.
  if (hasPlaylist) {
    add('show-playlist', sampleWithRecentFallback(shuffle(playlistPool!.tracks), recentIds, strictPlaylist ? CAP_SHOW_PLAYLIST_STRICT : CAP_SHOW_PLAYLIST));
  }

  // 2. Mood-tagged library (LLM-built tags, may be sparse). A multi-mood show
  // pools ALL its moods equally (#929); autonomous hours keep the single
  // dominantMood. Dedup by id across the unioned mood sets.
  const poolMoods = showFilter?.moods.length ? showFilter.moods : (mood ? [mood] : []);
  if (poolMoods.length) {
    const seenMoodIds = new Set<string>();
    const moodPool: Candidate[] = [];
    for (const m of poolMoods) {
      for (const t of library.songsByMood(m)) {
        if (t?.id && seenMoodIds.has(t.id)) continue;
        if (t?.id) seenMoodIds.add(t.id);
        moodPool.push(t);
      }
    }
    const moodHits = shuffle(lean(preferEnergy(moodPool, showFilter?.energies)));
    add('mood-library', sampleWithRecentFallback(moodHits, recentIds, CAP_MOOD_LIBRARY));
  }

  // 3. Mood-matched Navidrome playlists — operator's hand curation. Skipped when
  // the show already pins its own playlist(s) (1f): the operator has named exactly
  // which playlists to use, so also grabbing every playlist whose name merely
  // contains the mood word would leak other shows' same-mood playlists into the
  // pool (#642). Autonomous hours (no pinned playlists) keep the mood match.
  if (poolMoods.length && !hasPlaylist) {
    try {
      const playlists = await memo('playlists', CACHE_TTL_MS, () => subsonic.getPlaylists());
      const matched = playlists.filter((p: { name?: string | null }) =>
        poolMoods.some(m => p.name?.toLowerCase().includes(m.toLowerCase())));
      const plTracks: Candidate[] = [];
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
          const collected: Candidate[] = [];
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

  // Strict playlist: the playlist union is the show's whole universe, so drop
  // every off-playlist candidate (the discovery sources above) before ranking.
  // The dedicated show-playlist source guarantees in-playlist tracks are here,
  // so this is normally a clean filter; never-starve to the unfiltered pool only
  // if NOT ONE playlist track survived (a true dead-air guard). Recency / no-
  // repeat still apply below — they relax within the filtered set as usual.
  let selectionPool = pool;
  let playlistInfo: { names: string[]; matched: number; total: number } | null = null;
  if (strictPlaylist) {
    const inPl = pool.filter((t) => t?.id && playlistPool!.ids.has(t.id));
    if (inPl.length) selectionPool = inPl;
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
  const final = filterPickerCandidates(softRankByCompat(selectionPool, curAnalysis), {
    recentIds,
    recentArtists,
    hardRecentIds,
    hardRecentKeys,
    artistCounts: perArtist,
    maxPerArtist: MAX_PER_ARTIST,
    cap: CANDIDATE_CAP,
  });

  // Strict-genre diagnostics for the caller's never-starve log: how much of the
  // final pool actually landed in-genre. `resolved` is null when NONE of the
  // show's genres mapped to a library tag (strict silently degraded to soft).
  let strictInfo: { requested: string; resolved: string | null; matched: number; total: number } | null = null;
  if (strict && showFilter?.genres.length) {
    const targets = strictGenres.map(normGenre).filter(Boolean);
    strictInfo = {
      requested: showFilter.genres.join(', '),
      resolved: strictGenres.length ? strictGenres.join(', ') : null,
      matched: targets.length ? final.filter((t) => genreMatches(t, targets)).length : 0,
      total: final.length,
    };
  }

  // Playlist-anchor diagnostics for the caller's log: how much of the final pool
  // is actually in-playlist. In strict mode this is the never-starve audit; in
  // soft mode it shows how strongly the anchor dominated.
  if (hasPlaylist) {
    playlistInfo = {
      names: playlistPool!.names,
      matched: final.filter((t) => t?.id && playlistPool!.ids.has(t.id)).length,
      total: final.length,
    };
  }

  return { candidates: final, sources, strictInfo, playlistInfo };
}

function summariseRecent(queue: { current?: QueueEntry | null; history: QueueEntry[] }) {
  const items: QueueEntry[] = [];
  if (queue.current) items.push(queue.current);
  items.push(...queue.history.slice(0, HISTORY_DEPTH));
  return items
    .filter((i) => i?.track?.title)
    .map((i) => {
      const tags = i.track.id ? library.get(i.track.id) : null;
      // Empty fields are omitted, not nulled — `"moods": [], "energy": null`
      // on every un-tagged entry was pure token spend (the payload is compact
      // JSON now, and JSON.stringify drops undefined).
      return {
        title: i.track.title,
        artist: i.track.artist,
        moods: tags?.moods?.length ? tags.moods : undefined,
        energy: tags?.energy || undefined,
      };
    });
}

// The album line only earns its tokens when it says something the title
// doesn't — "Aja - Single" next to the title "Aja" is noise on every single
// release in the pool.
function slimAlbum(album: string | null | undefined, title: string | null | undefined): string | undefined {
  if (!album) return undefined;
  const stripped = String(album).replace(/\s*-\s*(Single|EP)$/i, '').trim();
  return stripped.toLowerCase() === String(title || '').trim().toLowerCase() ? undefined : album;
}

// ---------------------------------------------------------------------------
// Pool path — build a candidate pool, ask the LLM to choose one. Returns
// { song, reason, source } or null. Used by broadcast/dj-agent.js.
// ---------------------------------------------------------------------------

export async function pickViaPool(queue, ctx, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null) {
  await library.load();
  const stats = library.stats();
  const windows = recencyWindowsForLibrary(stats.distinctArtists);
  const recentIds = queue.recentlyPlayedIds(windows.trackHours);
  const recentArtists = queue.recentArtistsSince(windows.artistHours);
  // Count-based HARD no-repeat guard (last N distinct plays) — non-relaxable,
  // survives buildCandidates' starvation cascade. Clamped to library size so a
  // small catalogue never fully blocks; 0 = off. Mirrors the agent path.
  const effN = effectiveNoRepeatWindow(settings.get().llm?.noRepeatWindow ?? 0, stats.total);
  const { ids: hardRecentIds, keys: hardRecentKeys } = queue.recentlyPlayedByCount(effN);
  const currentTrack = queue.current?.track || null;
  // Resolve the active show once: its music-steering filters shape the pool
  // (below) and its brief steers the LLM pick (further down). Prefer the show
  // already resolved into ctx — near a show boundary the queue watcher passes
  // a look-ahead context (getFullContext at the pick's expected airtime), so
  // the pool follows the show that will be on air when the pick plays, and
  // stays consistent with ctx.dominantMood below. Contexts without the field
  // (picker-test's stub) fall back to resolving at now.
  const activeShow = ctx?.activeShow !== undefined ? ctx.activeShow : settings.resolveActiveShow();
  const showFilter: ShowFilter = activeShow
    ? {
        moods: activeShow.moods ?? [],
        genres: activeShow.genres ?? [],
        eras: activeShow.eras ?? [],
        energies: activeShow.energies ?? [],
        strict: activeShow.filtersStrict,
      }
    : null;
  // Resolve the show's anchored Navidrome playlist(s), if any, into a deduped
  // track pool. Null when the show pins none (the common case → pool unchanged).
  const playlistPool = activeShow ? await resolveShowPlaylistPool(activeShow) : null;
  const playlistStrict = !!activeShow?.playlistStrict;
  const excludedIds = activeShow ? await resolveExcludedPlaylistIds(activeShow) : null;
  const { candidates: rawCandidates, sources, strictInfo, playlistInfo } = await buildCandidates(ctx.dominantMood, recentIds, recentArtists, currentTrack, rankTarget, audioWaypoint, showFilter, hardRecentIds, hardRecentKeys, playlistPool, playlistStrict);

  // Excluded playlists (blocklist): drop any track whose id appears in the
  // show's excluded playlist union. Applied after buildCandidates so the full
  // pool is built first; no never-starve fallback — the blocklist is hard.
  const candidates = excludedIds
    ? rawCandidates.filter((t) => t?.id && !excludedIds.has(t.id))
    : rawCandidates;

  if (candidates.length === 0) {
    queue.log('picker', 'no candidates available, skipping LLM pick');
    return null;
  }

  queue.log(
    'picker',
    `pool ${candidates.length} (${Object.entries(sources)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')})${effN > 0 ? ` no-repeat=${effN}` : ''}`,
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

  // Playlist-anchor visibility — same idea: surface how much of the pool came
  // from the show's pinned playlist(s), and whether strict had to never-starve.
  if (playlistInfo) {
    const tag = playlistInfo.names.length ? playlistInfo.names.join(', ') : `${activeShow!.playlistIds.length} playlist(s)`;
    if (playlistStrict && playlistInfo.matched === 0) {
      queue.log('picker', `strict playlist [${tag}]: 0 in-playlist candidates — falling back to keep the stream alive`);
    } else {
      queue.log('picker', `playlist [${tag}]: ${playlistInfo.matched}/${playlistInfo.total} in-playlist${playlistStrict ? ' (strict)' : ''}`);
    }
  }

  const recentPlays = summariseRecent(queue);
  // The model's recent transition asks, for the deliberate-variety nudge —
  // only consulted by pickNextTrack when effects are active. Guarded call:
  // picker-test.mjs drives this path with a stub queue.
  const recentTransitions = typeof queue.recentTransitionChoices === 'function'
    ? queue.recentTransitionChoices()
    : [];

  let pickRaw;
  try {
    // Same show-brief plumbing as the agent picker (dj-agent.pickSystem) —
    // this is its fallback, so it must honour the brief too.
    pickRaw = await dj.pickNextTrack({
      show: activeShow
        ? {
            name: activeShow.name,
            topic: activeShow.topic,
            moods: activeShow.moods,
            genres: activeShow.genres,
            eras: activeShow.eras,
            energies: activeShow.energies,
            filtersStrict: activeShow.filtersStrict,
          }
        : null,
      candidates: candidates.map(c => {
        const a = analysisFor(c);
        // Join editorial tags + perceptual analysis from the library store when
        // the candidate doesn't carry them: Subsonic-sourced candidates (similar,
        // recent, frequent, starred…) are raw Navidrome children with none of
        // these fields, so without this join half the pool competed blind on the
        // criteria PICKER_CRITERIA asks the model to weigh (#862). Same join
        // summariseRecent below already does.
        const rec = c.id ? library.get(c.id) : null;
        const moods = (Array.isArray(c.moods) && c.moods.length ? c.moods : rec?.moods) || [];
        return {
          id: c.id,
          title: c.title,
          artist: c.artist,
          // Absent-when-empty throughout (undefined drops out of the JSON):
          // a mostly-untagged pool used to ship `"moods": [], "energy": null,
          // "album": null…` on every candidate — hundreds of tokens that told
          // the model nothing.
          album: slimAlbum(c.album, c.title),
          year: c.year || undefined,
          genre: c.genre || undefined,
          moods: moods.length ? moods : undefined,
          energy: c.energy || rec?.energy || undefined,
          // Track length in seconds — lets the pick weigh a 9-minute epic
          // against the daypart (length is an on-air cut, never a pool filter
          // — #447 — so the model is the only place it can be weighed).
          secs: c.duration ?? rec?.duration_sec ?? undefined,
          // Measured acoustic facts — omitted (undefined) when un-analysed so
          // the LLM only sees them when they're real.
          bpm: a.bpm ?? undefined,
          key: a.key ?? undefined,
          // Perceptual energy 0..1 (mean pace), decoupled from BPM — lets the
          // pick reason about build/release arcs, not just tempo. Omitted when
          // un-analysed.
          pace: c.paceMean ?? rec?.paceMean ?? undefined,
          // Structural-part count over the opening (arrangement complexity).
          // Mirrors the agent picker's `sections` (llm/tools.ts slim) so the
          // shared PICKER_CRITERIA holds for both pick strategies.
          sections: library.sectionCount(c) ?? library.sectionCount(rec) ?? undefined,
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
      // The on-air anchor for FLOW: title/artist plus measured tempo/key/pace
      // when the current track is analysed. Without this the criteria asked
      // the model to match "the current" tempo it was never told.
      current: currentTrack ? (() => {
        const ca = analysisFor(currentTrack);
        const crec = currentTrack.id ? library.get(currentTrack.id) : null;
        return {
          title: currentTrack.title,
          artist: currentTrack.artist,
          bpm: ca.bpm ?? undefined,
          key: ca.key ?? undefined,
          pace: currentTrack.paceMean ?? crec?.paceMean ?? undefined,
        };
      })() : null,
      recentTransitions,
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

  let chosen = candidates.find(c => c.id === pickRaw?.id);
  // Near-miss repair, same as the agent path (#939): small local models can't
  // reproduce a 22-char nanoid verbatim, so an id 1-3 edits from a real
  // candidate is that candidate mistranscribed, not a different pick. Free —
  // no model call — and only runs when the exact match above already missed.
  if (!chosen && pickRaw?.id) {
    const fixed = nearestId(pickRaw.id, candidates.map(c => c.id).filter((id): id is string => Boolean(id)));
    if (fixed) {
      logEvent('pick.repaired', { agent: 'pool', from: pickRaw.id, to: fixed });
      queue.log('picker', `pool pick id "${pickRaw.id}" repaired to near-miss match "${fixed}"`);
      chosen = candidates.find(c => c.id === fixed);
    }
  }
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
    // Present only when effects were active at call time (the schema omits the
    // field otherwise). The caller maps it to the queued track's effect flags;
    // the queue's applyMixTransition validates/strips it like any agent pick.
    transition: pickRaw.transition ?? null,
  };
}
