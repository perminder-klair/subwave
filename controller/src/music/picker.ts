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
import { mapPool } from '../util/async-pool.js';
import { artistRootKey, filterPickerCandidates, recencyWindowsForLibrary } from './recency.js';
import { AIRING_RANK_WEIGHT, freshness, freshnessBiasedOrder, lastAiredMsOf, unairedFlag, type AiredIndex } from './airing.js';
import { normGenre, genreMatches, genreResolutionWarningOnce, preferGenre, preferEra, inYearRange, preferEnergy, preferEnergyStrict, preferMood, preferVocals, applyStrictLocks, hasEraBound, eraSpan, type YearRange, type VocalMode } from './show-filter.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds, type PlaylistPool } from './show-playlist.js';
import { effectiveShowNoRepeatWindow } from './show-recency.js';
import * as likes from '../broadcast/likes.js';

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
const CAP_LIKED = 4;
const CAP_EXPLORE = 4;
const CAP_MOOD_WILDCARD = 3;
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
// In-flight Navidrome queries when fanning the show-genre source out across a
// multi-genre show (up to SHOW_FILTER_VALUES_MAX values × 2 fetches each).
// Small on purpose — see the fan-out below.
const SHOW_GENRE_FETCH_CONCURRENCY = 4;

// TTL cache for sources that don't change between picks. Without this, every
// pick would re-fetch playlists, recent/frequent album lists and re-walk their
// tracks — turning ~1 Navidrome call per pick into ~15.
const CACHE_TTL_MS = 30 * 60 * 1000;
// Shorter TTL for an EMPTY result. An empty answer is not knowledge worth
// pinning for the full 30 minutes — a momentary Navidrome miss used to blank
// that source until the TTL rolled. But not caching it AT ALL is the opposite
// failure: a PERMANENTLY empty source re-runs its whole fetch chain on every
// pick, forever. `similar-artist` is the sharp end — on a niche or regional
// catalogue where the on-air artist has no Last.fm coverage that is
// searchArtists + getArtistInfo + up to two getTopSongs, four upstream calls
// per pick, and the memo exists precisely to stop ~1 Navidrome call per pick
// becoming ~15. Same for `playlists` on a Navidrome with no playlists and for
// the recent/frequent track pools whenever tracksFromAlbums comes back empty.
// A few minutes clears a transient blank within a pick or two while a
// permanent one costs one refetch per window instead of one per pick.
const EMPTY_CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
async function memo(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.until) return hit.val;
  const val = await fn();
  const isEmpty = Array.isArray(val) ? val.length === 0 : val == null;
  cache.set(key, { val, until: Date.now() + (isEmpty ? Math.min(EMPTY_CACHE_TTL_MS, ttl) : ttl) });
  return val;
}

// Drop every memoised Subsonic result. Called when the admin points the
// station at different Navidrome creds — the cached playlists/albums carry
// song ids from the OLD server, which would feed the picker junk for up to
// CACHE_TTL_MS otherwise.
export function clearPoolCache() {
  cache.clear();
  offered.clear();
}

// Offered-but-not-picked memory. The 30-min memos mean several consecutive
// picks draw the non-similarity half of the pool from the SAME frozen fetches,
// and nothing used to remember which candidates the model had already been
// shown and passed over — so the same names re-surfaced pick after pick for
// the whole TTL. Each time a candidate reaches the final pool without being
// chosen it accrues a soft ranking penalty (capped, decaying with the memo
// window); the chosen track's entry clears. A penalty, never a filter — a
// repeatedly-offered track can still win when it genuinely fits.
const OFFER_PENALTY = 0.15;
const OFFER_PENALTY_CAP = 0.45;
const offered = new Map<string, { count: number; at: number }>();

function offerPenalty(id: string | undefined, nowMs: number): number {
  if (!id) return 0;
  const e = offered.get(id);
  if (!e || nowMs - e.at > CACHE_TTL_MS) return 0;
  return Math.min(OFFER_PENALTY_CAP, e.count * OFFER_PENALTY);
}

function recordOffered(ids: Array<string | undefined>) {
  const now = Date.now();
  // Lazy sweep so the map tracks the live memo window, not all time.
  if (offered.size > 500) {
    for (const [id, e] of offered) {
      if (now - e.at > CACHE_TTL_MS) offered.delete(id);
    }
  }
  for (const id of ids) {
    if (!id) continue;
    const e = offered.get(id);
    offered.set(id, { count: (e?.count ?? 0) + 1, at: now });
  }
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
// with the current track AND for airing freshness (music/airing.ts) — tracks
// the station has never aired, or hasn't aired in weeks, are likelier to
// survive the CANDIDATE_CAP slice. Random stays dominant so the pool keeps its
// variety; an un-analysed library with no play history ranks exactly as a
// plain shuffle. Key compares the pair the transition actually meets — the
// anchor's ENDING key against each candidate's OPENING key (feature: key
// ranges) — falling back to the dominant keys (a mini-run rankTarget carries
// only a dominant key).
function softRankByCompat(pool: Candidate[], current: { bpm: number | null; key: string | null; keyEnd?: string | null }, aired: AiredIndex): Candidate[] {
  const now = Date.now();
  const hasAnchor = current.bpm != null || current.key != null;
  return pool
    .map((t) => {
      const compat = hasAnchor
        ? (() => {
            const a = analysisFor(t);
            return 0.4 * bpmCompat(current.bpm, a.bpm) + 0.3 * keyCompat(current.keyEnd ?? current.key, a.keyStart ?? a.key);
          })()
        : 0;
      const fresh = AIRING_RANK_WEIGHT * freshness(lastAiredMsOf(t, aired), now);
      return { t, score: Math.random() + compat + fresh - offerPenalty(t.id, now) };
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
type ShowFilter = { moods: string[]; genres: string[]; eras: YearRange[]; energies: string[]; vocals: VocalMode; strict?: boolean } | null;
type StrictGenreResolution = { genres: string[]; warnings: string[] };

async function resolveStrictGenres(showFilter: ShowFilter): Promise<StrictGenreResolution> {
  const genres: string[] = [];
  const warnings: string[] = [];
  if (!showFilter?.strict || !showFilter.genres.length) return { genres, warnings };
  for (const g of showFilter.genres) {
    try {
      const resolved = await subsonic.resolveGenreName(g);
      const warning = genreResolutionWarningOnce(g, resolved);
      if (warning) warnings.push(warning);
      if (resolved) genres.push(resolved);
    } catch {}
  }
  return { genres, warnings };
}

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

// Fresh-only sample: recently-played items drop, full stop. This used to
// never-starve (return the UNFILTERED list when everything was recent), which
// re-emitted exactly the tracks that just played from the narrowest sources —
// the moment a similarity cluster was fully aired, the guard against
// repetition became a source of it. Genuine starvation is handled at wider
// scopes: the final pool has its own relaxation cascade, the unconditional
// explore slot keeps the pool fed, and behind everything sits the auto.m3u
// coast — so a source with nothing fresh should say so by contributing
// nothing.
function sampleFresh(items: Candidate[], recentIds: Set<string>, cap: number): Candidate[] {
  return items.filter(notRecent(recentIds)).slice(0, cap);
}

// The DEDICATED SHOW sources (show-genre, show-playlist) keep the never-starve
// that sampleFresh drops, because zero from them does not mean the same thing.
//
// A discovery source contributing nothing just removes itself and the others
// carry the pick. These two are the pool's only in-filter contributors, and the
// STRICT end-filters never-starve on an empty result — `if (inPl.length)` keeps
// the FULL pool when no playlist track survived, and applyStrictLocks(starve:
// false) skips a dimension with zero matches. So a show pinned to a 40-track
// playlist whose tracks all sit inside the recency window would contribute
// nothing here and then be handed nothing BUT off-playlist candidates: the exact
// opposite of what the lock is for. Same path for a strict-genre show.
//
// Recency still wins whenever anything fresh exists; this fires only when the
// alternative is abandoning the show's own universe. The HARD no-repeat guard is
// applied later by filterPickerCandidates and is not relaxed here, so a track
// that just aired still cannot come back — only the softer time-window set is
// re-admitted.
function sampleShowSource(items: Candidate[], recentIds: Set<string>, cap: number): Candidate[] {
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

async function buildCandidates(mood: string | null | undefined, recentIds: Set<string>, recentKeys: Set<string>, recentArtists: Set<string>, currentTrack: Candidate | null, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, showFilter: ShowFilter = null, hardRecentIds: Set<string> = new Set(), hardRecentKeys: Set<string> = new Set(), playlistPool: PlaylistPool | null = null, playlistStrict = false, blockedArtists: Set<string> = new Set(), strictGenreResolution: StrictGenreResolution = { genres: [], warnings: [] }) {
  await library.load();
  // Airing memory (music/airing.ts) — orders the similarity sources so the
  // unexplored shelf survives their small caps; and the id-level recency union
  // pushed INTO the KNN queries below, so a heavily-aired cluster answers with
  // its next neighbours out instead of thinning toward empty.
  const aired = library.lastAiredInfo();
  const nowMs = Date.now();
  const knnExclude: Set<string> = new Set([...recentIds, ...hardRecentIds]);
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
      || showFilter.vocals || hasEraBound(showFilter.eras)));
  // Resolve the show's free-text genres to the library's exact tags ONCE, up
  // front. A resolution failure drops that entry (never-starve: none resolving
  // means no genre filter at all, so misspelled genres never strand the show).
  const strictGenres = strictGenreResolution.genres;
  // Resolutions that silently broadened / dropped what the operator configured.
  // Surfaced through strictInfo so the caller (which owns `queue`) can log them.
  const genreWarnings = strictGenreResolution.warnings;
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
    out = preferVocals(out, showFilter!.vocals);
    return out;
  };

  // 1. Similar-songs from current track — strongest contextual signal.
  if (currentTrack?.id) {
    try {
      const similar = await subsonic.getSimilarSongs(currentTrack.id, {
        count: 20,
      });
      // Freshness-biased order (never the server's Last.fm rank): an
      // un-shuffled slice pinned the same top-8 popular tracks per seed.
      add('similar', sampleFresh(freshnessBiasedOrder(lean(similar), aired, nowMs), recentIds, nz(CAP_SIMILAR)));
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
      // 30 recency-excluded neighbours, freshness-ordered — the old shape took
      // the literal 4 nearest of 15, deterministic per seed, and contributed
      // zero when the cluster was fully recent (the exact stuck-rotation case).
      const knn = library.tracksLikeThis(currentTrack.id, 30, { excludeIds: knnExclude });
      add('embedding-similar', sampleFresh(freshnessBiasedOrder(lean(knn), aired, nowMs), recentIds, nz(CAP_EMBEDDING_SIMILAR)));
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
        add('sonic-similar', sampleFresh(freshnessBiasedOrder(lean(sonic), aired, nowMs), recentIds, nz(CAP_SONIC_SIMILAR)));
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
      const knn = library.tracksByAudioVector(audioWaypoint, 30, { excludeIds: knnExclude });
      add('audio-journey', sampleFresh(freshnessBiasedOrder(lean(knn), aired, nowMs), recentIds, nz(CAP_AUDIO_SIMILAR)));
    } catch {}
  } else if (currentTrack?.id) {
    try {
      const knn = library.tracksLikeThisAudio(currentTrack.id, 30, { excludeIds: knnExclude });
      add('audio-similar', sampleFresh(freshnessBiasedOrder(lean(knn), aired, nowMs), recentIds, nz(CAP_AUDIO_SIMILAR)));
    } catch {}
  }

  // 1d-bis. Listener favourites (#991) — tracks liked via the player heart, only
  // when the operator opts in (likes.influenceDj). A weighted preference
  // signal, never a lock: capped like every other source so the crowd can
  // steer the pool without taking it over. The store returns [] before its
  // boot-time load resolves, so this is always a silent no-op when cold.
  {
    const likeCfg = settings.get()?.likes;
    if (likeCfg?.enabled && likeCfg?.influenceDj) {
      try {
        const favs = likes
          .topLiked({ windowDays: likeCfg.windowDays, limit: likeCfg.maxTracks })
          .map((f) => f.track);
        add('listener-liked', sampleFresh(lean(shuffle(favs)), recentIds, nz(CAP_LIKED)));
      } catch {}
    }
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
      const randomSize = strict ? 60 : 40;
      const genreSetSize = strict ? 100 : 60;
      // Two fetches per genre. The size budgets DIVIDE, so the collected total
      // is the same whether the show pins 1 genre or 15 — but the round trips
      // don't, which is why they run through mapPool instead of a sequential
      // for-await (a 15-genre strict show would otherwise serialise 30 calls
      // into every pick). Bounded concurrency, not Promise.all: Navidrome is
      // typically a home server and 30 simultaneous queries is a worse
      // neighbour than four at a time. Each genre catches its OWN failure so
      // one flaky fetch degrades that genre instead of losing the whole
      // source — the show's dominant contributor — for this pick.
      const targets: (string | undefined)[] = genreNames.length ? genreNames : [undefined];
      const perGenre = await mapPool(targets, SHOW_GENRE_FETCH_CONCURRENCY, async (genreName) => {
        const got: Candidate[] = [];
        try {
          got.push(...await subsonic.getRandomSongs({
            size: Math.ceil(randomSize / Math.max(1, genreNames.length)),
            genre: genreName,
            fromYear: span.fromYear ?? undefined,
            toYear: span.toYear ?? undefined,
          }));
        } catch {}
        if (genreName) {
          try {
            // Sampled: a random page of the genre rather than the same
            // server-ordered head every pick (see getSongsByGenreSampled).
            const g = await subsonic.getSongsByGenreSampled(genreName, { count: Math.ceil(genreSetSize / genreNames.length) });
            const ranged = inYearRange(g, showFilter!.eras);
            got.push(...(ranged.length ? ranged : g));
          } catch {}
        }
        return got;
      });
      const collected: Candidate[] = perGenre.flat();
      // The random fetch used the coarse era envelope — tighten to the exact
      // window union here (never-starve: keep the envelope set if the exact
      // union would empty the source).
      const exact = hasEraBound(showFilter!.eras) ? inYearRange(collected, showFilter!.eras) : collected;
      // Genre/era are already native to this source; lean() adds the strict
      // mood/energy filters on top (no-op in soft mode).
      const leaned = lean(preferEnergy(exact.length ? exact : collected, showFilter!.energies));
      // Strict bumps the cap so this genre-native source dominates the merged pool.
      add('show-genre', sampleShowSource(shuffle(leaned), recentIds, strict ? CAP_SHOW_GENRE_STRICT : CAP_SHOW_GENRE));
    } catch {}
  }

  // 1f. Show-anchored Navidrome playlist(s) — the operator's explicit per-show
  // curation. In strict mode this is the show's entire universe (the final pool
  // is hard-filtered to its ids below); in soft mode it's just the dominant
  // source, with the discovery sources contributing a (narrowed) minority.
  if (hasPlaylist) {
    add('show-playlist', sampleShowSource(shuffle(playlistPool!.tracks), recentIds, strictPlaylist ? CAP_SHOW_PLAYLIST_STRICT : CAP_SHOW_PLAYLIST));
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
    add('mood-library', sampleFresh(moodHits, recentIds, CAP_MOOD_LIBRARY));

    // Mood wildcard — autonomous hours only (a show's pinned moods are
    // operator intent). Only ~8 of the 17-mood vocabulary ever become the
    // autonomous dominantMood (the period/weather maps), so the pool's one
    // broad sampler cycled the same few buckets all day; a taste of one
    // random OTHER mood walks the rest of the vocabulary over time. Tiny cap:
    // seasoning, not a second mood source.
    if (!showFilter?.moods.length) {
      try {
        const others = settings.moodVocab().filter((m: string) => !poolMoods.includes(m));
        if (others.length) {
          const wild = others[Math.floor(Math.random() * others.length)];
          add('mood-wildcard', sampleFresh(shuffle(library.songsByMood(wild)), recentIds, CAP_MOOD_WILDCARD));
        }
      } catch {}
    }
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
      add('playlist', sampleFresh(lean(shuffle(plTracks)), recentIds, nz(CAP_PLAYLIST)));
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
    add('recent', sampleFresh(lean(shuffle(recentPool)), recentIds, nz(CAP_RECENT)));
  } catch {}

  // 5. Frequent albums — scrobble-backed favourites. Same wide-pool-then-
  // shuffle pattern as recently-added above.
  try {
    const freqPool = await memo('frequent-track-pool', CACHE_TTL_MS, async () => {
      // Rotate the window (offset 0/12/24, re-rolled each TTL): "frequent" is
      // ranked by play counts the station itself feeds, so the offset-less
      // top-12 was a positive-feedback loop pinning the same albums for good.
      // An empty deep window (small library) falls back to the top.
      const offset = Math.floor(Math.random() * 3) * 12;
      let albums = await subsonic.getFrequentAlbums({ size: 12, offset });
      if (!albums.length && offset > 0) albums = await subsonic.getFrequentAlbums({ size: 12 });
      return tracksFromAlbums(shuffle(albums), 3, 40);
    });
    add('frequent', sampleFresh(lean(shuffle(freqPool)), recentIds, nz(CAP_FREQUENT)));
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
        // Freshness-ordered: the memo holds a popularity-ranked slice, and an
        // un-shuffled cut of it served the same 4 tracks, in the same order,
        // for the whole 30-minute TTL.
        sampleFresh(freshnessBiasedOrder(lean(similarArtistTracks), aired, nowMs), recentIds, nz(CAP_SIMILAR_ARTIST)),
      );
    } catch {}
  }

  // 7. Exploration slot — ALWAYS contributes, unlike the thin-pool fallback
  // below, which never fires while a track is on air (source 1 alone clears its
  // <8 gate, so the pool held zero Navidrome randomness in the common case). A
  // small server-random sample, freshness-ordered so never-aired tracks lead, is
  // the pool's only library-wide draw not anchored on the current track or a
  // frozen album window — without it every source is a similarity neighbourhood
  // or a fixed crate and the pool can never leave its bubble.
  //
  // Skipped for a strict-playlist show, mirroring the coast's identical source
  // (scheduler.ts §2b — keep the two in step): a library-wide random draw can't
  // be playlist-filtered, so every track it contributes is either discarded by
  // the strict end-filter (a wasted round trip per pick) or, on the never-starve
  // branch, becomes a live OFF-playlist candidate for the LLM. Strict GENRE
  // shows keep it — lean() filters it on the way in, so it still lands
  // in-genre.
  if (!strictPlaylist) {
    try {
      const wide = await subsonic.getRandomSongs({ size: 12 });
      add('explore', sampleFresh(
        lean(freshnessBiasedOrder(wide, aired, nowMs)),
        recentIds,
        nz(CAP_EXPLORE),
      ));
    } catch {}
  }

  // 8. Fallback if the pool is still thin — starred + random.
  if (pool.length < 8) {
    try {
      const starred = await subsonic.getStarred();
      add('starred', sampleFresh(shuffle(starred), recentIds, 4));
    } catch {}
    try {
      const random = await subsonic.getRandomSongs({ size: 10 });
      add('random', sampleFresh(random, recentIds, 4));
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

  // Strict music filters: enforce on the FINAL merged pool too. The per-source
  // lean() alone wasn't enough — any source with zero in-filter matches passed
  // its whole result through (never-starve per source), so the pool the LLM
  // saw was routinely half off-filter and "strict" hinged on prompt
  // compliance (Discord: strict-era show playing pre-era tracks half the time).
  // applyStrictLocks(starve:false) never-starves PER DIMENSION, so a single
  // zero-coverage tag class (e.g. a mood on an un-tagged library) can't throw
  // away the genre/era purity the other dimensions established — the earlier
  // all-or-nothing joint revert did exactly that. genres pre-resolved to
  // library tags above (strictGenres); [] there = no genre step.
  if (strict) {
    selectionPool = applyStrictLocks(selectionPool, {
      genres: strictGenres,
      eras: showFilter!.eras,
      moods: showFilter!.moods,
      energies: showFilter!.energies,
      vocals: showFilter!.vocals,
    }, { starve: false });
  }

  // De-dup by id, cap per artist so one name can't dominate the pool (the LLM
  // can only rotate artists across what it's handed), shuffle, cap. A strict
  // playlist anchor is an intentional single-artist/album pool (selectionPool
  // was already narrowed to inPl above) — capping it here would silently
  // shrink a strict single-artist show down to 3 candidate tracks and defeat
  // the point of pinning that playlist.
  const MAX_PER_ARTIST = strictPlaylist ? Infinity : 3;
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
  const final = filterPickerCandidates(softRankByCompat(selectionPool, curAnalysis, library.lastAiredInfo()), {
    recentIds,
    recentKeys,
    recentArtists,
    hardRecentIds,
    hardRecentKeys,
    artistCounts: perArtist,
    maxPerArtist: MAX_PER_ARTIST,
    cap: CANDIDATE_CAP,
    // Empty except on the agent path's artist-guard rescue (#1187), where it
    // holds the one artist the pool is being asked to steer around. Enforced
    // inside the filter rather than stripped from the result afterwards, so a
    // pool whose only fresh-artist candidates ARE that artist keeps walking the
    // relaxation cascade and finds a different one instead of coming back empty.
    blockedArtists,
  });

  // Strict-genre diagnostics for the caller's never-starve log: how much of the
  // final pool actually landed in-genre. `resolved` is null when NONE of the
  // show's genres mapped to a library tag (strict silently degraded to soft).
  let strictInfo: { requested: string; resolved: string | null; matched: number; total: number; warnings: string[] } | null = null;
  if (strict && showFilter?.genres.length) {
    const targets = strictGenres.map(normGenre).filter(Boolean);
    strictInfo = {
      requested: showFilter.genres.join(', '),
      resolved: strictGenres.length ? strictGenres.join(', ') : null,
      matched: targets.length ? final.filter((t) => genreMatches(t, targets)).length : 0,
      total: final.length,
      warnings: genreWarnings,
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

// `opts.avoidArtist` (#1187): a single artist this pick must NOT be by, held as
// a hard block through the whole starvation cascade — set only by the agent
// path's back-to-back artist guard, which calls the pool precisely because it
// wants an artist the agent run never surfaced. Returning null when the pool
// genuinely holds no other artist is the RIGHT answer there: the caller then
// keeps its own pick and logs the relaxation. Unset on every other call, which
// leaves the ordinary pool byte-identical.
export async function pickViaPool(queue, ctx, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, opts: { avoidArtist?: string | null } = {}) {
  await library.load();
  const stats = library.stats();
  // Sized off the MIRROR, not `stats.total`, which counts only TAGGED tracks.
  // Both of these ask "how big is the catalogue we are picking from", and the
  // picker draws most of its pool straight from Navidrome — a 50k library with
  // 2k tagged is a 50k library to both of these guards. On `total` it read as a
  // small one and never reached the wide windows this scaling exists to give it.
  const librarySize = stats.mirrorTotal || stats.total;
  const windows = recencyWindowsForLibrary(stats.distinctArtists, librarySize);
  const { ids: recentIds, keys: recentKeys } = queue.recentlyPlayed(windows.trackHours);
  const recentArtists = queue.recentArtistsSince(windows.artistHours);
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
        vocals: (activeShow.vocals ?? '') as VocalMode,
        strict: activeShow.filtersStrict,
      }
    : null;
  // Resolve the show's anchored Navidrome playlist(s), if any, into a deduped
  // track pool. Null when the show pins none (the common case → pool unchanged).
  const playlistPool = activeShow ? await resolveShowPlaylistPool(activeShow) : null;
  const playlistStrict = !!activeShow?.playlistStrict;
  const excludedIds = activeShow ? await resolveExcludedPlaylistIds(activeShow) : null;
  // Resolve once, before both capacity and candidate filtering. A fuzzy genre
  // alias must narrow the hard-window universe exactly as it narrows the pool.
  const strictGenreResolution = await resolveStrictGenres(showFilter);
  // Count-based HARD no-repeat guard (last N distinct plays) — non-relaxable,
  // survives buildCandidates' starvation cascade. A resolved strict playlist
  // is its own catalogue, so clamp to its post-filter/post-exclusion identity
  // count; soft/unresolved anchors remain library-scoped. Mirrors the agent.
  const effN = effectiveShowNoRepeatWindow(
    settings.get().llm?.noRepeatWindow ?? 0,
    librarySize,
    {
      show: activeShow,
      playlistTracks: playlistPool?.tracks ?? null,
      excludedIds,
      resolvedGenres: strictGenreResolution.genres,
    },
  );
  const { ids: hardRecentIds, keys: hardRecentKeys } = queue.recentlyPlayedByCount(effN);
  // Pinned anchor resolved to nothing → the show is silently un-anchored.
  // Surface it (same warning as the agent path in dj-agent.ts).
  if (activeShow?.playlistIds?.length && !playlistPool) {
    queue.log('picker', `show "${activeShow.name}" pins ${activeShow.playlistIds.length} playlist(s) but none resolved to tracks — anchor ignored${playlistStrict ? ' (STRICT toggle has no effect)' : ''}. Stale playlist id (deleted/recreated in Navidrome?) or a Navidrome error; re-select the playlists in the show editor.`);
  }
  const blockedArtists = new Set<string>();
  if (opts.avoidArtist) {
    // Lead-artist key (#1251): the caller is avoiding the act on air, so a
    // collaboration they front is the same repeat with a longer name.
    const key = artistRootKey({ artist: opts.avoidArtist });
    if (key) blockedArtists.add(key);
  }
  const { candidates: rawCandidates, sources, strictInfo, playlistInfo } = await buildCandidates(ctx.dominantMood, recentIds, recentKeys, recentArtists, currentTrack, rankTarget, audioWaypoint, showFilter, hardRecentIds, hardRecentKeys, playlistPool, playlistStrict, blockedArtists, strictGenreResolution);

  // Excluded playlists (blocklist): drop any track whose id appears in the
  // show's excluded playlist union. Applied after buildCandidates so the full
  // pool is built first; no never-starve fallback — the blocklist is hard.
  const candidates = excludedIds
    ? rawCandidates.filter((t) => t?.id && !excludedIds.has(t.id))
    : rawCandidates;

  if (candidates.length === 0) {
    queue.log('picker', opts.avoidArtist
      ? `no candidates available excluding "${opts.avoidArtist}", skipping LLM pick`
      : 'no candidates available, skipping LLM pick');
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
    for (const w of strictInfo.warnings) queue.log('picker', `Show genre: ${w}`);
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

  // Offered-memory: every candidate reaching the model accrues its soft
  // penalty for future picks; whichever one is chosen clears below.
  recordOffered(candidates.map((c) => c.id));

  // One airing-index read for the whole candidate projection below (it is
  // memoised in library.ts, but resolving it per candidate hid that).
  const airedNow = library.lastAiredInfo();

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
            vocals: activeShow.vocals,
            filtersStrict: activeShow.filtersStrict,
          }
        : null,
      candidates: candidates.map(c => {
        const a = analysisFor(c);
        // Airing memory (music/airing.ts): true when the station has provably
        // never aired this track — a first-play discovery signal for the model.
        // Omitted (not false) once the track has a play on record, matching the
        // absent-when-empty convention below, and ALSO omitted when the index
        // can't answer — see unairedFlag for why "empty index" must not read as
        // "everything is unaired".
        const neverAired = unairedFlag(c, airedNow);
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
          // All genre tags, comma-joined ("Hip-Hop, Rap") — the model sees the
          // full picture, not just the primary tag (OpenSubsonic multi-genre).
          genre: subsonic.songGenres(c).join(', ') || undefined,
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
          // Instrumental flag from measured vocal ranges ([] = no vocals) —
          // the agent projection carried this (picker/slim.ts) while the
          // pool candidates competed blind on PICKER_CRITERIA's "instrumental
          // opener leaves room to talk" hint. Omitted when un-analysed.
          instrumental: Array.isArray(rec?.vocalRanges)
            ? rec.vocalRanges.length === 0
            : undefined,
          unaired: neverAired,
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
    if (candidates[0]?.id) offered.delete(candidates[0].id);
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
    if (candidates[0]?.id) offered.delete(candidates[0].id);
    return {
      song: candidates[0],
      reason: 'fallback (LLM returned invalid id)',
    };
  }

  if (chosen.id) offered.delete(chosen.id);
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
