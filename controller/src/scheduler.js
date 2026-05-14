// Scheduler — drives autonomous behaviour:
//   - refreshes the auto-playlist file Liquidsoap falls back to
//   - schedules DJ talk segments between tracks
//   - hourly time/weather checks
//   - station IDs

import cron from 'node-cron';
import { writeFile } from 'node:fs/promises';
import { config } from './config.js';
import * as subsonic from './subsonic.js';
import * as ollama from './ollama.js';
import * as library from './library.js';
import { getFullContext } from './context.js';
import { queue } from './queue.js';
import { cleanupOldVoices } from './tts.js';
import * as settings from './settings.js';

// Gate scheduled DJ events on the current talk frequency. Crons are scheduled
// at the most aggressive cadence; this decides whether a given tick fires.
function shouldFire(kind, now = new Date()) {
  const f = settings.get().dj?.frequency || 'moderate';
  const m = now.getMinutes();
  if (kind === 'stationId') {
    if (f === 'quiet')    return m === 45;
    if (f === 'moderate') return m === 15 || m === 45;
    return [0, 15, 30, 45].includes(m);
  }
  if (kind === 'hourly') {
    if (f === 'quiet') return now.getHours() % 2 === 0;
    return true;
  }
  if (kind === 'weather') {
    if (f === 'quiet')    return m === 0;
    if (f === 'moderate') return m === 0 || m === 30;
    return true;
  }
  return true;
}

const TARGET_POOL = 30;
const MOOD_WEIGHT = 15;       // up to this many mood-tagged tracks per pool
const STARRED_WEIGHT = 8;     // up to this many starred tracks per pool

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
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
  const fromSource = { mood: 0, starred: 0, random: 0 };

  // 1. Mood-tagged tracks from the LLM-built library (only if tagger has run)
  await library.load();
  if (mood) {
    const moodHits = shuffle(library.songsByMood(mood)).filter(t => !recent.has(t.id));
    for (const t of moodHits.slice(0, MOOD_WEIGHT)) {
      pool.push({ ...t, _source: 'mood' });
      fromSource.mood++;
    }
  }

  // 2. Starred tracks — leverages what you've curated by hand
  try {
    const starred = shuffle(await subsonic.getStarred()).filter(s => !recent.has(s.id));
    for (const s of starred.slice(0, STARRED_WEIGHT)) {
      pool.push({ ...s, _source: 'starred' });
      fromSource.starred++;
    }
  } catch (err) {
    queue.log('error', `Starred fetch failed: ${err.message}`);
  }

  // 3. Top up to TARGET_POOL with random
  if (pool.length < TARGET_POOL) {
    try {
      const random = (await subsonic.getRandomSongs({ size: TARGET_POOL })).filter(s => !recent.has(s.id));
      for (const s of random) {
        if (pool.length >= TARGET_POOL) break;
        if (pool.find(p => p.id === s.id)) continue;
        pool.push({ ...s, _source: 'random' });
        fromSource.random++;
      }
    } catch (err) {
      queue.log('error', `Random fetch failed: ${err.message}`);
    }
  }

  // De-dup just in case
  const seen = new Set();
  const unique = pool.filter(t => {
    if (!t.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const lines = ['#EXTM3U', ...unique.map(t => subsonic.getAnnotatedUri(t))];
  await writeFile(config.liquidsoap.autoPlaylist, lines.join('\n'));
  queue.log('scheduler',
    `Auto-playlist refreshed: ${unique.length} tracks ` +
    `(mood=${fromSource.mood} starred=${fromSource.starred} random=${fromSource.random}, mood=${mood || 'none'})`);
}

// ---------------------------------------------------------------------------
// HOURLY TIME CHECK
// At the top of every hour, the DJ checks in.
// ---------------------------------------------------------------------------

async function hourlyCheck() {
  if (!shouldFire('hourly')) return;
  const ctx = await getFullContext();
  try {
    const script = await ollama.generateHourlyTime(ctx.time, ctx.weather, {
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
// WEATHER UPDATE
// Less frequent than hourly — only when significant changes
// ---------------------------------------------------------------------------

let lastWeatherCondition = null;

async function maybeWeatherUpdate() {
  if (!shouldFire('weather')) return;
  const ctx = await getFullContext();
  if (!ctx.weather.condition || ctx.weather.condition === 'unknown') return;
  if (ctx.weather.condition === lastWeatherCondition) return;

  lastWeatherCondition = ctx.weather.condition;
  try {
    const script = await ollama.generateWeatherSegment(ctx.weather, ctx.time, {
      recap: queue.getDjRecap(),
      context: ctx,
      recentOpeners: queue.getRecentOpeners(),
    });
    await queue.announce(script, 'weather');
  } catch (err) {
    queue.log('error', `Weather update failed: ${err.message}`);
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
    const script = await ollama.generateStationId({
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

  // Weather check every 15 minutes — handler gates further on frequency
  cron.schedule('*/15 * * * *', maybeWeatherUpdate);

  // Station ID candidate ticks at :00, :15, :30, :45 — handler gates by frequency
  cron.schedule('0,15,30,45 * * * *', stationId);

  // Cleanup every hour
  cron.schedule('0 * * * *', cleanup);

  queue.log('scheduler', 'Scheduler started');
}
