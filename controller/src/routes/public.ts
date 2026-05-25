// Public, unauthenticated endpoints: liveness, now-playing, station/DJ info,
// queue state, and the cover-art proxy.
import express from 'express';
import { config } from '../config.js';
import * as subsonic from '../music/subsonic.js';
import * as settings from '../settings.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import { getSetupStatusSync } from '../setup/firstRun.js';

export const router = express.Router();

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
    // activeShow is { name, persona:{ name } } | null — surfaced to listeners.
    const activeShow = ctx.activeShow
      ? { name: ctx.activeShow.name, persona: ctx.activeShow.persona }
      : null;
    const s = session.getSession();
    res.json({
      nowPlaying,
      context: ctx,
      dj: { name: persona?.name || 'Frequency', tagline: persona?.tagline || '' },
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
      station: s.station,
      location: s.weather?.locationName || '',
    });
  } catch (err) {
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
