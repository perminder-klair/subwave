// Sub-station channel API — mounted at /channels/:channelId (Caddy rewrites
// the public /ch/<id>/api/* there), giving every channel a self-contained
// station surface at its own base URL. The channel-specific endpoints below
// shadow their station-wide counterparts; everything else (cover art, persona
// avatars, themes, schedule, geocode, community catalogs) falls through to
// the shared public router, so a channel base URL speaks the same API a
// station does — which is exactly what lets the native app add a channel as
// a "station" with zero app changes.
import express from 'express';
import * as settings from '../settings.js';
import * as stationContext from '../broadcast/station-context.js';
import type { StationContext } from '../broadcast/station-context.js';
import { channelListeners, channelMountOnline } from '../broadcast/listeners.js';
import { restartLiquidsoap } from '../broadcast/liquidsoap-control.js';
import { requireAdmin } from '../middleware/auth.js';
import { getStationTimezone } from '../time.js';
import { DEFAULT_THEME_ID } from '../themes.js';
import { lifetimeTokenCount } from '../llm/log.js';
import { router as publicRoutes, publicOrigin, avatarUrlFor, enrichNowPlaying } from './public.js';
import { handleRequestPost, handleRequestStatus } from './request.js';

export const router = express.Router();
const channel = express.Router({ mergeParams: true });

// Everything below runs with the resolved context on res.locals. Unknown or
// disabled channels 404 — the id namespace is small and operator-controlled.
channel.use((req, res, next) => {
  const id = String((req.params as { channelId?: string }).channelId || '');
  const ctx = stationContext.get(id);
  if (!ctx) return res.status(404).json({ error: `unknown channel "${id}"` });
  res.locals.channelCtx = ctx;
  next();
});

const ctxOf = (res: express.Response): StationContext => res.locals.channelCtx;

channel.get('/health', (req, res) => res.json({ status: 'on-air' }));

// GET /now-playing — the channel counterpart of the station route: same
// response shape (the web/native players consume it as-is), sourced from the
// channel's queue/session/persona, with listener figures from the channel's
// own Icecast mount.
channel.get('/now-playing', async (req, res) => {
  const ctx = ctxOf(res);
  try {
    const [nowPlaying, c] = await Promise.all([
      ctx.queue.getNowPlaying(),
      ctx.queue.stationContext(),
    ]);
    enrichNowPlaying(nowPlaying, ctx.queue);
    const persona = ctx.queue.personaFor();
    const show = c.activeShow;
    const activeShow = show
      ? {
          name: show.name,
          persona: show.persona
            ? { id: show.persona.id, name: show.persona.name, avatar: avatarUrlFor(show.persona.id) }
            : null,
          guests: (show.guests || []).map((g: { id: string; name: string }) => ({
            id: g.id, name: g.name, avatar: avatarUrlFor(g.id),
          })),
        }
      : null;
    const s = ctx.session.getSession();
    const st = settings.get();
    const current = channelListeners(ctx.channel.id);
    const online = channelMountOnline(ctx.channel.id);
    res.json({
      nowPlaying,
      context: c,
      dj: {
        name: persona?.name || 'Frequency',
        tagline: persona?.tagline || '',
        avatar: avatarUrlFor(persona?.id),
        station: ctx.channel.name,
      },
      activeShow,
      session: s ? { id: s.id, kind: s.kind, startedAt: s.startedAt, show: s.show?.name || null } : null,
      listeners: { current: current ?? 0, peak: current ?? 0 },
      // Unknown (stats outage) reads as online — same fail-open posture as the
      // main station's transient-failure handling (issue #461).
      streamOnline: online !== false,
      streamBitrate: st.stream?.bitrate ?? null,
      stream: {
        mount: `/ch/${ctx.channel.id}/stream.mp3`,
        format: 'mp3',
        bitrate: st.stream?.bitrate ?? null,
        sampleRate: null,
        channels: null,
        opusEnabled: false,
        flacEnabled: false,
        aacEnabled: false,
      },
      llmTokens: lifetimeTokenCount(),
      timezone: getStationTimezone(),
      locale: st.locale,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /state — channel queue snapshot + the presentation fields the player
// applies live. Channel theme: the pinned show's themeId when set, else the
// station default. needsSetup is always false — onboarding is install-level.
channel.get('/state', (req, res) => {
  const ctx = ctxOf(res);
  const s = settings.get();
  const show = ctx.queue.activeShowFor();
  const activeThemeId = (show?.themeId && show.themeId) || s?.theme?.active || DEFAULT_THEME_ID;
  res.json({
    ...ctx.queue.snapshot(),
    needsSetup: false,
    streamIdle: false,
    channel: { id: ctx.channel.id, name: ctx.channel.name },
    channels: settings.enabledChannels(s).map(c => ({ id: c.id, name: c.name })),
    theme: { active: activeThemeId },
    ui: {
      boothBuddy: s?.ui?.boothBuddy ?? false,
      skin: s?.ui?.skin || 'classic',
      tuneInOverlay: s?.ui?.tuneInOverlay ?? true,
    },
    timezone: getStationTimezone(),
    locale: s.locale,
  });
});

// GET /session — the channel DJ's live chat history for the Booth feed.
channel.get('/session', (req, res) => {
  const s = ctxOf(res).session.getSession();
  if (!s) return res.json({ session: null, messages: [] });
  res.json({
    session: { id: s.id, kind: s.kind, key: s.key, startedAt: s.startedAt, show: s.show?.name || null },
    messages: s.messages.filter(m => m.kind !== 'sfx').slice(-120),
  });
});

// GET /dj — public-safe channel DJ + identity info.
channel.get('/dj', (req, res) => {
  const ctx = ctxOf(res);
  const s = settings.get();
  const persona = ctx.queue.personaFor();
  res.json({
    name: persona?.name || 'Frequency',
    tagline: persona?.tagline || '',
    soul: persona?.soul || '',
    frequency: ctx.channel.frequency || 'quiet',
    djMode: persona?.djMode === true,
    avatar: avatarUrlFor(persona?.id),
    station: ctx.channel.name,
    location: s.weather?.locationName || '',
    locale: s.locale,
  });
});

// Listener requests — same pipeline as the main station, resolved through the
// channel's queue/session so the ack, the intro, and the queued track all land
// on this channel's stream.
channel.post('/request', (req, res) => handleRequestPost(req, res, ctxOf(res).queue));
channel.get('/request/:id', handleRequestStatus);

// One-paste tune-in files, channel edition (MP3 mount only — channels don't
// serve the optional encoders).
channel.get('/listen.m3u', (req, res) => {
  const ctx = ctxOf(res);
  const url = `${publicOrigin(req)}/ch/${ctx.channel.id}/stream.mp3`;
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="listen.m3u"');
  res.send(`#EXTM3U\n#EXTINF:-1,${ctx.channel.name}\n${url}\n`);
});

channel.get('/listen.pls', (req, res) => {
  const ctx = ctxOf(res);
  const url = `${publicOrigin(req)}/ch/${ctx.channel.id}/stream.mp3`;
  res.setHeader('Content-Type', 'audio/x-scpls; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="listen.pls"');
  res.send(`[playlist]\nNumberOfEntries=1\nFile1=${url}\nTitle1=${ctx.channel.name}\nLength1=-1\nVersion=2\n`);
});

// POST /restart-mixer — bounce this channel's own liquidsoap (the supervisor
// respawns it within its reconcile window). Admin-gated like the main one.
channel.post('/restart-mixer', requireAdmin, async (req, res) => {
  const ctx = ctxOf(res);
  try {
    await restartLiquidsoap(ctx.channel.telnetPort);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Everything else a station base URL serves — cover art, persona avatars,
// themes, schedule, geocode, community catalogs — falls through unchanged.
// The channel-specific routes above are registered first, so they win.
channel.use(publicRoutes);

router.use('/channels/:channelId', channel);
