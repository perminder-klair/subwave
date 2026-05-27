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

function notRecent(recentIds: Set<string>) {
  return (t: any) => t && t.id && !recentIds.has(t.id);
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

async function buildCandidates(mood: string | null | undefined, recentIds: Set<string>, recentArtists: Set<string>, currentTrack: any) {
  await library.load();
  const pool: any[] = [];
  const sources: Record<string, number> = {};
  const add = (label: string, items: any[]) => {
    if (!items?.length) return;
    pool.push(...items.map((t: any) => ({ ...t, _source: label })));
    sources[label] = (sources[label] || 0) + items.length;
  };

  // 1. Similar-songs from current track — strongest contextual signal.
  if (currentTrack?.id) {
    try {
      const similar = await subsonic.getSimilarSongs(currentTrack.id, {
        count: 20,
      });
      add('similar', similar.filter(notRecent(recentIds)).slice(0, CAP_SIMILAR));
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
      add('embedding-similar', knn.filter(notRecent(recentIds)).slice(0, CAP_EMBEDDING_SIMILAR));
    } catch {}
  }

  // 2. Mood-tagged library (LLM-built tags, may be sparse).
  if (mood) {
    const moodHits = shuffle(library.songsByMood(mood).filter(notRecent(recentIds)));
    add('mood-library', moodHits.slice(0, CAP_MOOD_LIBRARY));
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
      add('playlist', shuffle(plTracks.filter(notRecent(recentIds))).slice(0, CAP_PLAYLIST));
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
    add('recent', shuffle(recentPool).filter(notRecent(recentIds)).slice(0, CAP_RECENT));
  } catch {}

  // 5. Frequent albums — scrobble-backed favourites. Same wide-pool-then-
  // shuffle pattern as recently-added above.
  try {
    const freqPool = await memo('frequent-track-pool', CACHE_TTL_MS, async () => {
      const albums = await subsonic.getFrequentAlbums({ size: 12 });
      return tracksFromAlbums(shuffle(albums), 3, 40);
    });
    add('frequent', shuffle(freqPool).filter(notRecent(recentIds)).slice(0, CAP_FREQUENT));
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
        similarArtistTracks.filter(notRecent(recentIds)).slice(0, CAP_SIMILAR_ARTIST),
      );
    } catch {}
  }

  // 7. Fallback if the pool is still thin — starred + random.
  if (pool.length < 8) {
    try {
      const starred = (await subsonic.getStarred()).filter(notRecent(recentIds));
      add('starred', shuffle(starred).slice(0, 4));
    } catch {}
    try {
      const random = (await subsonic.getRandomSongs({ size: 10 })).filter(notRecent(recentIds));
      add('random', random.slice(0, 4));
    } catch {}
  }

  // De-dup by id, cap per artist so one name can't dominate the pool (the LLM
  // can only rotate artists across what it's handed), shuffle, cap.
  const MAX_PER_ARTIST = 3;
  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const final = shuffle(pool)
    .filter((t: any) => {
      if (!t.id || seen.has(t.id)) return false;
      const artistKey = (t.artist || '').toLowerCase().trim();
      // Drop tracks by an artist heard in the last 2h, mirroring the agent
      // picker's recentArtistsSince(2) filter. Without this, the fallback
      // path (~1 in 4-5 picks on the current model) could cluster the same
      // artist 4× in 90 min, as observed with Prabh Deep on 2026-05-25.
      if (artistKey && recentArtists.has(artistKey)) return false;
      if (artistKey) {
        const n = perArtist.get(artistKey) || 0;
        if (n >= MAX_PER_ARTIST) return false;
        perArtist.set(artistKey, n + 1);
      }
      seen.add(t.id);
      return true;
    })
    .slice(0, CANDIDATE_CAP);

  return { candidates: final, sources };
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

export async function pickViaPool(queue, ctx) {
  // Match the agent picker's window (dj-agent.pickViaAgent) — 12h. Anything
  // shorter and the fallback could pick a track the agent would have rejected.
  const recentIds = queue.recentlyPlayedIds(12);
  const recentArtists = queue.recentArtistsSince(2);
  const currentTrack = queue.current?.track || null;
  const { candidates, sources } = await buildCandidates(ctx.dominantMood, recentIds, recentArtists, currentTrack);

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

  const recentPlays = summariseRecent(queue);

  let pickRaw;
  try {
    pickRaw = await dj.pickNextTrack({
      candidates: candidates.map(c => ({
        id: c.id,
        title: c.title,
        artist: c.artist,
        album: c.album || null,
        year: c.year || null,
        genre: c.genre || null,
        moods: c.moods || [],
        energy: c.energy || null,
        source: c._source || null,
      })),
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
