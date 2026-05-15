// Scheduler — drives autonomous behaviour:
//   - refreshes the auto-playlist file Liquidsoap falls back to
//   - hourly time check (top of every hour, in character)
//   - station IDs (every ~45 min, varied by frequency setting)
//   - skill registry tick (weather, news, traffic, random facts) every 5 min

import cron from 'node-cron';
import { writeFile } from 'node:fs/promises';
import { config } from './config.js';
import * as subsonic from './subsonic.js';
import * as dj from './llm/dj.js';
import * as library from './library.js';
import { getFullContext } from './context.js';
import { queue } from './queue.js';
import { cleanupOldVoices } from './tts.js';
import { shouldFire } from './dj-gate.js';
import * as skillRegistry from './skills/_registry.js';

const TARGET_POOL = 30;
const MOOD_WEIGHT = 12;          // up to this many mood-tagged tracks per pool
const PLAYLIST_WEIGHT = 6;       // mood-matched Navidrome playlists
const RECENT_WEIGHT = 4;         // recently-added albums
const FREQUENT_WEIGHT = 4;       // frequent / scrobble-favourite albums
const STARRED_WEIGHT = 6;        // hand-starred tracks

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

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

// ---------------------------------------------------------------------------
// AUTO-PLAYLIST REFRESH
// Writes an M3U with mood-appropriate tracks for Liquidsoap's fallback source.
// ---------------------------------------------------------------------------

async function refreshAutoPlaylist() {
  const ctx = await getFullContext();
  const mood = ctx.dominantMood;
  const recent = queue.recentlyPlayedIds(25);

  const pool = [];
  const fromSource = { mood: 0, playlist: 0, recent: 0, frequent: 0, starred: 0, random: 0 };
  const take = (label, items, cap) => {
    let n = 0;
    for (const t of items) {
      if (n >= cap || pool.length >= TARGET_POOL) break;
      if (!t?.id || recent.has(t.id) || pool.find(p => p.id === t.id)) continue;
      pool.push({ ...t, _source: label });
      fromSource[label]++;
      n++;
    }
  };

  // 1. Mood-tagged from the LLM-built library (only if tagger has run).
  await library.load();
  if (mood) {
    take('mood', shuffle(library.songsByMood(mood)), MOOD_WEIGHT);
  }

  // 2. Navidrome playlists whose name matches the mood — operator's hand curation.
  if (mood) {
    try {
      const playlists = await subsonic.getPlaylists();
      const matched = playlists.filter(p => p.name?.toLowerCase().includes(mood.toLowerCase()));
      const tracks = [];
      for (const pl of matched.slice(0, 2)) {
        try {
          const songs = await subsonic.getPlaylist(pl.id);
          tracks.push(...songs);
        } catch {}
      }
      take('playlist', shuffle(tracks), PLAYLIST_WEIGHT);
    } catch (err) {
      queue.log('error', `Playlist fetch failed: ${err.message}`);
    }
  }

  // 3. Recently-added albums — surfaces new music without any tagging.
  try {
    const recentAlbums = await subsonic.getRecentlyAddedAlbums({ size: 8 });
    const tracks = await tracksFromAlbums(shuffle(recentAlbums).slice(0, 4), 2, RECENT_WEIGHT * 2);
    take('recent', tracks, RECENT_WEIGHT);
  } catch (err) {
    queue.log('error', `Recent-albums fetch failed: ${err.message}`);
  }

  // 4. Frequent albums — Navidrome's scrobble-backed favourites.
  try {
    const freqAlbums = await subsonic.getFrequentAlbums({ size: 8 });
    const tracks = await tracksFromAlbums(shuffle(freqAlbums).slice(0, 4), 2, FREQUENT_WEIGHT * 2);
    take('frequent', tracks, FREQUENT_WEIGHT);
  } catch (err) {
    queue.log('error', `Frequent-albums fetch failed: ${err.message}`);
  }

  // 5. Starred — hand-curated.
  try {
    const starred = shuffle(await subsonic.getStarred());
    take('starred', starred, STARRED_WEIGHT);
  } catch (err) {
    queue.log('error', `Starred fetch failed: ${err.message}`);
  }

  // 6. Top up with random to TARGET_POOL.
  if (pool.length < TARGET_POOL) {
    try {
      const random = await subsonic.getRandomSongs({ size: TARGET_POOL });
      take('random', random, TARGET_POOL);
    } catch (err) {
      queue.log('error', `Random fetch failed: ${err.message}`);
    }
  }

  const lines = ['#EXTM3U', ...pool.map(t => subsonic.getAnnotatedUri(t))];
  await writeFile(config.liquidsoap.autoPlaylist, lines.join('\n'));
  queue.log('scheduler',
    `Auto-playlist refreshed: ${pool.length} tracks (` +
    Object.entries(fromSource).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') +
    `, mood=${mood || 'none'})`);
}

// ---------------------------------------------------------------------------
// HOURLY TIME CHECK
// At the top of every hour, the DJ checks in.
// ---------------------------------------------------------------------------

async function hourlyCheck() {
  if (!shouldFire('hourly')) return;
  const ctx = await getFullContext();
  try {
    const script = await dj.generateHourlyTime(ctx.time, ctx.weather, {
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
    });
    await queue.announce(script, 'hourly-check');
  } catch (err) {
    queue.log('error', `Hourly check failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// SKILLS TICK
// Walks the controller/src/skills/ registry. The registry handles per-skill
// cooldowns, the frequency-setting gate, and picks at most one skill to fire
// per tick. Weather lives here now (was scheduler.maybeWeatherUpdate).
// ---------------------------------------------------------------------------

async function skillsTick() {
  try {
    const ctx = await getFullContext();
    await skillRegistry.tick(ctx);
  } catch (err) {
    queue.log('error', `Skills tick failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// STATION ID
// Random ident every ~45 mins
// ---------------------------------------------------------------------------

async function stationId() {
  if (!shouldFire('stationId')) return;
  try {
    const ctx = await getFullContext();
    const script = await dj.generateStationId({
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
    });
    await queue.announce(script, 'station-id');
  } catch (err) {
    queue.log('error', `Station ID failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLEAN UP — old voice WAVs
// ---------------------------------------------------------------------------

async function cleanup() {
  try {
    await cleanupOldVoices();
  } catch (err) {
    queue.log('error', `Cleanup failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------

export function startScheduler() {
  // Initial run
  refreshAutoPlaylist().catch(err => queue.log('error', `Initial playlist failed: ${err.message}`));

  // Auto-playlist refresh every 10 minutes
  cron.schedule(`*/${config.show.autoQueueRefreshMinutes} * * * *`, refreshAutoPlaylist);

  // Top of every hour
  cron.schedule('0 * * * *', hourlyCheck);

  // Skills tick every 5 minutes — registry handles per-skill cooldowns
  // and the frequency-setting gate.
  cron.schedule('*/5 * * * *', skillsTick);

  // Station ID candidate ticks at :00, :15, :30, :45 — handler gates by frequency
  cron.schedule('0,15,30,45 * * * *', stationId);

  // Cleanup every hour
  cron.schedule('0 * * * *', cleanup);

  queue.log('scheduler', `Scheduler started · skills: ${skillRegistry.listSkills().join(', ')}`);
}
