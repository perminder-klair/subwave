// Public, unauthenticated endpoints: liveness, now-playing, station/DJ info,
// queue state, the cover-art proxy, the persona-avatar proxy, and the
// listener-facing weekly schedule.
import express from 'express';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as subsonic from '../music/subsonic.js';
import * as library from '../music/library.js';
import * as settings from '../settings.js';
import { getFullContext, geocodePlace } from '../context.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { getStreamStatus } from '../broadcast/listeners.js';
import { getSetupStatusSync } from '../setup/firstRun.js';
import { getStationTimezone } from '../time.js';
import { listThemesAnnotated, DEFAULT_THEME_ID } from '../themes.js';
import { listCommunitySkills } from '../skills/loader.js';
import { listCommunityPersonas } from '../personas/community.js';
import { lifetimeTokenCount } from '../llm/log.js';

export const router = express.Router();

// 1×1 transparent PNG — served when a persona has no avatar so the listener
// UI can render an <img> tag without a broken-image icon. Cheap, no shipped
// asset required.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function mimeForAvatar(filename: string): string {
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

// Relative path (no `/api` prefix) the listener UI uses for a persona's
// avatar. The web app prepends its NEXT_PUBLIC_API_URL (`/api` in prod via
// Caddy, an absolute origin in dev), mirroring how `/cover/:id` is consumed.
// Always returns a string — the endpoint serves a 1×1 placeholder when no
// avatar is set, so callers don't need to check for "is it set".
function avatarUrlFor(personaId?: string | null): string {
  return personaId ? `/persona-avatar/${encodeURIComponent(personaId)}` : '';
}

// Resolve the public origin to build tune-in URLs from. SITE_URL (set by the
// operator) wins — it's the trusted, canonical address and is immune to a
// spoofed Host header on a misconfigured reverse proxy. When it's unset we fall
// back to how the listener actually reached us (X-Forwarded-Proto/Host from the
// proxy, else the request's own protocol/host) so LAN, Tailscale, and ad-hoc
// custom-domain deployments still emit a URL that resolves for the listener.
export function publicOrigin(req: express.Request): string {
  const fromEnv = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || req.protocol || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : `http://localhost`;
}

// ---------------------------------------------------------------------------
// GET /cover/:id — proxy Subsonic cover art so listener browsers can use it
// as MediaSession artwork (lock screen / CarPlay / Bluetooth display) without
// the Subsonic credentials leaking into the page. Cached aggressively at the
// edge — cover art for a given song id never changes meaningfully — and in a
// small in-process LRU, because the bundled Caddy doesn't cache: without it,
// every listener's first view of each track is a separate round trip to
// Navidrome (possibly Cloudflare-fronted and slow).
// ---------------------------------------------------------------------------
const COVER_CACHE_MAX = 20;
const coverCache = new Map<string, { buf: Buffer; contentType: string }>();

router.get('/cover/:id', async (req, res) => {
  const { id } = req.params;
  // Subsonic ids are short alphanumerics (Navidrome uses base32 hashes).
  // Reject anything else to keep this from being a generic SSRF surface.
  if (!/^[\w-]{1,64}$/.test(id)) return res.status(400).end();

  const sendCover = (entry: { buf: Buffer; contentType: string }) => {
    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(entry.buf);
  };

  const hit = coverCache.get(id);
  if (hit) {
    // Refresh recency — Map iteration order is insertion order, so
    // delete+set keeps the oldest entry first for eviction.
    coverCache.delete(id);
    coverCache.set(id, hit);
    return sendCover(hit);
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(subsonic.getCoverArtUrl(id, 512), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return res.status(502).end();
    const entry = {
      buf: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get('content-type') || 'image/jpeg',
    };
    coverCache.set(id, entry);
    if (coverCache.size > COVER_CACHE_MAX) {
      coverCache.delete(coverCache.keys().next().value!);
    }
    sendCover(entry);
  } catch {
    res.status(502).end();
  }
});

// ---------------------------------------------------------------------------
// GET /persona-avatar/:id — operator-uploaded DJ persona portrait. Returns a
// 1×1 transparent PNG (cached briefly) when no avatar is set, so listener UIs
// can use this URL directly without first checking whether one exists.
// ---------------------------------------------------------------------------
router.get('/persona-avatar/:id', async (req, res) => {
  const { id } = req.params;
  // Persona ids reuse settings.ID_RE — keep this regex local so a hand-edited
  // URL can never escape the persona-avatars directory.
  if (!/^[a-z0-9_]{3,32}$/.test(id)) return res.status(400).end();
  try {
    await settings.load();
    const persona = settings.get().personas?.find((p: any) => p.id === id);
    const filename: string = persona?.avatar || '';
    if (!filename) {
      // No avatar set yet (or unknown persona). Serve the transparent
      // placeholder with a short cache so the UI swaps once one's uploaded.
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.send(TRANSPARENT_PNG);
    }
    const path = `${settings.PERSONA_AVATAR_DIR}/${filename}`;
    const st = await stat(path);
    // ETag derived from filename + mtime so re-uploads invalidate cached
    // copies immediately (the filename can stay the same when the operator
    // replaces a PNG with another PNG).
    const etag = `"${createHash('sha1').update(`${filename}:${st.mtimeMs}`).digest('hex').slice(0, 16)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', mimeForAvatar(filename));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = await readFile(path);
    res.send(buf);
  } catch {
    // File missing or stat failed — fall back to the placeholder rather than
    // letting the listener UI see a broken-image icon.
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(TRANSPARENT_PNG);
  }
});

// ---------------------------------------------------------------------------
// GET /now-playing — current track + context snapshot
// ---------------------------------------------------------------------------
router.get('/now-playing', async (req, res) => {
  try {
    const [nowPlaying, ctx] = await Promise.all([
      queue.getNowPlaying(),
      getFullContext(),
    ]);
    // Enrich the live track with the analysis/tag data the player surfaces in
    // its minimal metadata strip (genre · BPM · key · mood). All of it lives
    // in the library DB keyed by subsonic_id; getNowPlaying() stays a pure
    // reader of now-playing.json. A not-yet-tagged track (or unloaded DB)
    // yields null here and the fields are simply omitted.
    if (nowPlaying?.subsonic_id) {
      // Lean read: only the scalar fields the metadata strip renders, so this
      // per-listener 5s poll never parses the heavy acoustic *_json blobs (#723).
      const rec = library.getPlaybackMeta(nowPlaying.subsonic_id);
      if (rec) {
        nowPlaying.genre = rec.genre ?? null;
        nowPlaying.bpm = rec.bpm ?? null;
        nowPlaying.musicalKey = rec.musicalKey ?? null;
        nowPlaying.moods = Array.isArray(rec.moods) ? rec.moods : [];
        nowPlaying.energy = rec.energy ?? null;
        if (nowPlaying.year == null && rec.year != null) nowPlaying.year = rec.year;
      }
      // Duration isn't in the annotate metadata Liquidsoap reports, so the
      // player's track clock / up-next tease would never fire without help.
      // The queue's record of the airing track carries the full Subsonic song
      // (requests + DJ picks); auto-playlist plays fall back to the library
      // DB's duration_sec. Tracks known to neither just omit it — the player
      // degrades to an elapsed-only readout, same as the metadata strip.
      if (nowPlaying.duration == null) {
        const cur = queue.current;
        const queueDuration =
          cur?.track?.id === nowPlaying.subsonic_id ? cur.track.duration : null;
        const duration = queueDuration ?? rec?.durationSec ?? null;
        if (typeof duration === 'number' && duration > 0) nowPlaying.duration = duration;
      }
    }
    // Served from the 15s listener-monitor cache — no per-request Icecast hit.
    const stream = getStreamStatus();
    const stationSettings = settings.get();
    const persona = settings.getEffectivePersona();
    // activeShow is { name, persona:{ id, name, avatar } } | null — the
    // persona block is reshaped here to include the public avatar URL so the
    // player UI doesn't need to know about the basename convention.
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
          // Guest co-hosts on the current show, same shape as persona. Empty
          // for a solo show, so existing clients see a harmless extra [].
          guests: (ctx.activeShow.guests || []).map((g: any) => ({
            id: g.id,
            name: g.name,
            avatar: avatarUrlFor(g.id),
          })),
        }
      : null;
    const s = session.getSession();
    res.json({
      nowPlaying,
      context: ctx,
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
      // Structured description of the live broadcast for hardware players and
      // tune-in helpers (the /listen.pls + /listen.m3u routes mirror this). The
      // flat streamOnline/streamBitrate above stay for the existing web player;
      // this `stream` object is additive. mount/format describe the always-
      // served MP3 floor; the *Enabled flags tell clients which optional mounts
      // (/stream.opus, /stream.flac, /stream.aac) are also live so they can
      // discover them without scraping the tune-in files.
      stream: {
        mount: '/stream.mp3',
        format: 'mp3',
        bitrate: stream.bitrate,
        sampleRate: stream.sampleRate,
        channels: stream.channels,
        opusEnabled: stationSettings.stream?.opusEnabled === true,
        flacEnabled: stationSettings.stream?.flacEnabled === true,
        aacEnabled: stationSettings.stream?.aacEnabled === true,
      },
      // Cumulative since-boot LLM token total — drives the listener-facing
      // token ticker next to the now-playing time. Aggregate integer only; no
      // model/cost breakdown (that stays on the admin-gated /stats surface).
      llmTokens: lifetimeTokenCount(),
      // The station's IANA zone. The DJ speaks the time in this zone (time.ts),
      // so on-air log timestamps in the UI must be rendered in it too — else an
      // operator/listener viewing from another zone sees stamps that disagree
      // with what the DJ just said (issue #418).
      timezone: getStationTimezone(),
      locale: stationSettings.locale,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /listen.pls and GET /listen.m3u — one-paste tune-in files for hardware
// and software players (Sonos, VLC, moOde, car receivers). A listener adds the
// station by pasting one URL instead of hunting for the raw /stream.mp3 mount.
//
// All wrap the always-served MP3 floor first (the universal entry every player
// can decode); the optional Opus / FLAC / AAC mounts are appended only when the
// operator has enabled each. Origin comes from publicOrigin() (SITE_URL when
// set, else the request host) so the link works from however the listener
// reached the site. Unauthenticated by design — these expose nothing beyond the
// already-public stream URL and station name.
// ---------------------------------------------------------------------------
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

router.get('/listen.pls', (req, res) => {
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
  const { entries } = listenMounts(req);
  const lines = ['#EXTM3U'];
  for (const e of entries) lines.push(`#EXTINF:-1,${e.title}`, e.url);
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="listen.m3u"');
  res.send(lines.join('\n') + '\n');
});

// ---------------------------------------------------------------------------
// GET /dj — public-safe DJ + station info for the landing page.
// Exposes only fields the DJ already says on-air; no secrets.
// ---------------------------------------------------------------------------
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
      avatar: avatarUrlFor(persona?.id),
      station: s.station,
      location: s.weather?.locationName || '',
      locale: s.locale,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /schedule — listener-facing week view. Returns the show definitions,
// the 7×24 grid, and a lightweight persona index ({ id, name, avatar }) so
// the player can paint host names + avatars without a separate lookup. No
// souls, no TTS config, no admin-only fields — anything the DJ already says
// on air or signals via on-air persona identity.
// ---------------------------------------------------------------------------
router.get('/schedule', async (req, res) => {
  try {
    await settings.load();
    const s = settings.get();
    const personas = (s.personas || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      avatar: avatarUrlFor(p.id),
    }));
    const shows = (s.shows || []).map((show: any) => ({
      id: show.id,
      name: show.name,
      topic: show.topic,
      // Multi-value moods (#929). `mood` stays as the lead entry for older
      // clients (the native app reads this endpoint) — derived, never stored.
      moods: Array.isArray(show.moods) ? show.moods : [],
      mood: Array.isArray(show.moods) && show.moods.length ? show.moods[0] : '',
      personaId: show.personaId,
    }));
    res.json({
      personas,
      shows,
      schedule: s.schedule,
      // The grid is interpreted in the station's timezone (settings.timezone,
      // falling back to the container TZ) — the browser's local DOW/hour may
      // not match, so pass back the zone the schedule is painted in. The UI
      // can show a small "Times shown in station local time" hint where
      // needed.
      timezone: getStationTimezone(),
      locale: s.locale,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /state — queue + history + DJ log
// ---------------------------------------------------------------------------
router.get('/state', (req, res) => {
  const snap = queue.snapshot();
  // `theme.active` rides along with /state — gives polling clients a cheap
  // heads-up that the effective theme has changed without re-fetching the
  // full token map from /themes. Per-show theme overrides win over the
  // station-wide default while a show is on air.
  const s = settings.get();
  const activeShow = settings.resolveActiveShow();
  const activeThemeId =
    (activeShow?.themeId && activeShow.themeId) || s?.theme?.active || DEFAULT_THEME_ID;
  res.json({
    ...snap,
    needsSetup: getSetupStatusSync().needsSetup,
    theme: { active: activeThemeId },
    // Listener-player UI toggles ride along with /state like the theme does, so
    // the player can flip them live on the next poll. Defaults off if unset.
    ui: { boothBuddy: s?.ui?.boothBuddy ?? false },
    // Station zone for rendering djLog timestamps in station-local time (#418).
    timezone: getStationTimezone(),
    locale: s.locale,
  });
});

// ---------------------------------------------------------------------------
// GET /themes — public theme registry. Returns the active theme id plus the
// full list of built-in and user themes (token maps included). Listener web
// shells fetch this once on mount and again whenever /state reports a new
// active id; the result is cached in browser localStorage for pre-paint apply
// on the next visit.
//
// `active` reflects the *effective* theme: the on-air show's themeId override
// if it's set and still resolves to a known theme, otherwise the station
// default. ThemeBootstrap doesn't have to know about shows — it just applies
// whatever id comes back.
//
// POST /themes/refresh — admin-gated. Clears the user-themes cache so files
// freshly dropped into ${STATE_DIR}/themes/ appear in the next /themes read
// without bouncing the controller.
// ---------------------------------------------------------------------------
router.get('/themes', async (req, res) => {
  try {
    const s = settings.get();
    const themes = await listThemesAnnotated();
    const stationDefault = s?.theme?.active || DEFAULT_THEME_ID;
    const activeShow = settings.resolveActiveShow();
    // Show override wins only if it still resolves to a known theme. A stale
    // override (operator deleted the file under our feet) silently falls back
    // to the station default — same fallback strategy as getTheme().
    const active =
      activeShow?.themeId && themes.some(t => t.id === activeShow.themeId)
        ? activeShow.themeId
        : stationDefault;
    res.json({ active, themes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /session — the live DJ session's chat history, for the player Booth feed.
// Returns the session header plus a bounded tail of its `messages` turns
// ({ t, role, kind, text, meta }). Public-safe: the turns only carry what the
// DJ already says or does on-air. Returns nulls when no session is live.
// `sfx` turns are dropped here — a sound-effect clip is an internal DJ-agent
// action, not something said on-air, so it shouldn't surface in the listener
// Booth feed. It stays in the session history for the agent's own context.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// GET /skills/community — the shipped community skill catalog (prompt-only DJ
// segments contributed via the community-submission flow, COPYd into the
// image). Browse-only public reference: the same catalog the admin Skills →
// Community modal installs from, minus the per-station `installed`/`reserved`
// annotations (those are meaningful only inside a specific station's admin).
// Powers the public /skills showcase page. Never throws — an empty catalog
// (no community/ dir shipped) returns []. No admin gate: it's static shipped
// data, identical across every install of the same version.
// ---------------------------------------------------------------------------
router.get('/skills/community', async (req, res) => {
  try {
    const community = await listCommunitySkills();
    res.json({ community });
  } catch (err) {
    queue.log('error', `/skills/community failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /personas/community — the shipped community persona catalog (DJ personas
// contributed via the community-submission flow, COPYd into the image). Same
// posture as /skills/community: browse-only public reference powering the
// public /personas showcase AND the admin Personas → Community modal (which
// computes per-station "installed" client-side from the roster it already
// holds). Never throws — an empty catalog returns []. No admin gate: static
// shipped data, identical across every install of the same version.
// ---------------------------------------------------------------------------
router.get('/personas/community', async (req, res) => {
  try {
    const community = await listCommunityPersonas();
    res.json({ community });
  } catch (err) {
    queue.log('error', `/personas/community failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /geocode?q= — place-name lookup for the admin/onboarding location picker.
// Thin proxy over Open-Meteo's free, keyless geocoding API (the web layer never
// calls external hosts directly — the controller owns all external IO). Returns
// { results: [...] } with coordinates + IANA timezone so the picker can fill
// lat/lng/name and set the station clock in one tap. Unauthenticated: onboarding
// runs pre-auth and this is harmless public reference data. On upstream failure
// returns 502 so the client can fall back to manual coordinate entry.
// ---------------------------------------------------------------------------
router.get('/geocode', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    const results = await geocodePlace(q);
    res.json({ results });
  } catch {
    res.status(502).json({ error: 'geocode_unavailable' });
  }
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
router.get('/health', (req, res) => res.json({ status: 'on-air' }));
