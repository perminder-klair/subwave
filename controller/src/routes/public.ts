// Public, unauthenticated endpoints: liveness, now-playing, station/DJ info,
// queue state, the cover-art and avatar proxies, and the weekly schedule.
import express from 'express';
import { existsSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as subsonic from '../music/source.js';
import * as library from '../music/library.js';
import * as blocklist from '../music/blocklist.js';
import * as settings from '../settings.js';
import { getFullContext, geocodePlace } from '../context.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { getStreamStatus } from '../broadcast/listeners.js';
import { isIdle } from '../broadcast/stream-idle.js';
import { currentStarve } from '../broadcast/music-starve.js';
import { liveTransport } from '../broadcast/queue/transport.js';
import { getSetupStatusSync } from '../setup/firstRun.js';
import { getStationTimezone } from '../time.js';
import { listThemesAnnotated, DEFAULT_THEME_ID } from '../themes.js';
import { listCommunitySkills } from '../skills/loader.js';
import { listCommunityPersonas } from '../personas/community.js';
import { listCommunityShows } from '../shows/community.js';
import { resolveEraYear } from '../music/show-filter.js';
import { resolveSilenceTrim } from '../music/silence-trim.js';
import { playableDurationSec } from '../broadcast/drain-policy.js';
import { lifetimeTokenCount } from '../llm/log.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { listenerAuthDecision, stationAuthDecision } from '../util/listener-auth.js';
import { publicGuestIds, publicPersonaShape, soulsArePublic } from '../util/public-persona.js';
import { resolveThemeProvenance } from '../util/theme-provenance.js';
import {
  parseSimilarLimit,
  publicSimilarTrack,
  soundKnnWidth,
  similarTracksOutcome,
} from '../util/similar-tracks.js';
import { checkAuthRateLimit, clientIp, listenerAuthFailureDelayMs } from '../middleware/ratelimit.js';
import { requireStationAuth } from '../middleware/station-auth.js';
import { STATE_ROOT } from '../config.js';
import { activeStationId } from '../stations/resolve.js';

export const router = express.Router();

// Boot-frozen: /state must report the station this process is running, not the
// pointer file's current value (the pointer flips first during a switch, and the
// admin UI reads "station.id === target" as "the new controller is up").
const BOOT_STATION_ID = activeStationId(STATE_ROOT);
const BOOT_MULTI_STATION = existsSync(join(STATE_ROOT, 'stations'));

// 1x1 transparent PNG for personas with no avatar, so the UI can render an <img>.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// Public handlers must not reflect internal error text (state-dir paths, upstream
// URLs); detail goes to the booth log. Admin routes still reflect err.message.
function publicError(res: express.Response, route: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  queue.log('error', `${route} failed: ${detail}`);
  res.status(500).json({ error: 'internal error' });
}

function mimeForAvatar(filename: string): string {
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

// Relative path (no `/api` prefix); the web app prepends NEXT_PUBLIC_API_URL.
// Always a string: the endpoint serves a placeholder when no avatar is set.
function avatarUrlFor(personaId?: string | null): string {
  return personaId ? `/persona-avatar/${encodeURIComponent(personaId)}` : '';
}

// Origin for tune-in URLs. SITE_URL wins (canonical, immune to a spoofed Host);
// unset, fall back to how the listener reached us so LAN deployments resolve.
export function publicOrigin(req: express.Request): string {
  const fromEnv = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || req.protocol || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : `http://localhost`;
}

// Proxy Subsonic cover art so browsers get MediaSession artwork without the
// Subsonic credentials. Cached at the edge and in a small in-process LRU.
const COVER_CACHE_MAX = 20;
const coverCache = new Map<string, { buf: Buffer; contentType: string }>();

router.get('/cover/:id', async (req, res) => {
  const { id } = req.params;
  // Subsonic ids are short alphanumerics; anything else would make this an SSRF
  // surface.
  if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).end();

  const sendCover = (entry: { buf: Buffer; contentType: string }) => {
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(entry.buf);
  };

  const hit = coverCache.get(id);
  if (hit) {
    // Map order is insertion order, so delete+set keeps the oldest first.
    coverCache.delete(id);
    coverCache.set(id, hit);
    return sendCover(hit);
  }

  const store = (entry: { buf: Buffer; contentType: string }) => {
    coverCache.set(id, entry);
    if (coverCache.size > COVER_CACHE_MAX) {
      coverCache.delete(coverCache.keys().next().value!);
    }
    sendCover(entry);
  };

  try {
    // The active source hands back either a proxied URL (Subsonic, Spotify —
    // fetch the bytes here so creds never reach the browser) or the bytes
    // directly (a source that holds art itself).
    const art = await subsonic.getCoverArt(id, 512);
    if (!art) return res.status(404).end();
    if ('buf' in art) return store(art);

    const r = await fetchWithTimeout(art.url, { timeoutMs: 5000 });
    if (!r.ok) return res.status(502).end();
    store({
      buf: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get('content-type') || 'image/jpeg',
    });
  } catch {
    res.status(502).end();
  }
});

// Persona portrait; serves the transparent placeholder when no avatar is set.
router.get('/persona-avatar/:id', async (req, res) => {
  const { id } = req.params;
  // Mirrors settings.ID_RE; local so a hand-edited URL can't escape the dir.
  if (!/^[a-z0-9_]{3,32}$/.test(id)) return res.status(400).end();
  try {
    await settings.load();
    const persona = settings.get().personas?.find((p: any) => p.id === id);
    const filename: string = persona?.avatar || '';
    if (!filename) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.send(TRANSPARENT_PNG);
    }
    const path = `${settings.PERSONA_AVATAR_DIR}/${filename}`;
    const st = await stat(path);
    // ETag over filename + mtime: a replacement upload keeps the same name.
    const etag = `"${createHash('sha1').update(`${filename}:${st.mtimeMs}`).digest('hex').slice(0, 16)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', mimeForAvatar(filename));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = await readFile(path);
    res.send(buf);
  } catch {
    // Missing file or failed stat falls back to the placeholder, never a 404.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(TRANSPARENT_PNG);
  }
});

// Current track + context snapshot.
router.get('/now-playing', async (req, res) => {
  try {
    const [nowPlaying, ctx] = await Promise.all([
      queue.getNowPlaying(),
      getFullContext(),
    ]);
    // Enrich with library tag/analysis data; getNowPlaying() stays a pure reader
    // of now-playing.json. An untagged track yields null and fields are omitted.
    if (nowPlaying?.subsonic_id) {
      // Scalars only: this 5s per-listener poll must not parse the heavy
      // acoustic *_json blobs (#723).
      const rec = library.getPlaybackMeta(nowPlaying.subsonic_id);
      if (rec) {
        nowPlaying.genres = rec.genres ?? [];
        nowPlaying.genre = rec.genres?.length ? rec.genres.join(', ') : rec.genre ?? null;
        nowPlaying.bpm = rec.bpm ?? null;
        nowPlaying.musicalKey = rec.musicalKey ?? null;
        nowPlaying.moods = Array.isArray(rec.moods) ? rec.moods : [];
        nowPlaying.energy = rec.energy ?? null;
        // Era year, never the raw `year` (#1418). now-playing.json carries none,
        // so this is the year every skin renders.
        const eraYear = resolveEraYear(rec.year, rec.originalYear, rec.yearUntrusted);
        if (nowPlaying.year == null && eraYear != null) nowPlaying.year = eraYear;
      }
      // Duration is absent from the annotate metadata, so the player's clock
      // needs it here: the queue's record for a tracked play, else the library
      // DB. Publish the PLAYABLE span, not the tagged length — with the dead-air
      // trim on, a tagged duration runs the progress bar past the end. A tracked
      // play carries the cue points the drain stamped; an untracked auto-playlist
      // play has no queue item and can only re-ask the policy module.
      if (nowPlaying.duration == null) {
        const cur = queue.current;
        const tracked = cur?.track?.id === nowPlaying.subsonic_id ? cur : null;
        const duration = tracked?.track?.duration ?? rec?.durationSec ?? null;
        if (typeof duration === 'number' && duration > 0) {
          const playable = tracked
            ? playableDurationSec(duration, tracked.cueOutSec ?? null, tracked.cueInSec ?? null)
            : (() => {
                const trim = resolveSilenceTrim(rec);
                return playableDurationSec(duration, trim.cueOutSec, trim.cueInSec);
              })();
          nowPlaying.duration = playable != null && playable > 0 ? playable : duration;
        }
      }
    }
    // From the 15s listener-monitor cache; no per-request Icecast hit.
    const stream = getStreamStatus();
    const stationSettings = settings.get();
    const persona = settings.getEffectivePersona();
    // Reshaped to carry the public avatar URL, so the UI needs no basename rule.
    const activeShow = ctx.activeShow
      ? {
          name: ctx.activeShow.name,
          persona: ctx.activeShow.persona
            ? {
                id: ctx.activeShow.persona.id,
                name: ctx.activeShow.persona.name,
                avatar: avatarUrlFor(ctx.activeShow.persona.id),
              }
            : null,
          guests: (ctx.activeShow.guests || []).map((g: any) => ({
            id: g.id,
            name: g.name,
            avatar: avatarUrlFor(g.id),
          })),
        }
      : null;
    const s = session.getSession();
    // Context ships nearly whole; `clock.spokenTimeOptions` is a behaviour
    // internal (#1602) stripped here at the public boundary so in-process prompt
    // callers still get it from the same getFullContext. `spokenTime` stays.
    const publicClock: any = { ...(ctx.clock as any) };
    delete publicClock.spokenTimeOptions;
    res.json({
      nowPlaying,
      context: { ...ctx, clock: publicClock },
      dj: {
        name: persona?.name || 'Frequency',
        tagline: persona?.tagline || '',
        avatar: avatarUrlFor(persona?.id),
        station: stationSettings.station,
      },
      activeShow,
      session: s ? { id: s.id, kind: s.kind, startedAt: s.startedAt, show: s.show?.name || null } : null,
      listeners: stream.listeners,
      streamOnline: stream.online,
      streamBitrate: stream.bitrate,
      // Mirrored by /listen.pls + /listen.m3u, additive to streamOnline/Bitrate.
      // mount/format are the always-served MP3 floor; the *Enabled flags let
      // clients discover the optional mounts.
      stream: {
        mount: '/stream.mp3',
        format: 'mp3',
        bitrate: stream.bitrate,
        sampleRate: stream.sampleRate,
        channels: stream.channels,
        // Seconds a listener sits behind the live edge; every timestamp here is
        // live-edge, so players subtract this for listener-time (#1114). Never
        // measure it as `buffered.end - currentTime` (that is the demux window).
        // Operator surfaces (admin, MCP) intentionally keep live edge.
        bufferSeconds: stationSettings.stream?.bufferSeconds ?? 22,
        opusEnabled: stationSettings.stream?.opusEnabled === true,
        flacEnabled: stationSettings.stream?.flacEnabled === true,
        aacEnabled: stationSettings.stream?.aacEnabled === true,
      },
      // Aggregate only; the model/cost breakdown stays on admin-gated /stats.
      llmTokens: lifetimeTokenCount(),
      // The DJ speaks the time in this zone, so UI timestamps must render in it
      // too or they disagree with what was said (#418).
      timezone: getStationTimezone(),
      locale: stationSettings.locale,
    });
  } catch (err) {
    publicError(res, '/now-playing', err);
  }
});

// One-paste tune-in files. The always-served MP3 floor comes first; optional
// Opus / FLAC / AAC mounts are appended only when enabled.
function listenMounts(req: express.Request) {
  const origin = publicOrigin(req);
  const s = settings.get();
  const station = s.station || 'SUB/WAVE';
  const entries = [{ url: `${origin}/stream.mp3`, title: station }];
  if (s.stream?.opusEnabled === true) {
    entries.push({ url: `${origin}/stream.opus`, title: `${station} (Opus)` });
  }
  if (s.stream?.flacEnabled === true) {
    entries.push({ url: `${origin}/stream.flac`, title: `${station} (FLAC)` });
  }
  if (s.stream?.aacEnabled === true) {
    entries.push({ url: `${origin}/stream.aac`, title: `${station} (AAC)` });
  }
  return { station, entries };
}

// With listener auth on, these would hand out credential-less URLs Icecast
// rejects, so refuse; operators share credentialed URLs by hand.
function tuneInFilesBlocked(res: express.Response): boolean {
  if (settings.get()?.privacy?.listenerAuth !== true) return false;
  res.status(403).send('This station is private.\n');
  return true;
}

router.get('/listen.pls', (req, res) => {
  if (tuneInFilesBlocked(res)) return;
  const { entries } = listenMounts(req);
  const lines = ['[playlist]', `NumberOfEntries=${entries.length}`];
  entries.forEach((e, i) => {
    const n = i + 1;
    lines.push(`File${n}=${e.url}`, `Title${n}=${e.title}`, `Length${n}=-1`);
  });
  lines.push('Version=2');
  res.setHeader('Content-Type', 'audio/x-scpls; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="listen.pls"');
  res.send(lines.join('\n') + '\n');
});

router.get('/listen.m3u', (req, res) => {
  if (tuneInFilesBlocked(res)) return;
  const { entries } = listenMounts(req);
  const lines = ['#EXTM3U'];
  for (const e of entries) lines.push(`#EXTINF:-1,${e.title}`, e.url);
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="listen.m3u"');
  res.send(lines.join('\n') + '\n');
});

// Public-safe DJ + station info: only fields the DJ already says on air.
router.get('/dj', async (req, res) => {
  try {
    await settings.load();
    const s = settings.get();
    const persona = settings.getEffectivePersona();
    res.json({
      name: persona?.name || 'Frequency',
      tagline: persona?.tagline || '',
      soul: persona?.soul || '',
      frequency: persona?.frequency || 'moderate',
      djMode: persona?.djMode === true,
      linkStyle: persona?.linkStyle === 'announce' ? 'announce' : 'natural',
      avatar: avatarUrlFor(persona?.id),
      station: s.station,
      // Persona-independent so a shared link reads the same whoever is on air
      // (#1086). '' = unset; the web app falls back to the persona tagline.
      stationDescription: s.stationDescription || '',
      // Broad on-air location only, never the precise weather label: this is
      // unauthenticated and an exact town is the doxxing vector.
      location: settings.resolveOnAirLocation(s),
      locale: s.locale,
    });
  } catch (err) {
    publicError(res, '/dj', err);
  }
});

// Listener-facing week view: shows, the 7x24 grid and a persona index (plus
// `soul` when privacy.publishPersonaSouls is on). No TTS config, no behaviour
// dials, no admin-only fields.
router.get('/schedule', async (req, res) => {
  try {
    await settings.load();
    const s = settings.get();
    const withSouls = soulsArePublic(s);
    const roster = s.personas || [];
    const personas = roster.map((p: any) => publicPersonaShape(p, withSouls, avatarUrlFor(p.id)));
    const shows = (s.shows || []).map((show: any) => ({
      id: show.id,
      name: show.name,
      topic: show.topic,
      // `mood` is the lead entry for older clients, derived and never stored (#929).
      moods: Array.isArray(show.moods) ? show.moods : [],
      mood: Array.isArray(show.moods) && show.moods.length ? show.moods[0] : '',
      personaId: show.personaId,
      // Resolved against the live roster, so a persona deleted after the show
      // was saved vanishes.
      guestPersonaIds: publicGuestIds(show.guestPersonaIds, roster),
    }));
    res.json({
      personas,
      shows,
      schedule: s.schedule,
      // Tells "no souls published" from "souls on but blank", which key presence
      // cannot on an empty roster.
      soulsPublished: withSouls,
      // Timed takeover (#930); expired/dangling overrides report null even before
      // the janitor sweeps them.
      override: settings.getScheduleOverride(),
      // The grid is in the STATION's timezone, not the browser's, so it rides along.
      timezone: getStationTimezone(),
      locale: s.locale,
    });
  } catch (err) {
    publicError(res, '/schedule', err);
  }
});

// The DJ roster, same shape /schedule embeds. `activePersonaId` is the selected
// persona; who is actually on air comes from /dj or /now-playing's activeShow.
router.get('/personas', async (req, res) => {
  try {
    await settings.load();
    const s = settings.get();
    const withSouls = soulsArePublic(s);
    res.json({
      personas: (s.personas || []).map((p: any) =>
        publicPersonaShape(p, withSouls, avatarUrlFor(p.id)),
      ),
      activePersonaId: s.activePersonaId || '',
      // "Publishes no souls" vs "every soul is blank", so a client can hide the
      // bio column.
      soulsPublished: withSouls,
    });
  } catch (err) {
    publicError(res, '/personas', err);
  }
});

// Queue + history + DJ log.
router.get('/state', (req, res) => {
  const snap = queue.snapshot();
  // `theme.active` rides along so pollers learn the effective theme changed
  // without refetching tokens; an on-air show's override wins over the default.
  const s = settings.get();
  const activeShow = settings.resolveActiveShow();
  const activeThemeId =
    (activeShow?.themeId && activeShow.themeId) || s?.theme?.active || DEFAULT_THEME_ID;
  const starve = currentStarve();
  res.json({
    ...snap,
    needsSetup: getSetupStatusSync().needsSetup,
    // Programme paused by the idle gate (zero listeners), not broken.
    streamIdle: isIdle(),
    // Music chain starved (#1300), emergency loop on air. Not streamIdle, which
    // is a deliberate pause.
    musicStarved: starve.starved,
    musicStarvedSince: starve.since,
    // The live playback transport's state when the active music source has
    // one (Spotify): what the receiver is playing / awaiting / holding, or null
    // in file mode. Operator surface — live edge, like everything else here.
    transport: liveTransport()?.status() ?? null,
    theme: { active: activeThemeId },
    // Ride along like the theme so the player flips them on the next poll.
    ui: {
      boothBuddy: s?.ui?.boothBuddy ?? false,
      skin: s?.ui?.skin || 'classic',
      tuneInOverlay: s?.ui?.tuneInOverlay ?? true,
    },
    // For rendering djLog timestamps in station-local time (#418).
    timezone: getStationTimezone(),
    locale: s.locale,
    // Private-station flags (#478): booleans only, never the password.
    privacy: {
      privatePlayer: s?.privacy?.privatePlayer === true,
      listenerAuth: s?.privacy?.listenerAuth === true,
    },
    station: {
      id: BOOT_STATION_ID,
      name: s?.station || 'SUB/WAVE',
      multiStation: BOOT_MULTI_STATION,
    },
  });
});

// Icecast URL-auth callback (#478): `icecast-auth-user: 1` + 200 admits, 401
// rejects. Fails OPEN when listenerAuth is off, so the web UI must use
// /station-auth instead. Not rate-limited per IP because the caller is always
// Icecast and one bucket would throttle every listener; failures are damped
// in-handler below instead (successes are never delayed).
router.post(
  '/listener-auth',
  express.urlencoded({ extended: false, limit: '10kb' }),
  async (req, res) => {
    await settings.load();
    const s = settings.get();
    const allow = listenerAuthDecision({
      enabled: s?.privacy?.listenerAuth === true,
      password: s?.privacy?.password || '',
      action: typeof req.body?.action === 'string' ? req.body.action : '',
      pass: typeof req.body?.pass === 'string' ? req.body.pass : '',
      mount: typeof req.body?.mount === 'string' ? req.body.mount : '',
    });
    if (allow) {
      res.setHeader('icecast-auth-user', '1');
      res.status(200).send('ok\n');
    } else {
      // Only reached with the lock on and the credential wrong.
      const delayMs = listenerAuthFailureDelayMs();
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.setHeader('icecast-auth-message', 'invalid listener credentials');
      res.status(401).send('denied\n');
    }
  },
);

// The web player's gate (#478). Same password as /listener-auth, opposite
// failure mode: fails CLOSED whenever either privacy lock is on. Rate-limited,
// since the caller is an arbitrary browser. The password is never logged.
router.post(
  '/station-auth',
  express.json({ limit: '10kb' }),
  async (req, res) => {
    const gate = checkAuthRateLimit(clientIp(req));
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      res.status(429).json({ ok: false, error: 'too many attempts' });
      return;
    }
    await settings.load();
    const s = settings.get();
    const ok = stationAuthDecision({
      privatePlayer: s?.privacy?.privatePlayer === true,
      listenerAuth: s?.privacy?.listenerAuth === true,
      password: s?.privacy?.password || '',
      candidate: typeof req.body?.password === 'string' ? req.body.password : '',
    });
    res.status(ok ? 200 : 401).json({ ok });
  },
);

// Seed resolution shared by both /similar-tracks paths. slimById carries
// albumId/artistId so isBlocked reaches its exact id tiers rather than the
// (album name, artist) fallback a compilation defeats.
function seedRowFor(id: string): { id: string; title: string | null; artist: string | null } | null {
  const row = library.slimById(id);
  if (!row || blocklist.isBlocked(row)) return null;
  return { id, title: row.title ?? null, artist: row.artist ?? null };
}

// The CLAP "sounds like this" lookup outside the admin panel (#1575). Gated on
// the STATION password (requireStationAuth, fails CLOSED); rows are the public
// subset in util/similar-tracks.ts.
// Always 200 with a `reason`: a lean analyzer, an unanalysed library and an
// unknown seed are three different empty results a 503 cannot separate.
// Neighbours are filtered once inside tracksLikeThisAudio's rejectBlocked
// chokepoint; never add a second filter. The seed echo is separate because
// library.get()/filter() are blocklist-blind, and `q` would otherwise make a
// blocked track's title and artist an unauthenticated lookup by name.
router.get('/similar-tracks', requireStationAuth, async (req, res) => {
  const id = (typeof req.query?.id === 'string' ? req.query.id : '').trim();
  const q = (typeof req.query?.q === 'string' ? req.query.q : '').trim();
  if (!id && !q) return res.status(400).json({ error: 'id or q is required' });
  const limit = parseSimilarLimit(req.query?.limit);

  try {
    await library.load();
    const stats = library.stats();

    // Resolved here, not via the title fallback, so the caller is told WHICH
    // track answered. Same order the KNN uses: id, then first analysed text match.
    let seedId = '';
    let seedRow: { id: string; title: string | null; artist: string | null } | null = null;
    let seedFound = false;

    if (id) {
      const row = seedRowFor(id);
      if (row) {
        seedFound = true;
        seedRow = row;
        if (library.hasAudioVector(id)) seedId = id;
      }
    }
    if (!seedId && q) {
      for (const cand of library.filter({ q, limit: 8 }).rows) {
        const row = seedRowFor(cand.id);
        if (!row) continue;
        seedFound = true;
        // Report the best text match even when none is analysed; that is what
        // makes 'seed-not-analysed' actionable.
        if (!seedRow) seedRow = row;
        if (library.hasAudioVector(cand.id)) {
          seedId = cand.id;
          seedRow = row;
          break;
        }
      }
    }

    const hits = seedId ? library.tracksLikeThisAudio(seedId, soundKnnWidth(limit)) : [];
    const results = hits
      // The station's own archive mixdowns are not music (#273).
      .filter((t) => !subsonic.isStationArchive(t))
      .filter((t) => t.id !== seedId)
      .slice(0, limit)
      .map(publicSimilarTrack);

    const outcome = similarTracksOutcome({
      audioIndexSize: stats.withAudioEmbedding ?? 0,
      // mirrorTotal, not total: the analyzer writes CLAP vectors independently of
      // the tagger, so `total` (tagged only) can be the smaller number.
      libraryTotal: stats.mirrorTotal ?? 0,
      seedFound,
      seedHasVector: Boolean(seedId),
      neighbourCount: results.length,
    });

    res.json({ seed: seedRow, results, ...outcome });
  } catch (err) {
    publicError(res, '/similar-tracks', err);
  }
});

// Public theme registry. `active` is the EFFECTIVE theme (the on-air show's
// themeId when it resolves, else the station default).
router.get('/themes', async (req, res) => {
  try {
    const s = settings.get();
    const themes = await listThemesAnnotated();
    // activeSource/stationDefault/activeShow carry WHY that id won (#1300). The
    // precedence rule lives in util/theme-provenance.ts, never inline here.
    const provenance = resolveThemeProvenance({
      stationDefault: s?.theme?.active || DEFAULT_THEME_ID,
      activeShow: settings.resolveActiveShow(),
      themeIds: themes.map(t => t.id),
    });
    res.json({ ...provenance, themes });
  } catch (err) {
    publicError(res, '/themes', err);
  }
});

// Live session header plus a bounded tail of its turns for the Booth feed.
// `sfx` turns are dropped here (internal agent action, not something said on
// air) but stay in the session history for the agent's own context.
router.get('/session', (req, res) => {
  const s = session.getSession();
  if (!s) return res.json({ session: null, messages: [] });
  res.json({
    session: {
      id: s.id,
      kind: s.kind,
      key: s.key,
      startedAt: s.startedAt,
      show: s.show?.name || null,
    },
    messages: s.messages.filter(m => m.kind !== 'sfx').slice(-120),
  });
});

// The shipped community skill catalog, browse-only. Never throws; an empty
// catalog returns []. No admin gate: static shipped data.
router.get('/skills/community', async (req, res) => {
  try {
    const community = await listCommunitySkills();
    res.json({ community });
  } catch (err) {
    publicError(res, '/skills/community', err);
  }
});

// Shipped community persona catalog; same posture as /skills/community.
router.get('/personas/community', async (req, res) => {
  try {
    const community = await listCommunityPersonas();
    res.json({ community });
  } catch (err) {
    publicError(res, '/personas/community', err);
  }
});

// Community show-template catalog; installing requires admin (routes/shows.ts).
router.get('/shows/community', async (req, res) => {
  try {
    const community = await listCommunityShows();
    res.json({ community });
  } catch (err) {
    publicError(res, '/shows/community', err);
  }
});

// Place-name lookup proxied over Open-Meteo's keyless geocoding API (the
// controller owns all external IO). Unauthenticated because onboarding runs
// pre-auth. 502 on upstream failure so the client can fall back to manual entry.
router.get('/geocode', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    const results = await geocodePlace(q);
    res.json({ results });
  } catch {
    res.status(502).json({ error: 'geocode_unavailable' });
  }
});

router.get('/health', (req, res) => res.json({ status: 'on-air' }));
