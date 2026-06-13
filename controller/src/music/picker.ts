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

async function buildCandidates(mood: string | null | undefined, recentIds: Set<string>, recentArtists: Set<string>, currentTrack: any, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null) {
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
      add('similar', sampleWithRecentFallback(similar, recentIds, CAP_SIMILAR));
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
      add('embedding-similar', sampleWithRecentFallback(knn, recentIds, CAP_EMBEDDING_SIMILAR));
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
        add('sonic-similar', sampleWithRecentFallback(sonic, recentIds, CAP_SONIC_SIMILAR));
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
      add('audio-journey', sampleWithRecentFallback(knn, recentIds, CAP_AUDIO_SIMILAR));
    } catch {}
  } else if (currentTrack?.id) {
    try {
      const knn = library.tracksLikeThisAudio(currentTrack.id, 15);
      add('audio-similar', sampleWithRecentFallback(knn, recentIds, CAP_AUDIO_SIMILAR));
    } catch {}
  }

  // 2. Mood-tagged library (LLM-built tags, may be sparse).
  if (mood) {
    const moodHits = shuffle(library.songsByMood(mood));
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
      add('playlist', sampleWithRecentFallback(shuffle(plTracks), recentIds, CAP_PLAYLIST));
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
    add('recent', sampleWithRecentFallback(shuffle(recentPool), recentIds, CAP_RECENT));
  } catch {}

  // 5. Frequent albums — scrobble-backed favourites. Same wide-pool-then-
  // shuffle pattern as recently-added above.
  try {
    const freqPool = await memo('frequent-track-pool', CACHE_TTL_MS, async () => {
      const albums = await subsonic.getFrequentAlbums({ size: 12 });
      return tracksFromAlbums(shuffle(albums), 3, 40);
    });
    add('frequent', sampleWithRecentFallback(shuffle(freqPool), recentIds, CAP_FREQUENT));
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
        sampleWithRecentFallback(similarArtistTracks, recentIds, CAP_SIMILAR_ARTIST),
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

export async function pickViaPool(queue, ctx, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null) {
  await library.load();
  const windows = recencyWindowsForLibrary(library.stats().distinctArtists);
  const recentIds = queue.recentlyPlayedIds(windows.trackHours);
  const recentArtists = queue.recentArtistsSince(windows.artistHours);
  const currentTrack = queue.current?.track || null;
  const { candidates, sources } = await buildCandidates(ctx.dominantMood, recentIds, recentArtists, currentTrack, rankTarget, audioWaypoint);

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
    // Same show-brief plumbing as the agent picker (dj-agent.pickSystem) —
    // this is its fallback, so it must honour the brief too.
    const activeShow = settings.resolveActiveShow();
    pickRaw = await dj.pickNextTrack({
      show: activeShow ? { name: activeShow.name, topic: activeShow.topic } : null,
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
