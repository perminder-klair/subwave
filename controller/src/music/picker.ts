// The "pool path": build a balanced candidate pool from 7 Subsonic/library
// sources, one LLM call to pick one. Fallback for the session DJ agent.

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as dj from '../llm/dj.js';
import { nearestId } from '../llm/sdk.js';
import { logEvent } from '../observability/events.js';
import * as settings from '../settings.js';
import { bpmCompat, keyCompat } from './mix.js';
import { shuffle } from '../util/shuffle.js';
import { mapPool } from '../util/async-pool.js';
import { artistRootKey, filterPickerCandidates, recencyWindowsForLibrary, trackKey } from './recency.js';
import { albumKeyFor } from './album-facts.js';
import { applyTrackFloor } from './track-floor.js';
import { AIRING_RANK_WEIGHT, freshness, freshnessBiasedOrder, lastAiredMsOf, unairedFlag, type AiredIndex } from './airing.js';
import { normGenre, genreMatches, genreResolutionWarningOnce, preferGenre, preferEra, inYearRange, preferEnergy, preferEnergyStrict, preferMood, preferVocals, applyStrictLocks, hasEraBound, eraSpan, type YearRange, type VocalMode } from './show-filter.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds, type PlaylistPool } from './show-playlist.js';
import { showNoRepeatGuard } from './show-recency.js';
import * as likes from '../broadcast/likes.js';

// Raw Subsonic child, slimTrack library row, or Last.fm stub. A structural
// superset of show-filter's FilterTrack and recency's CandidateLike.
interface Candidate {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  // Album-cooldown surface. A missing flag is "no evidence", not a compilation.
  albumArtist?: string | null;
  isCompilation?: boolean | null;
  yearUntrusted?: boolean | null;
  year?: number | string | null;
  genre?: string | null;
  duration?: number | null;
  // Library rows spell it `durationSec`; both names must stay or the #1573
  // floor reads library rows as unknown.
  durationSec?: number | null;
  moods?: string[] | null;
  energy?: string | null;
  paceMean?: number | null;
  bpm?: number | null;
  key?: string | null;
  structure?: unknown[] | null;
  _source?: string | null;
  _similarity?: number | null;
}

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
// Show-dedicated sources dominate; other discovery sources shrink by
// SHOW_NARROW_FACTOR. Strict raises the cap so matches still fill CANDIDATE_CAP.
const CAP_SHOW_GENRE = 12;
const CAP_SHOW_GENRE_STRICT = 24;
const CAP_SHOW_PLAYLIST = 12;
const CAP_SHOW_PLAYLIST_STRICT = 24;
const SHOW_NARROW_FACTOR = 0.5;
// In-flight Navidrome queries per multi-genre show. Small on purpose.
const SHOW_GENRE_FETCH_CONCURRENCY = 4;

const CACHE_TTL_MS = 30 * 60 * 1000;
// Shorter TTL for an EMPTY result, so a transient blank clears quickly.
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

// Must be called when the Navidrome creds change: entries hold old server ids.
export function clearPoolCache() {
  cache.clear();
  offered.clear();
}

// Offered-but-not-picked memory: a capped ranking penalty decaying with the
// memo window; the chosen track's entry clears. A penalty, never a filter.
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

// Prefers the analyzer's numbers over the candidate's own ID3-derived fields
// (#862), and carries the boundary keys (keyStart/keyEnd).
function analysisFor(t: Candidate): { bpm: number | null; key: string | null; keyStart?: string | null; keyEnd?: string | null } {
  return library.bpmKeyFor(t);
}

// Soft re-rank, never a filter: random base nudged up for tempo/harmonic
// compatibility and freshness. Key compares the pair the transition meets.
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

// Show music-steering filters, never-starve by default; `strict`
// (show.filtersStrict) filters discovery sources too. Lists are OR within an
// attribute, AND across them (#929); empty list = no constraint.
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

function notRecent(recentIds: Set<string>) {
  return (t: Candidate) => t && t.id && !recentIds.has(t.id);
}

// Fresh-only sample, no never-starve: starvation is handled at wider scopes
// (the pool's relaxation cascade, the explore slot, the auto.m3u coast).
function sampleFresh(items: Candidate[], recentIds: Set<string>, cap: number): Candidate[] {
  return items.filter(notRecent(recentIds)).slice(0, cap);
}

// Unlike sampleFresh, dedicated show sources never-starve: they are the pool's
// only in-filter contributors. `hardRecent` (never-pickable) must be pruned
// BEFORE the cap or a full-rotation anchor (#1612) misses its last track.
function sampleShowSource(
  items: Candidate[],
  recentIds: Set<string>,
  cap: number,
  hardRecent: { ids: Set<string>; keys: Set<string> } | null = null,
): Candidate[] {
  let base = items;
  if (hardRecent && (hardRecent.ids.size || hardRecent.keys.size)) {
    const pickable = items.filter((t) =>
      !(t?.id && hardRecent.ids.has(t.id)) && !hardRecent.keys.has(trackKey(t)));
    if (pickable.length) base = pickable;
  }
  const fresh = base.filter(notRecent(recentIds));
  return (fresh.length > 0 ? fresh : base).slice(0, cap);
}

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

async function buildCandidates(mood: string | null | undefined, recentIds: Set<string>, recentKeys: Set<string>, recentArtists: Set<string>, recentAlbums: Set<string>, currentTrack: Candidate | null, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, showFilter: ShowFilter = null, hardRecentIds: Set<string> = new Set(), hardRecentKeys: Set<string> = new Set(), playlistPool: PlaylistPool | null = null, playlistStrict = false, blockedArtists: Set<string> = new Set(), strictGenreResolution: StrictGenreResolution = { genres: [], warnings: [] }, minTrackSec: number | null = null, exhaustiveRotation = false) {
  await library.load();
  // knnExclude pushes the recency union INTO the KNN queries so an aired
  // cluster answers with the next neighbours out, not with fewer rows.
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
  // Strict hard-filters the final pool to the anchor; soft lets it dominate.
  const hasPlaylist = !!playlistPool?.tracks?.length;
  const strictPlaylist = hasPlaylist && playlistStrict;
  const narrow = hasMusicFilter(showFilter) || hasPlaylist;
  const nz = (cap: number) => (narrow ? Math.max(2, Math.ceil(cap * SHOW_NARROW_FACTOR)) : cap);

  const strict = !!(showFilter?.strict
    && (showFilter.genres.length || showFilter.moods.length || showFilter.energies.length
      || showFilter.vocals || hasEraBound(showFilter.eras)));
  // Free-text genres resolved to exact library tags once, up front. None
  // resolving means no genre filter at all, so a misspelling can't strand the show.
  const strictGenres = strictGenreResolution.genres;
  const genreWarnings = strictGenreResolution.warnings;
  // Hard-prefer every set filter in strict mode; a no-op otherwise. Each
  // prefer* never-starves, so leaning a source can only tighten it.
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
      // Freshness-biased, never the server's Last.fm rank (which pins the
      // same top-8 per seed).
      add('similar', sampleFresh(freshnessBiasedOrder(lean(similar), aired, nowMs), recentIds, nz(CAP_SIMILAR)));
    } catch {}
  }

  // 1b. Embedding-KNN over the library; [] when the seed has no vector yet.
  if (currentTrack?.id) {
    try {
      const knn = library.tracksLikeThis(currentTrack.id, 30, { excludeIds: knnExclude });
      add('embedding-similar', sampleFresh(freshnessBiasedOrder(lean(knn), aired, nowMs), recentIds, nz(CAP_EMBEDDING_SIMILAR)));
    } catch {}
  }

  // 1c. Sonic-similarity — OpenSubsonic `sonicSimilarity`; no-op when absent.
  if (currentTrack?.id) {
    try {
      if (await subsonic.supportsSonicSimilarity()) {
        const sonic = await subsonic.getSonicSimilarTracks(currentTrack.id, { count: 20 });
        add('sonic-similar', sampleFresh(freshnessBiasedOrder(lean(sonic), aired, nowMs), recentIds, nz(CAP_SONIC_SIMILAR)));
      }
    } catch {}
  }

  // 1d. Audio-KNN (CLAP) over the waveform. With a sonic journey active the
  // anchor is the journey's waypoint vector, so the pool drifts to the destination.
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

  // 1d-bis. Listener favourites (#991), behind likes.influenceDj. Never a lock.
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

  // 1e. Show genres / decades. getRandomSongs takes ONE genre + ONE year range,
  // so it is one call per genre against eraSpan, then inYearRange, then energy-prefer.
  if (hasMusicFilter(showFilter)) {
    try {
      // Reuse the strict-resolved tags when already paid for above.
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
      // Size budgets DIVIDED so the total is the same for 1 genre or 15.
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
            const g = await subsonic.getSongsByGenreSampled(genreName, { count: Math.ceil(genreSetSize / genreNames.length) });
            const ranged = inYearRange(g, showFilter!.eras);
            got.push(...(ranged.length ? ranged : g));
          } catch {}
        }
        return got;
      });
      const collected: Candidate[] = perGenre.flat();
      // Tighten the envelope to the exact union, never-starve.
      const exact = hasEraBound(showFilter!.eras) ? inYearRange(collected, showFilter!.eras) : collected;
      const leaned = lean(preferEnergy(exact.length ? exact : collected, showFilter!.energies));
      add('show-genre', sampleShowSource(shuffle(leaned), recentIds, strict ? CAP_SHOW_GENRE_STRICT : CAP_SHOW_GENRE));
    } catch {}
  }

  // 1f. Show-anchored Navidrome playlist(s); in strict mode the whole universe.
  if (hasPlaylist) {
    add('show-playlist', sampleShowSource(shuffle(playlistPool!.tracks), recentIds, strictPlaylist ? CAP_SHOW_PLAYLIST_STRICT : CAP_SHOW_PLAYLIST, exhaustiveRotation ? { ids: hardRecentIds, keys: hardRecentKeys } : null));
  }

  // 2. Mood-tagged library. A multi-mood show pools ALL its moods equally (#929).
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

    // Autonomous hours only (a show's pinned moods are operator intent): only
    // ~8 moods ever become dominantMood, so walk the rest of the vocabulary.
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

  // 3. Mood-matched Navidrome playlists. Skipped when the show pins its own
  // (1f): name-contains matching leaks other shows' playlists in (#642).
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

  // 4. Recently-added albums. The memo must cache a WIDE (~40-track) pool;
  // memoising the CAP_RECENT slice freezes the same 4 tracks for the whole TTL.
  try {
    const recentPool = await memo('recent-track-pool', CACHE_TTL_MS, async () => {
      const albums = await subsonic.getRecentlyAddedAlbums({ size: 12 });
      return tracksFromAlbums(shuffle(albums), 3, 40);
    });
    add('recent', sampleFresh(lean(shuffle(recentPool)), recentIds, nz(CAP_RECENT)));
  } catch {}

  // 5. Frequent albums — scrobble-backed favourites, same wide-pool pattern.
  try {
    const freqPool = await memo('frequent-track-pool', CACHE_TTL_MS, async () => {
      // Rotate the window (offset 0/12/24 per TTL): play counts are fed by
      // the station itself, so a fixed top-12 is a feedback loop.
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
        // Freshness-ordered: the memo holds a popularity-ranked slice.
        sampleFresh(freshnessBiasedOrder(lean(similarArtistTracks), aired, nowMs), recentIds, nz(CAP_SIMILAR_ARTIST)),
      );
    } catch {}
  }

  // 7. Exploration slot — the pool's only library-wide draw. Skipped for a
  // strict-playlist show, mirroring the coast's identical source in
  // scheduler.ts §2b; keep the two in step. Strict GENRE shows keep it.
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

  // Strict playlist: drop off-playlist candidates before ranking, never-starving
  // to the unfiltered pool only if none survived. Recency still applies below.
  let selectionPool = pool;
  let playlistInfo: { names: string[]; matched: number; total: number } | null = null;
  if (strictPlaylist) {
    const inPl = pool.filter((t) => t?.id && playlistPool!.ids.has(t.id));
    if (inPl.length) selectionPool = inPl;
  }

  // Strict filters re-applied to the FINAL merged pool: lean() never-starves per
  // source, so a zero-match source passed its whole result through. starve:false
  // is per dimension, so one empty tag class can't undo the others' purity.
  if (strict) {
    selectionPool = applyStrictLocks(selectionPool, {
      genres: strictGenres,
      eras: showFilter!.eras,
      moods: showFilter!.moods,
      energies: showFilter!.energies,
      vocals: showFilter!.vocals,
    }, { starve: false });
  }

  // Cap per artist; a strict playlist anchor is intentionally single-artist.
  const MAX_PER_ARTIST = strictPlaylist ? Infinity : 3;
  const perArtist = new Map<string, number>();
  // Soft re-rank runs BEFORE the cap so compatible tracks survive the slice.
  const curAnalysis = rankTarget
    || (currentTrack?.id ? analysisFor(currentTrack) : { bpm: null, key: null });
  // Minimum track length (#1573) — a SELECTION filter, unlike the max cap's
  // cue_out cut. never-starve here: the wider scope behind the agent's hard floor.
  const longEnough = applyTrackFloor(selectionPool, minTrackSec, { starve: false });
  const final = filterPickerCandidates(softRankByCompat(longEnough, curAnalysis, library.lastAiredInfo()), {
    recentIds,
    recentKeys,
    recentArtists,
    // The SAME queue.recentAlbumKeys set the agent path's guard uses.
    recentAlbums,
    // Pool sources are mostly raw Subsonic children with no compilation flag.
    albumKeyOf: albumKeyFor,
    hardRecentIds,
    hardRecentKeys,
    artistCounts: perArtist,
    maxPerArtist: MAX_PER_ARTIST,
    cap: CANDIDATE_CAP,
    // Empty except on the agent path's artist-guard rescue (#1187). Enforced
    // inside the filter so the relaxation cascade keeps walking.
    blockedArtists,
  });

  // Strict-genre diagnostics; `resolved` is null when no genre mapped to a tag.
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
      // Omitted, not nulled: nulls on un-tagged entries are wasted tokens.
      return {
        title: i.track.title,
        artist: i.track.artist,
        moods: tags?.moods?.length ? tags.moods : undefined,
        energy: tags?.energy || undefined,
      };
    });
}

// Drop the album line when it only echoes the title.
function slimAlbum(album: string | null | undefined, title: string | null | undefined): string | undefined {
  if (!album) return undefined;
  const stripped = String(album).replace(/\s*-\s*(Single|EP)$/i, '').trim();
  return stripped.toLowerCase() === String(title || '').trim().toLowerCase() ? undefined : album;
}

// Build a candidate pool, ask the LLM to choose one; null when it can't.
// `opts.avoidArtist` (#1187) is a hard block held through the whole starvation
// cascade, set only by the agent path's back-to-back artist guard.
export async function pickViaPool(queue, ctx, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, opts: { avoidArtist?: string | null } = {}) {
  await library.load();
  const stats = library.stats();
  // Sized off the MIRROR, not `stats.total`, which counts only tagged tracks.
  const librarySize = stats.mirrorTotal || stats.total;
  const windows = recencyWindowsForLibrary(stats.distinctArtists, librarySize);
  const { ids: recentIds, keys: recentKeys } = queue.recentlyPlayed(windows.trackHours);
  const recentArtists = queue.recentArtistsSince(windows.artistHours);
  // Album cooldown: operator-set hours, not library-scaled. 0 = empty set.
  const recentAlbums = queue.recentAlbumKeys(settings.get().picker?.albumHours ?? 0);
  const currentTrack = queue.current?.track || null;
  // Prefer the show already resolved into ctx: near a boundary that is a
  // look-ahead, so the pool follows the show on air when the pick plays.
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
  const playlistPool = activeShow ? await resolveShowPlaylistPool(activeShow) : null;
  const playlistStrict = !!activeShow?.playlistStrict;
  const excludedIds = activeShow ? await resolveExcludedPlaylistIds(activeShow) : null;
  // Resolve once, before both capacity and candidate filtering.
  const strictGenreResolution = await resolveStrictGenres(showFilter);
  // Minimum track length (#1573). Must resolve BEFORE the no-repeat guard
  // below, which counts the rotation this floor has already thinned.
  const minTrackSec = settings.effectiveMinTrackSec(activeShow);
  // Count-based hard no-repeat guard (last N distinct plays), non-relaxable. A
  // resolved strict playlist clamps to its own post-exclusion identity count;
  // soft/unresolved anchors stay library-scoped. Mirrors the agent.
  const noRepeat = showNoRepeatGuard(
    settings.get().llm?.noRepeatWindow ?? 0,
    librarySize,
    {
      show: activeShow,
      playlistTracks: playlistPool?.tracks ?? null,
      excludedIds,
      resolvedGenres: strictGenreResolution.genres,
      minTrackSec,
    },
  );
  const effN = noRepeat.window;
  const { ids: hardRecentIds, keys: hardRecentKeys } = queue.recentlyPlayedByCount(effN);
  // Pinned anchor resolved to nothing: same warning as the agent path.
  if (activeShow?.playlistIds?.length && !playlistPool) {
    queue.log('picker', `show "${activeShow.name}" pins ${activeShow.playlistIds.length} playlist(s) but none resolved to tracks — anchor ignored${playlistStrict ? ' (STRICT toggle has no effect)' : ''}. Stale playlist id (deleted/recreated in Navidrome?) or a Navidrome error; re-select the playlists in the show editor.`);
  }
  const blockedArtists = new Set<string>();
  if (opts.avoidArtist) {
    // Lead-artist key (#1251): a collab the act fronts is the same repeat.
    const key = artistRootKey({ artist: opts.avoidArtist });
    if (key) blockedArtists.add(key);
  }
  const { candidates: rawCandidates, sources, strictInfo, playlistInfo } = await buildCandidates(ctx.dominantMood, recentIds, recentKeys, recentArtists, recentAlbums, currentTrack, rankTarget, audioWaypoint, showFilter, hardRecentIds, hardRecentKeys, playlistPool, playlistStrict, blockedArtists, strictGenreResolution, minTrackSec, noRepeat.exhaustive);

  // Excluded playlists: hard drop, no never-starve fallback.
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
      .join(' ')})${effN > 0 ? ` no-repeat=${effN}${noRepeat.exhaustive ? ' (full rotation)' : ''}` : ''}`,
  );

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

  if (playlistInfo) {
    const tag = playlistInfo.names.length ? playlistInfo.names.join(', ') : `${activeShow!.playlistIds.length} playlist(s)`;
    if (playlistStrict && playlistInfo.matched === 0) {
      queue.log('picker', `strict playlist [${tag}]: 0 in-playlist candidates — falling back to keep the stream alive`);
    } else {
      queue.log('picker', `playlist [${tag}]: ${playlistInfo.matched}/${playlistInfo.total} in-playlist${playlistStrict ? ' (strict)' : ''}`);
    }
  }

  // Every candidate reaching the model accrues its soft penalty.
  recordOffered(candidates.map((c) => c.id));

  const airedNow = library.lastAiredInfo();

  const recentPlays = summariseRecent(queue);
  // Guarded: picker-test.mjs uses a stub queue with no such method.
  const recentTransitions = typeof queue.recentTransitionChoices === 'function'
    ? queue.recentTransitionChoices()
    : [];

  let pickRaw;
  try {
    // Same show-brief plumbing as the agent picker, whose fallback this is.
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
        // Omitted, not false, when unaired can't be proven.
        const neverAired = unairedFlag(c, airedNow);
        // Join tags/analysis from the library store: Subsonic-sourced candidates
        // carry none, so without it half the pool competes blind (#862).
        const rec = c.id ? library.get(c.id) : null;
        const moods = (Array.isArray(c.moods) && c.moods.length ? c.moods : rec?.moods) || [];
        return {
          id: c.id,
          title: c.title,
          artist: c.artist,
          // Absent-when-empty throughout; nulls cost hundreds of tokens.
          album: slimAlbum(c.album, c.title),
          year: c.year || undefined,
          // All genre tags comma-joined, not just the primary one.
          genre: subsonic.songGenres(c).join(', ') || undefined,
          moods: moods.length ? moods : undefined,
          energy: c.energy || rec?.energy || undefined,
          // Seconds. The CAP is an on-air cue_out cut, never a pool filter
          // (#447), so the model is the only place the upper end is weighed.
          secs: c.duration ?? rec?.duration_sec ?? undefined,
          bpm: a.bpm ?? undefined,
          key: a.key ?? undefined,
          // Perceptual energy 0..1 (mean pace), decoupled from BPM.
          pace: c.paceMean ?? rec?.paceMean ?? undefined,
          // Mirrors the agent picker's `sections`.
          sections: library.sectionCount(c) ?? library.sectionCount(rec) ?? undefined,
          // Instrumental flag from measured vocal ranges ([] = no vocals).
          instrumental: Array.isArray(rec?.vocalRanges)
            ? rec.vocalRanges.length === 0
            : undefined,
          unaired: neverAired,
          source: c._source || null,
          // Cosine similarity to the current track, KNN sources only.
          similarity: c._similarity != null ? Math.round(c._similarity * 100) / 100 : undefined,
        };
      }),
      recentPlays,
      context: ctx,
      // The on-air anchor: the criteria ask the model to match its tempo.
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
    // Top candidate rather than null: null drops the stream to auto.m3u.
    queue.log('error', `picker LLM failed: ${err.message} — falling back to first pool candidate`);
    if (candidates[0]?.id) offered.delete(candidates[0].id);
    return {
      song: candidates[0],
      reason: 'fallback (LLM pick failed)',
      source: candidates[0]._source,
    };
  }

  let chosen = candidates.find(c => c.id === pickRaw?.id);
  // Near-miss repair (#939): an id 1-3 edits away is a mistranscription.
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
    // Present only when effects were active; applyMixTransition validates it.
    transition: pickRaw.transition ?? null,
  };
}
