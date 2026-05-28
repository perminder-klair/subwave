// Public, unauthenticated endpoints: liveness, now-playing, station/DJ info,
// queue state, the cover-art proxy, the persona-avatar proxy, and the
// listener-facing weekly schedule.
import express from 'express';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import * as settings from '../settings.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { getSetupStatusSync } from '../setup/firstRun.js';

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

// Icecast stream status + listener count — used by /now-playing. Cheap local
// fetch with a hard 1.5s timeout so a slow Icecast can never wedge the
// every-5s poll the UI does. `online` is false when neither broadcast mount
// (/stream.mp3, /stream.opus) has a source attached (admin took the station
// off air, or Liquidsoap is down) or when Icecast itself is unreachable.
// Listener count and peak sum both mounts so the UI shows total reach
// regardless of which codec each listener picked. Returns offline + 0/0 on
// any failure.
async function getStreamStatus() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(config.icecast.statusUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    const ic = ((await r.json()) as any)?.icestats;
    const sources = Array.isArray(ic?.source) ? ic.source : ic?.source ? [ic.source] : [];
    const broadcastMounts = ['/stream.mp3', '/stream.opus'];
    const broadcastSources = sources.filter((s: any) =>
      broadcastMounts.some(m => String(s?.listenurl || '').includes(m))
    );
    const current = broadcastSources.reduce((sum: number, s: any) => sum + Number(s.listeners || 0), 0);
    const peak    = broadcastSources.reduce((sum: number, s: any) => sum + Number(s.listener_peak || 0), 0);
    return {
      online: broadcastSources.length > 0,
      listeners: { current, peak },
    };
  } catch {
    return { online: false, listeners: { current: 0, peak: 0 } };
  }
}

// ---------------------------------------------------------------------------
// GET /cover/:id — proxy Subsonic cover art so listener browsers can use it
// as MediaSession artwork (lock screen / CarPlay / Bluetooth display) without
// the Subsonic credentials leaking into the page. Cached aggressively at the
// edge — cover art for a given song id never changes meaningfully.
// ---------------------------------------------------------------------------
router.get('/cover/:id', async (req, res) => {
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
    const [nowPlaying, ctx, stream] = await Promise.all([
      queue.getNowPlaying(),
      getFullContext(),
      getStreamStatus(),
    ]);
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
      },
      activeShow,
      session: s ? { id: s.id, kind: s.kind, startedAt: s.startedAt, show: s.show?.name || null } : null,
      listeners: stream.listeners,
      streamOnline: stream.online,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
      avatar: avatarUrlFor(persona?.id),
      station: s.station,
      location: s.weather?.locationName || '',
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
      mood: show.mood,
      personaId: show.personaId,
    }));
    res.json({
      personas,
      shows,
      schedule: s.schedule,
      // The grid is interpreted in the controller's local timezone — the
      // browser's local DOW/hour may not match, so pass back the offset the
      // schedule was painted in. The UI can show a small "Times shown in
      // station local time" hint where needed.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
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
  // `needsSetup` is what the landing page and admin shell key off to redirect
  // a fresh operator into the wizard. Sync read — relies on the boot-time
  // config overlay being already applied (or falls back to env-only check).
  res.json({ ...snap, needsSetup: getSetupStatusSync().needsSetup });
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
// GET /health
// ---------------------------------------------------------------------------
router.get('/health', (req, res) => res.json({ status: 'on-air' }));
