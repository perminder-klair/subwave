// Station actions rather than settings reads/writes: the mixer, the stream, the
// theme registry, the SearXNG probe.
// Part of the settings/ route split - see ../settings.ts.

import express from 'express';
import { queue } from '../../broadcast/queue.js';
import { restartLiquidsoap, startStream, stopStream } from '../../broadcast/liquidsoap-control.js';
import { requireAdmin } from '../../middleware/auth.js';
import {
  clearUserThemeCache,
  loadUserThemes,
  listThemesAnnotated,
  saveUserTheme,
  deleteUserTheme,
} from '../../themes.js';
import { fetchWithTimeout } from '../../util/fetch-timeout.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// Brief gap of dead air, covered by the Icecast burst buffer + emergency.mp3.
router.post('/restart-mixer', requireAdmin, async (req, res) => {
  try {
    await restartLiquidsoap();
    queue.log('scheduler', 'mixer restart requested');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stops the Icecast output only; the mixer process keeps running.
router.post('/stream-stop', requireAdmin, async (req, res) => {
  try {
    await stopStream();
    queue.log('scheduler', 'stream stopped — off air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stream-start', requireAdmin, async (req, res) => {
  try {
    await startStream();
    queue.log('scheduler', 'stream started — on air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auto-pick', requireAdmin, express.json(), (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoPick = req.body.on;
  queue.log('scheduler', `auto-pick ${queue.autoPick ? 'enabled' : 'disabled'}`);
  res.json({ autoPick: queue.autoPick });
});

// Re-scans ${STATE_DIR}/themes/ so a hand-dropped JSON is picked up without a
// controller bounce.
router.post('/themes/refresh', requireAdmin, async (req, res) => {
  try {
    clearUserThemeCache();
    await loadUserThemes(true);
    const themes = await listThemesAnnotated();
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Writes ${STATE_DIR}/themes/<id>.json; the id is derived from the name when
// absent. Built-in ids are reserved and rejected.
router.post('/themes', requireAdmin, async (req, res) => {
  try {
    const themes = await saveUserTheme(req.body || {});
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Only removes the file; the admin UI reassigns the active theme if it was in use.
router.delete('/themes/:id', requireAdmin, async (req, res) => {
  try {
    const themes = await deleteUserTheme(req.params.id);
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Probes a SearXNG instance; persists nothing. Intentionally permits RFC-1918
// targets, since SearXNG is typically on the homelab LAN.
router.post('/settings/search/test-searxng', requireAdmin, async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl || '').trim();
    if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl required' });
    if (!/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ ok: false, error: 'baseUrl must start with http:// or https://' });
    }

    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', 'subwave connectivity probe');
    url.searchParams.set('format', 'json');

    const r = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'SUB-WAVE radio controller (probe)' },
      timeoutMs: 8000,
    });

    if (!r.ok) return res.json({ ok: false, error: `HTTP ${r.status}` });
    const data = (await r.json()) as { results?: unknown };
    const count = Array.isArray(data?.results) ? (data.results as unknown[]).length : 0;
    return res.json({ ok: true, results: count });
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string } | null | undefined;
    const msg = e?.name === 'AbortError' ? 'request timed out after 8s' : e?.message || 'fetch failed';
    return res.json({ ok: false, error: msg });
  }
});

