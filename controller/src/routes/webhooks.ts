// Admin-gated webhook management. CRUD lives here; the fan-out itself lives
// in broadcast/webhooks.ts and reads its config from settings on each fire.
//
// Event payloads emitted by the fan-out:
//   track.play       { event, t, title, artist, album?, source, requestedBy? }
//   dj.say           { event, t, text, kind }      // kind is the original `announce` kind
//   dj.link          { event, t, text }
//   request.received { event, t, requestedBy, text }   // text is the listener's raw ask
//
// All payloads carry `event` (one of the above) and `t` (ISO timestamp).
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import * as settings from '../settings.js';
import { WEBHOOK_EVENTS, fireTest } from '../broadcast/webhooks.js';

export const router = express.Router();

router.get('/webhooks', requireAdmin, async (req, res) => {
  try {
    await settings.load();
    const s = settings.getRedacted();
    res.json({ events: WEBHOOK_EVENTS, webhooks: s.webhooks || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/webhooks', requireAdmin, async (req, res) => {
  // The UI sends the whole list back. settings.update() validates the array
  // strictly and replaces it atomically — same pattern as personas/shows.
  try {
    const r = await settings.update({ webhooks: req.body?.webhooks });
    res.json({ webhooks: settings.getRedacted().webhooks, requiresRestart: r.requiresRestart });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Send a test payload to a single hook by id. Uses the live, non-redacted
// settings so the operator's saved authHeader actually goes out — they
// shouldn't have to retype it just to test the integration.
router.post('/webhooks/:id/test', requireAdmin, async (req, res) => {
  try {
    await settings.load();
    const hook = (settings.get().webhooks || []).find((h: any) => h.id === req.params.id);
    if (!hook) return res.status(404).json({ error: 'webhook not found' });
    await fireTest(hook);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
