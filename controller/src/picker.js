// LLM-as-DJ next-track selector. Two strategies:
//
//   • Pool path  (default) — the controller builds a balanced candidate pool
//     from 7 Subsonic/library sources and asks the LLM to pick one. Cheap,
//     deterministic, one model call. Works with any model.
//
//   • Agent path (settings.llm.pickerAgent) — a ToolLoopAgent is GIVEN the
//     music-discovery tools and decides for itself what to search. More
//     "DJ-like", but needs a model that handles multi-step tool calls well —
//     hence it's opt-in. Any agent failure falls back to the pool path so a
//     pick is never missed.

import { ToolLoopAgent, stepCountIs, Output } from 'ai';
import { z } from 'zod';
import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as dj from './llm/dj.js';
import * as settings from './settings.js';
import { languageModel, providerName } from './llm/provider.js';
import { buildPickerTools } from './llm/tools.js';
import { record } from './llm/log.js';
import { getFullContext } from './context.js';

const CANDIDATE_CAP = 18;
const HISTORY_DEPTH = 8;

// Per-source caps so the LLM sees a balanced mix rather than 15 similar songs.
const CAP_SIMILAR = 8;
const CAP_MOOD_LIBRARY = 10;
const CAP_PLAYLIST = 6;
const CAP_RECENT = 4;
const CAP_FREQUENT = 4;
const CAP_SIMILAR_ARTIST = 4;

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

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function notRecent(recentIds) {
  return (t) => t && t.id && !recentIds.has(t.id);
}

// Walk a list of albums and return up to `perAlbum` tracks from each, capped.
async function tracksFromAlbums(albums, perAlbum, max) {
  const out = [];
  for (const a of albums) {
    if (out.length >= max) break;
    try {
      const songs = await subsonic.getAlbum(a.id);
      out.push(...shuffle(songs).slice(0, perAlbum));
    } catch {}
  }
  return out;
}

async function buildCandidates(mood, recentIds, currentTrack) {
  await library.load();
  const pool = [];
  const sources = {};
  const add = (label, items) => {
    if (!items?.length) return;
    pool.push(...items.map(t => ({ ...t, _source: label })));
    sources[label] = (sources[label] || 0) + items.length;
  };

  // 1. Similar-songs from current track — strongest contextual signal.
  if (currentTrack?.id) {
    try {
      const similar = await subsonic.getSimilarSongs(currentTrack.id, { count: 20 });
      add('similar', similar.filter(notRecent(recentIds)).slice(0, CAP_SIMILAR));
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
      const matched = playlists.filter(p =>
        p.name?.toLowerCase().includes(mood.toLowerCase())
      );
      const plTracks = [];
      for (const pl of matched.slice(0, 2)) {
        try {
          const songs = await memo(`playlist:${pl.id}`, CACHE_TTL_MS, () => subsonic.getPlaylist(pl.id));
          plTracks.push(...songs);
        } catch {}
      }
      add('playlist', shuffle(plTracks.filter(notRecent(recentIds))).slice(0, CAP_PLAYLIST));
    } catch {}
  }

  // 4. Recently-added albums — "new in the crates".
  try {
    const recentTracks = await memo('recent-tracks', CACHE_TTL_MS, async () => {
      const albums = await subsonic.getRecentlyAddedAlbums({ size: 10 });
      return tracksFromAlbums(shuffle(albums).slice(0, 5), 2, 12);
    });
    add('recent', recentTracks.filter(notRecent(recentIds)).slice(0, CAP_RECENT));
  } catch {}

  // 5. Frequent albums — scrobble-backed favourites.
  try {
    const freqTracks = await memo('frequent-tracks', CACHE_TTL_MS, async () => {
      const albums = await subsonic.getFrequentAlbums({ size: 10 });
      return tracksFromAlbums(shuffle(albums).slice(0, 5), 2, 12);
    });
    add('frequent', freqTracks.filter(notRecent(recentIds)).slice(0, CAP_FREQUENT));
  } catch {}

  // 6. Similar-artist top songs — adjacency through Last.fm artist graph.
  if (currentTrack?.artist) {
    try {
      const similarArtistTracks = await memo(`similar-artist:${currentTrack.artist}`, CACHE_TTL_MS, async () => {
        const matches = await subsonic.searchArtists(currentTrack.artist, { artistCount: 1 });
        if (matches.length === 0) return [];
        const info = await subsonic.getArtistInfo(matches[0].id, { count: 5 });
        const similars = (info?.similarArtist || []).slice(0, 2);
        const collected = [];
        for (const sa of similars) {
          try {
            const top = await subsonic.getTopSongs(sa.name, { count: 5 });
            collected.push(...top);
          } catch {}
        }
        return collected;
      });
      add('similar-artist', similarArtistTracks.filter(notRecent(recentIds)).slice(0, CAP_SIMILAR_ARTIST));
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

  // De-dup, shuffle, cap.
  const seen = new Set();
  const final = shuffle(pool).filter(t => {
    if (!t.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  }).slice(0, CANDIDATE_CAP);

  return { candidates: final, sources };
}

function summariseRecent(queue) {
  const items = [];
  if (queue.current) items.push(queue.current);
  items.push(...queue.history.slice(0, HISTORY_DEPTH));
  return items.filter(i => i?.track?.title).map(i => {
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
// Pool path — build a candidate pool, ask the LLM to choose one.
// ---------------------------------------------------------------------------

async function pickViaPool(queue, ctx) {
  const recentIds = queue.recentlyPlayedIds(25);
  const currentTrack = queue.current?.track || null;
  const { candidates, sources } = await buildCandidates(ctx.dominantMood, recentIds, currentTrack);

  if (candidates.length === 0) {
    queue.log('picker', 'no candidates available, skipping LLM pick');
    return null;
  }

  queue.log('picker', `pool ${candidates.length} (${
    Object.entries(sources).map(([k, v]) => `${k}=${v}`).join(' ')
  })`);

  const recentPlays = summariseRecent(queue);

  let pickRaw;
  try {
    pickRaw = await dj.pickNextTrack({
      candidates: candidates.map(c => ({
        id: c.id,
        title: c.title,
        artist: c.artist,
        moods: c.moods || [],
        energy: c.energy || null,
      })),
      recentPlays,
      context: ctx,
    });
  } catch (err) {
    queue.log('error', `picker LLM failed: ${err.message}`);
    return null;
  }

  const chosen = candidates.find(c => c.id === pickRaw?.id);
  if (!chosen) {
    queue.log('error', `picker returned unknown id ${pickRaw?.id}; falling back to first candidate`);
    return { song: candidates[0], reason: 'fallback (LLM returned invalid id)' };
  }

  return { song: chosen, reason: pickRaw.reason || null, source: chosen._source };
}

// ---------------------------------------------------------------------------
// Agent path — give the model the discovery tools and let it choose.
// ---------------------------------------------------------------------------

const AGENT_INSTRUCTIONS = `You are the DJ for SUB/WAVE, a personal internet radio station.
Your job: choose the single best NEXT track to play.

You have tools to explore the music library. Use 2 to 4 tool calls to gather
candidates, then choose ONE track. Strategy:
- similarSongs (seeded with the current song id) keeps the flow going.
- tracksByMood matches the room's dominant mood.
- starredSongs / recentlyAdded / randomSongs add variety.

Selection criteria, in order:
1. FLOW — transitions naturally from what just played (energy, mood, tempo).
2. CONTEXT — fits the time of day, weather, and dominant mood.
3. VARIETY — never the same artist back-to-back; rotate energy; avoid the predictable.
4. INTEREST — pick something that makes a moment.

The final track id MUST be one that a tool actually returned. Do not invent ids.`;

const AGENT_PICK_SCHEMA = z.object({
  id: z.string().describe('the exact song id, as returned by a tool call'),
  reason: z.string().describe('one short sentence on why this track'),
});

async function pickViaAgent(queue, ctx) {
  const recentIds = queue.recentlyPlayedIds(25);
  const currentTrack = queue.current?.track || null;
  const { tools, seen } = buildPickerTools({ recentIds });

  const agent = new ToolLoopAgent({
    model: languageModel(),
    instructions: AGENT_INSTRUCTIONS,
    tools,
    // Generous cap: each tool call + the final structured output are steps.
    stopWhen: stepCountIs(8),
    output: Output.object({ schema: AGENT_PICK_SCHEMA }),
    temperature: 0.6,
  });

  const brief = JSON.stringify({
    now: {
      time: ctx.time?.period,
      vibe: ctx.time?.vibe,
      mood: ctx.dominantMood,
      weather: ctx.weather?.condition,
      festival: ctx.festival?.name,
    },
    currentSongId: currentTrack?.id || null,
    currentSong: currentTrack ? `${currentTrack.title} — ${currentTrack.artist}` : null,
    recentPlays: summariseRecent(queue),
  }, null, 2);

  const started = Date.now();
  let result;
  try {
    result = await agent.generate({ prompt: brief });
  } catch (err) {
    record({
      kind: 'pickerAgent', ok: false, ms: Date.now() - started,
      via: 'ai-sdk', user: brief, error: err.message, t: new Date().toISOString(),
    });
    throw err;
  }

  const pick = result.output;
  const steps = result.steps?.length ?? 0;
  record({
    kind: 'pickerAgent', ok: true, ms: Date.now() - started,
    via: 'ai-sdk', user: brief,
    response: `steps=${steps} pick=${pick?.id} — ${pick?.reason || ''}`,
    t: new Date().toISOString(),
  });

  const song = pick?.id ? seen.get(pick.id) : null;
  if (!song) {
    queue.log('error', `picker agent returned unknown id ${pick?.id}`);
    return null;
  }
  queue.log('picker', `agent pick after ${steps} steps from ${seen.size} explored`);
  return { song, reason: pick.reason || null, source: 'agent' };
}

// ---------------------------------------------------------------------------
// Public entry — dispatch to agent or pool, with the pool as a safety net.
// ---------------------------------------------------------------------------

export async function pickNext(queue) {
  const ctx = await getFullContext();

  if (settings.get().llm?.pickerAgent) {
    try {
      const result = await pickViaAgent(queue, ctx);
      if (result) return result;
      queue.log('picker', 'agent produced no pick — falling back to pool');
    } catch (err) {
      queue.log('error', `picker agent failed (${providerName()}): ${err.message} — falling back to pool`);
    }
  }

  return pickViaPool(queue, ctx);
}

// Pick + enqueue. Fire-and-forget from the watcher.
export async function pickAndEnqueue(queue) {
  const result = await pickNext(queue);
  if (!result) return;
  const { song, reason, source } = result;
  queue.log('ai-pick', `${song.title} — ${song.artist}`, { reason, source });
  await queue.push({
    track: {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      genre: song.genre,
    },
    requestedBy: null,
    intent: reason || 'ai pick',
    introScript: null,        // no spoken intro for auto-picks (keeps the flow musical)
    aiPicked: true,
  });
}
