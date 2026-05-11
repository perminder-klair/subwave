// Controller HTTP API.
// The Next.js web UI hits this for: now-playing, queue state, request submission.

import express from 'express';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { config } from './config.js';
import * as subsonic from './subsonic.js';
import * as ollama from './ollama.js';
import * as library from './library.js';
import * as jingles from './jingles.js';
import * as settings from './settings.js';
import { restartLiquidsoap } from './liquidsoap-control.js';
import { getFullContext, invalidateWeatherCache } from './context.js';
import { queue } from './queue.js';
import { startScheduler } from './scheduler.js';

// Background tagger process tracking (single-flight)
const tagger = { running: false, startedAt: null, pid: null, lastLog: [] };

// Resolve "latest album by Diljit" style requests: find the artist, sort their
// albums by year, pick a song from the right album. Returns a Subsonic song or null.
async function pickByArtistAndSort({ artistName, sort, scope, recentIds }) {
  try {
    const artists = await subsonic.searchArtists(artistName, { artistCount: 5 });
    if (artists.length === 0) return null;
    const artist = await subsonic.getArtist(artists[0].id);
    let albums = artist?.album || [];
    if (albums.length === 0) return null;

    if (sort === 'latest') {
      albums = [...albums].sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (sort === 'oldest') {
      albums = [...albums].sort((a, b) => (a.year || 9999) - (b.year || 9999));
    }
    // sort=popular or null → leave order as Subsonic returned

    // Try the top-ranked album first; if its tracks are all recently played,
    // walk down the list before giving up.
    for (const album of albums.slice(0, 5)) {
      const songs = await subsonic.getAlbum(album.id);
      if (songs.length === 0) continue;
      const fresh = songs.filter(s => !recentIds.has(s.id));
      const pool = fresh.length > 0 ? fresh : songs;
      // scope=album → random track from the album; scope=song → same thing here
      return pool[Math.floor(Math.random() * pool.length)];
    }
  } catch (err) {
    queue.log('error', `pickByArtistAndSort failed: ${err.message}`);
  }
  return null;
}

const app = express();
app.use(express.json());

// CORS for the Next.js frontend
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Admin basic auth — opt-in via env. When ADMIN_USER + ADMIN_PASS are unset
// the gate is a no-op so local dev stays frictionless. The web SettingsDialog
// stores the credentials in localStorage and attaches them as an Authorization
// header to every admin-side fetch.
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_AUTH_REQUIRED = Boolean(ADMIN_USER && ADMIN_PASS);

function requireAdmin(req, res, next) {
  if (!ADMIN_AUTH_REQUIRED) return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const [u, p] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
      if (u === ADMIN_USER && p === ADMIN_PASS) return next();
    } catch {}
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE admin"');
  return res.status(401).json({ error: 'admin auth required' });
}

console.log(`[auth] admin gate ${ADMIN_AUTH_REQUIRED ? 'ENABLED' : 'disabled (set ADMIN_USER+ADMIN_PASS to enable)'}`);

// ---------------------------------------------------------------------------
// GET /now-playing — current track + context snapshot
// ---------------------------------------------------------------------------
app.get('/now-playing', async (req, res) => {
  try {
    const [nowPlaying, ctx] = await Promise.all([
      queue.getNowPlaying(),
      getFullContext(),
    ]);
    const s = settings.get();
    res.json({ nowPlaying, context: ctx, dj: { name: s.dj?.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /state — queue + history + DJ log
// ---------------------------------------------------------------------------
app.get('/state', (req, res) => {
  res.json(queue.snapshot());
});

// ---------------------------------------------------------------------------
// POST /request — listener submits a request
// ---------------------------------------------------------------------------
app.post('/request', async (req, res) => {
  const { text, name } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Empty request' });
  }
  const requester = (name || '').trim() || 'anon';

  try {
    queue.log('request', `${requester}: "${text}"`);

    // 1. LLM matches intent
    const matched = await ollama.matchRequest(text, { listenerName: requester });

    const recentIds = queue.recentlyPlayedIds(25);
    let pick = null;

    // 2a. Smart artist + sort path — if the listener asked for "latest/oldest
    // album by X", resolve the artist's albums and pick from the right one.
    if (matched.artist && (matched.sort || matched.scope === 'album')) {
      pick = await pickByArtistAndSort({
        artistName: matched.artist,
        sort: matched.sort,
        scope: matched.scope,
        recentIds,
      });
    }

    // 2b. Generic search path — search by terms, filter recents, random pick.
    if (!pick) {
      let candidates = [];
      for (const term of matched.search_terms || []) {
        const r = await subsonic.search(term, { songCount: 25 });
        candidates = [...candidates, ...r];
      }

      const seen = new Set();
      const unique = candidates.filter(s => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });

      const fresh = unique.filter(s => !recentIds.has(s.id));
      const pool = fresh.length > 0 ? fresh : unique;
      pick = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
    }

    // 2c. Mood fallback
    if (!pick && matched.mood) {
      const moodPool = await subsonic.getRandomSongs({ size: 10, genre: matched.mood });
      pick = moodPool[Math.floor(Math.random() * moodPool.length)] || null;
    }

    if (!pick) {
      queue.log('miss', `Nothing matched "${text}"`);
      return res.json({
        success: false,
        message: `Sorry ${requester}, nothing in the crates matched that.`,
      });
    }

    // 3. Generate DJ intro that mentions the request
    const ctx = await getFullContext();
    const introScript = await ollama.generateIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
    });

    // 4. Add to queue (will trigger Liquidsoap via the queue manager)
    await queue.push({
      track: pick,
      requestedBy: requester,
      intent: matched.intent,
      introScript,
    });

    res.json({
      success: true,
      ack: matched.ack,
      track: { title: pick.title, artist: pick.artist },
      queuePosition: queue.upcoming.length,
    });
  } catch (err) {
    queue.log('error', `Request handling failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// (manual skip is not implemented in this build — Liquidsoap controls pacing)

// ---------------------------------------------------------------------------
// POST /auto-pick — toggle whether the LLM picks the next track
// Body: { "on": true | false }
// ---------------------------------------------------------------------------
app.post('/auto-pick', requireAdmin, express.json(), (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoPick = req.body.on;
  queue.log('scheduler', `auto-pick ${queue.autoPick ? 'enabled' : 'disabled'}`);
  res.json({ autoPick: queue.autoPick });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'on-air' }));

// ---------------------------------------------------------------------------
// JINGLES — list / create / delete pre-recorded TTS stingers
// ---------------------------------------------------------------------------
app.get('/jingles', requireAdmin, async (req, res) => {
  try {
    res.json({ jingles: await jingles.list() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/jingles', requireAdmin, async (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 500) return res.status(400).json({ error: 'text too long (max 500)' });
  try {
    const created = await jingles.create(text);
    queue.log('scheduler', `New jingle created: "${text.slice(0, 60)}…"`);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/jingles/:filename', requireAdmin, async (req, res) => {
  try {
    res.json(await jingles.remove(req.params.filename));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// SETTINGS — single endpoint that returns everything the /settings UI needs
// ---------------------------------------------------------------------------
app.get('/settings', requireAdmin, async (req, res) => {
  try {
    await library.load();
    await settings.load();
    const s = settings.get();
    res.json({
      autoPick: queue.autoPick,
      pickerBusy: queue.pickerBusy,
      jingles: await jingles.list(),
      libraryStats: library.stats(),
      tagger: { ...tagger, lastLog: tagger.lastLog.slice(-30) },
      ollama: { url: config.ollama.url, model: config.ollama.model },
      values: {
        jingleRatio: s.jingleRatio,
        crossfadeDuration: s.crossfadeDuration,
        weather: s.weather,
        dj: s.dj,
      },
      defaults: {
        dj: settings.getDefaults().dj,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /settings — update values. Returns { requiresRestart } so the UI can
// prompt the user to restart the mixer for jingle freq / crossfade changes.
// ---------------------------------------------------------------------------
app.post('/settings', requireAdmin, async (req, res) => {
  try {
    const result = await settings.update(req.body || {});
    // Apply live: weather location flows through config.weather to context.js
    if ('weather' in (req.body || {})) {
      config.weather.lat = result.saved.weather.lat;
      config.weather.lng = result.saved.weather.lng;
      config.weather.locationName = result.saved.weather.locationName;
      invalidateWeatherCache();
      queue.log('scheduler', `weather location → ${result.saved.weather.locationName}`);
    }
    if (result.requiresRestart) {
      queue.log('scheduler', `mixer settings changed — Liquidsoap restart required`);
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /restart-mixer — telnet → Liquidsoap → shutdown → container restart
// Brief gap of dead air covered by Icecast burst buffer + emergency.mp3.
// ---------------------------------------------------------------------------
app.post('/restart-mixer', requireAdmin, async (req, res) => {
  try {
    await restartLiquidsoap();
    queue.log('scheduler', 'mixer restart requested');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// TAG-LIBRARY — kick off the tagger as a background child process.
// Polls /settings to see progress (library.total grows; tagger.running flips).
// ---------------------------------------------------------------------------
app.post('/tag-library', requireAdmin, (req, res) => {
  if (tagger.running) return res.status(409).json({ error: 'tagger already running', tagger });
  const limit = parseInt(req.body?.limit, 10);
  const args = ['src/tag-library.js'];
  if (Number.isFinite(limit) && limit > 0) args.push('--limit', String(limit));

  const child = spawn('node', args, { cwd: '/app', detached: false });
  tagger.running = true;
  tagger.startedAt = new Date().toISOString();
  tagger.pid = child.pid;
  tagger.lastLog = [];

  const capture = (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.trim());
    tagger.lastLog.push(...lines);
    if (tagger.lastLog.length > 100) tagger.lastLog = tagger.lastLog.slice(-100);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code) => {
    tagger.running = false;
    tagger.lastLog.push(`[exit ${code}]`);
    queue.log('scheduler', `tagger finished (exit ${code})`);
  });
  queue.log('scheduler', `tagger started${Number.isFinite(limit) ? ` (limit=${limit})` : ''}`);
  res.json({ ok: true, tagger });
});

// ---------------------------------------------------------------------------
// GET /debug — everything-at-a-glance for the debug UI
// ---------------------------------------------------------------------------
app.get('/debug', requireAdmin, async (req, res) => {
  const out = { t: new Date().toISOString() };

  // 1. now-playing.json (what Liquidsoap last wrote)
  try {
    out.nowPlaying = JSON.parse(await readFile(config.liquidsoap.nowPlayingFile, 'utf8'));
  } catch (err) {
    out.nowPlaying = { error: err.message };
  }

  // 2. Queue snapshot (current + upcoming + history + djLog)
  out.queue = {
    current: queue.current ? {
      title: queue.current.track.title,
      artist: queue.current.track.artist,
      album: queue.current.track.album,
      requestedBy: queue.current.requestedBy,
      source: queue.current.source,
      intent: queue.current.intent,
      introScript: queue.current.introScript,
    } : null,
    upcoming: queue.upcoming.map(i => ({
      title: i.track.title, artist: i.track.artist,
      requestedBy: i.requestedBy, aiPicked: i.aiPicked,
    })),
    historyCount: queue.history.length,
    djLogCount: queue.djLog.length,
    djLog: queue.djLog.slice(0, 30),
    autoPick: queue.autoPick,
    pickerBusy: queue.pickerBusy,
  };

  // 3. Icecast status
  try {
    const r = await fetch('http://icecast:8000/status-json.xsl');
    const ic = (await r.json()).icestats;
    const src = Array.isArray(ic.source) ? ic.source[0] : ic.source;
    out.icecast = src ? {
      title: src.title,
      bitrate: src.bitrate,
      listeners: src.listeners,
      listener_peak: src.listener_peak,
      mount: src.listenurl,
      stream_start: src.stream_start_iso8601,
      server_start: ic.server_start_iso8601,
    } : { error: 'no source connected' };
  } catch (err) {
    out.icecast = { error: err.message };
  }

  // 4. Liquidsoap log tail
  try {
    const log = await readFile('/var/log/liquidsoap/radio.log', 'utf8');
    out.liquidsoapLog = log.split('\n').slice(-100).join('\n');
  } catch (err) {
    out.liquidsoapLog = `error: ${err.message}`;
  }

  // 5. State dir listing
  try {
    const dir = '/var/sub-wave';
    const entries = await readdir(dir);
    out.stateFiles = await Promise.all(entries.map(async (name) => {
      try {
        const s = await stat(`${dir}/${name}`);
        return { name, size: s.size, mtime: s.mtime.toISOString(), isDir: s.isDirectory() };
      } catch { return { name, error: true }; }
    }));
    const voiceDir = `${dir}/voice`;
    try {
      const v = await readdir(voiceDir);
      out.voiceFiles = await Promise.all(v.map(async (name) => {
        const s = await stat(`${voiceDir}/${name}`);
        return { name, size: s.size, mtime: s.mtime.toISOString() };
      }));
    } catch {}
  } catch (err) {
    out.stateFiles = { error: err.message };
  }

  // 6. Recent Ollama calls
  out.ollama = {
    url: config.ollama.url,
    model: config.ollama.model,
    recentCalls: ollama.recentCalls,
  };

  // 6b. Library tagging stats
  try {
    await library.load();
    out.library = library.stats();
  } catch (err) {
    out.library = { error: err.message };
  }

  // 7. Context snapshot
  try {
    out.context = await getFullContext();
  } catch (err) {
    out.context = { error: err.message };
  }

  // 8. Config (redacted)
  out.config = {
    navidromeUrl: config.navidrome.url,
    navidromeUser: config.navidrome.user,
    ollamaUrl: config.ollama.url,
    ollamaModel: config.ollama.model,
    location: config.weather.locationName,
    port: config.server.port,
  };

  res.json(out);
});

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
app.listen(config.server.port, async () => {
  console.log(`SUB/WAVE controller on :${config.server.port}`);

  // Layer persisted settings over the static config defaults
  try {
    await settings.load();
    const s = settings.get();
    config.weather.lat = s.weather.lat;
    config.weather.lng = s.weather.lng;
    config.weather.locationName = s.weather.locationName;
    await settings.ensureLiquidsoapSettingsFile();
    console.log(`[settings] loaded. jingleRatio=${s.jingleRatio} crossfadeDuration=${s.crossfadeDuration} location=${s.weather.locationName}`);
  } catch (err) {
    console.error('[settings] load failed:', err.message);
  }

  queue.startWatcher();
  startScheduler();
  jingles.ensureDefaultIdent().catch(err => console.error('[jingles] ident generation failed:', err.message));
});
