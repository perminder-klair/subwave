// Public, unauthenticated endpoints: liveness, now-playing, station/DJ info,
// queue state, and the cover-art proxy.
import express from 'express';
import * as subsonic from '../music/subsonic.js';
import * as settings from '../settings.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

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
    const [nowPlaying, ctx, listeners] = await Promise.all([
      queue.getNowPlaying(),
      getFullContext(),
      getListenerStats(),
    ]);
    const persona = settings.getEffectivePersona();
    // activeShow is { name, persona:{ name } } | null — surfaced to listeners.
    const activeShow = ctx.activeShow
      ? { name: ctx.activeShow.name, persona: ctx.activeShow.persona }
      : null;
    res.json({
      nowPlaying,
      context: ctx,
      dj: { name: persona?.name || 'Frequency', tagline: persona?.tagline || '' },
      activeShow,
      listeners,
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
router.get('/state', (req, res) => {
  res.json(queue.snapshot());
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
router.get('/health', (req, res) => res.json({ status: 'on-air' }));
