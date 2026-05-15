// Controller HTTP API.
// The Next.js web UI hits this for: now-playing, queue state, request submission.

import express from 'express';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { config } from './config.js';
import * as subsonic from './subsonic.js';
import * as dj from './llm/dj.js';
import * as llmProvider from './llm/provider.js';
import * as library from './library.js';
import * as jingles from './jingles.js';
import * as settings from './settings.js';
import * as tts from './tts.js';
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

// Admin basic auth. In production (NODE_ENV=production) ADMIN_USER and
// ADMIN_PASS are MANDATORY — the controller refuses to start without them,
// because /debug, /settings, and the jingle/tagger endpoints expose enough
// internals (queue, recent LLM calls, library stats, hostnames) that a
// public deploy without auth is effectively an open admin console. In dev
// the gate stays opt-in so local iteration is frictionless.
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_AUTH_REQUIRED = Boolean(ADMIN_USER && ADMIN_PASS);
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD && !ADMIN_AUTH_REQUIRED) {
  console.error(
    '[auth] FATAL: NODE_ENV=production but ADMIN_USER and ADMIN_PASS are not set.\n' +
    '       /debug, /settings and admin endpoints would be publicly readable.\n' +
    '       Set ADMIN_USER and ADMIN_PASS in controller/.env, then rebuild the controller.'
  );
  process.exit(1);
}

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
// Request endpoint throttling. The /request path triggers an LLM call,
// Subsonic searches, TTS, and a booth-log write — cheap individually but
// trivially weaponisable by anyone with curl. Defence in depth:
//   - hard size caps on text + name
//   - operator kill switch (REQUESTS_DISABLED env)
//   - per-IP cooldown (no more than 1 request per COOLDOWN_MS)
//   - per-IP hourly ceiling
// State is in-memory; a controller restart resets counters. Good enough for a
// homelab station; if you need durable enforcement, put a real ratelimit at
// the Caddy edge.
// ---------------------------------------------------------------------------
const REQUEST_TEXT_MAX = 280;
const REQUEST_NAME_MAX = 40;
const REQUEST_COOLDOWN_MS = 20_000;
const REQUEST_HOURLY_CAP = 8;
const REQUESTS_DISABLED = process.env.REQUESTS_DISABLED === '1' || process.env.REQUESTS_DISABLED === 'true';

const requestHistory = new Map(); // ip → { last: ts, hits: [ts,...] }

function clientIp(req) {
  // trust proxy chain (Caddy → controller). Take the left-most public-ish
  // entry. We don't need cryptographic precision — just per-source bucketing.
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff[0] || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;
  const rec = requestHistory.get(ip) || { last: 0, hits: [] };
  rec.hits = rec.hits.filter(t => t > oneHourAgo);
  if (rec.last && now - rec.last < REQUEST_COOLDOWN_MS) {
    return { ok: false, retryAfter: Math.ceil((REQUEST_COOLDOWN_MS - (now - rec.last)) / 1000) };
  }
  if (rec.hits.length >= REQUEST_HOURLY_CAP) {
    const oldest = rec.hits[0];
    return { ok: false, retryAfter: Math.ceil((oldest + 3_600_000 - now) / 1000) };
  }
  rec.last = now;
  rec.hits.push(now);
  requestHistory.set(ip, rec);
  // Opportunistic cleanup so the map doesn't grow unbounded over weeks.
  if (requestHistory.size > 2000) {
    for (const [k, v] of requestHistory) {
      if (!v.hits.length && now - v.last > 3_600_000) requestHistory.delete(k);
    }
  }
  return { ok: true };
}

// Icecast listener count — small helper used by /now-playing. Cheap local
// fetch with a hard 1.5s timeout so a slow Icecast can never wedge the
// every-5s poll the UI does. Returns 0/0 on any failure.
async function getListenerStats() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('http://icecast:7702/status-json.xsl', { signal: ctrl.signal });
    clearTimeout(timer);
    const ic = (await r.json())?.icestats;
    const src = Array.isArray(ic?.source) ? ic.source[0] : ic?.source;
    return {
      current: Number(src?.listeners || 0),
      peak:    Number(src?.listener_peak || 0),
    };
  } catch {
    return { current: 0, peak: 0 };
  }
}

// ---------------------------------------------------------------------------
// GET /cover/:id — proxy Subsonic cover art so listener browsers can use it
// as MediaSession artwork (lock screen / CarPlay / Bluetooth display) without
// the Subsonic credentials leaking into the page. Cached aggressively at the
// edge — cover art for a given song id never changes meaningfully.
// ---------------------------------------------------------------------------
app.get('/cover/:id', async (req, res) => {
  const { id } = req.params;
  // Subsonic ids are short alphanumerics (Navidrome uses base32 hashes).
  // Reject anything else to keep this from being a generic SSRF surface.
  if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).end();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(subsonic.getCoverArtUrl(id, 512), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return res.status(502).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch {
    res.status(502).end();
  }
});

// ---------------------------------------------------------------------------
// GET /now-playing — current track + context snapshot
// ---------------------------------------------------------------------------
app.get('/now-playing', async (req, res) => {
  try {
    const [nowPlaying, ctx, listeners] = await Promise.all([
      queue.getNowPlaying(),
      getFullContext(),
      getListenerStats(),
    ]);
    const s = settings.get();
    res.json({ nowPlaying, context: ctx, dj: { name: s.dj?.name }, listeners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /dj — public-safe DJ + station info for the landing page.
// Exposes only fields the DJ already says on-air; no secrets.
// ---------------------------------------------------------------------------
app.get('/dj', async (req, res) => {
  try {
    await settings.load();
    const s = settings.get();
    res.json({
      name: s.dj?.name || 'Frequency',
      soul: s.dj?.soul || '',
      frequency: s.dj?.frequency || 'moderate',
      station: 'SUB/WAVE',
      location: s.weather?.locationName || '',
    });
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
  if (REQUESTS_DISABLED) {
    return res.status(503).json({ success: false, message: 'Requests are temporarily closed.' });
  }

  const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
  const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
  const text = rawText.trim().slice(0, REQUEST_TEXT_MAX);
  if (!text) {
    return res.status(400).json({ error: 'Empty request' });
  }
  const requester = (rawName.trim().slice(0, REQUEST_NAME_MAX)) || 'anon';

  const gate = checkRateLimit(clientIp(req));
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({
      success: false,
      message: `Easy there — try again in ${gate.retryAfter}s.`,
      retryAfter: gate.retryAfter,
    });
  }

  try {
    queue.log('request', `${requester}: "${text}"`);

    // 0. "more like this" — never let it through the generic search path,
    // it's a meta-instruction about the current track, not a query. Pick
    // another song by the current/last artist and skip the LLM match.
    const isMoreLikeThis = /^more\s+like\s+this[.!?]?$/i.test(text);
    if (isMoreLikeThis) {
      const reference = queue.current || queue.history[0];
      const refArtist = reference?.track?.artist;
      if (!refArtist) {
        return res.json({
          success: false,
          message: `Nothing's playing yet — tell me what you're after instead.`,
        });
      }
      const recentIds = queue.recentlyPlayedIds(25);
      const pick = await pickByArtistAndSort({
        artistName: refArtist,
        sort: null,
        scope: 'song',
        recentIds,
      });
      if (!pick) {
        return res.json({
          success: false,
          message: `Couldn't find more from ${refArtist} in the crates.`,
        });
      }
      const ctx = await getFullContext();
      const introScript = await dj.generateIntro({
        track: pick,
        context: ctx,
        requestedBy: requester,
        requestText: text,
        recap: queue.getDjRecap(),
        recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
      });
      await queue.push({
        track: pick,
        requestedBy: requester,
        intent: 'more_like_this',
        introScript,
      });
      return res.json({
        success: true,
        ack: `More from ${refArtist}, coming up.`,
        track: { title: pick.title, artist: pick.artist },
        queuePosition: queue.upcoming.length,
      });
    }

    // 1. LLM matches intent — pass current track so vibe queries can be
    // interpreted against what's actually on-air ("match this energy",
    // "something slower than this", etc.).
    const currentTrack = queue.current?.track || null;
    const matched = await dj.matchRequest(text, {
      listenerName: requester,
      nowPlaying: currentTrack,
    });
    queue.log('intent', `"${text}" → ${matched.intent || '(no intent)'}`, {
      mood: matched.mood,
      scope: matched.scope,
      sort: matched.sort,
      artist: matched.artist,
      searchTerms: matched.search_terms,
    });

    const recentIds = queue.recentlyPlayedIds(25);
    await library.load();

    // Helper: pick a fresh random item from a pool, preferring non-recents.
    const randomFresh = (pool) => {
      if (!pool || pool.length === 0) return null;
      const fresh = pool.filter(s => s?.id && !recentIds.has(s.id));
      const choose = fresh.length > 0 ? fresh : pool;
      return choose[Math.floor(Math.random() * choose.length)] || null;
    };

    let pick = null;
    let pickSource = null;

    // 2a. Smart artist + sort path — if the listener asked for "latest/oldest
    // album by X", resolve the artist's albums and pick from the right one.
    if (!pick && matched.artist && (matched.sort || matched.scope === 'album')) {
      pick = await pickByArtistAndSort({
        artistName: matched.artist,
        sort: matched.sort,
        scope: matched.scope,
        recentIds,
      });
      if (pick) pickSource = 'artist-sort';
    }

    // 2b. Search by terms — only when the LLM gave us terms that look like
    // real library values (artist/song/genre), not vibe words. The system
    // prompt forbids vibe terms here, but defensively skip search if the
    // only term equals the mood string.
    if (!pick) {
      const terms = (matched.search_terms || []).filter(t => {
        if (!t || typeof t !== 'string') return false;
        if (matched.mood && t.toLowerCase() === matched.mood.toLowerCase()) return false;
        return true;
      });
      if (terms.length > 0) {
        let candidates = [];
        for (const term of terms) {
          const r = await subsonic.search(term, { songCount: 25 });
          candidates = [...candidates, ...r];
        }
        const seen = new Set();
        const unique = candidates.filter(s => {
          if (seen.has(s.id)) return false;
          seen.add(s.id);
          return true;
        });
        pick = randomFresh(unique);
        if (pick) pickSource = 'search';
      }
    }

    // 2c. Mood-tagged library — the right vocabulary for vibe queries. The
    // tagger writes moods like "calm", "rainy", "night" to state/moods.json;
    // matchRequest's "mood" field uses the same vocabulary.
    if (!pick && matched.mood) {
      const moodPool = library.songsByMood(matched.mood);
      pick = randomFresh(moodPool);
      if (pick) pickSource = `library-mood:${matched.mood}`;
    }

    // 2d. Similar-songs from the current track — when the listener's intent
    // is vibe-adjacent and we have something playing, Subsonic can surface
    // adjacency that wasn't captured in our local mood tags.
    if (!pick && currentTrack?.id && (matched.mood || /similar|like|match/i.test(text))) {
      try {
        const similar = await subsonic.getSimilarSongs(currentTrack.id, { count: 20 });
        pick = randomFresh(similar);
        if (pick) pickSource = 'similar-to-current';
      } catch {}
    }

    // 2e. Dominant-mood fallback — if the listener gave us nothing actionable
    // but the station has a mood for the current moment (weather/time/festival),
    // play something that fits the room rather than refusing.
    if (!pick) {
      try {
        const ctxNow = await getFullContext();
        if (ctxNow.dominantMood) {
          const moodPool = library.songsByMood(ctxNow.dominantMood);
          pick = randomFresh(moodPool);
          if (pick) pickSource = `library-mood:${ctxNow.dominantMood}(context)`;
        }
      } catch {}
    }

    // 2f. Starred — operator's hand-picked favourites are always a safe pick.
    if (!pick) {
      try {
        const starred = await subsonic.getStarred();
        pick = randomFresh(starred);
        if (pick) pickSource = 'starred';
      } catch {}
    }

    if (!pick) {
      queue.log('miss', `Nothing matched "${text}"`);
      return res.json({
        success: false,
        message: `Sorry ${requester}, nothing in the crates matched that.`,
      });
    }
    queue.log('request', `resolved via ${pickSource}: ${pick.title} — ${pick.artist}`);

    // 3. Generate DJ intro that mentions the request
    const ctx = await getFullContext();
    const introScript = await dj.generateIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
      requestText: text,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
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
    // Redacted view — masks llm.apiKey / tts.cloud.apiKey so secrets never
    // leave the process. The UI shows "set"/"" and round-trips it harmlessly.
    const s = settings.getRedacted();
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
        tts: s.tts,
        llm: s.llm,
      },
      defaults: {
        dj: settings.getDefaults().dj,
        tts: settings.getDefaults().tts,
        llm: settings.getDefaults().llm,
      },
      tts: {
        engines: tts.ENGINES,
        kinds: tts.VOICE_KINDS.filter(k => k !== 'default'),
        available: tts.availableEngines(),
        kokoroVoices: settings.KOKORO_VOICES_BRITISH,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
      },
      llm: {
        providers: settings.LLM_PROVIDERS,
        active: llmProvider.activeModelLabel(),
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
    const r = await fetch('http://icecast:7702/status-json.xsl');
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

  // 6. Recent LLM calls — `llm` reflects the active provider/model resolved
  // by the registry; `ollama.url` is still shown as the homelab endpoint.
  out.llm = {
    provider: llmProvider.providerName(),
    activeModel: llmProvider.activeModelLabel(),
    ollamaUrl: config.ollama.url,
    recentCalls: dj.recentCalls,
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
