// Webhook payloads and policy live in broadcast/webhooks.ts; see docs/internals/broadcast.md.
// Voice timestamps are live-edge (#1382); listener time adds streamBufferSeconds.
// airedAt marks the first word. Estimated events omit measured timestamps, and
// voice.queued remains an uncorrected forecast. Pair queue/start/end by voiceId.
import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import * as settings from '../settings.js';
import { WEBHOOK_EVENTS, fireTest } from '../broadcast/webhooks.js';
import { webhooksPatchSchema } from '../schemas/webhook.js';

export const router = express.Router();

router.get('/webhooks', requireAdmin, async (req, res) => {
  try {
    await settings.load();
    const s = settings.getRedacted();
    const policy = settings.get().webhooksPolicy || {};
    res.json({
      events: WEBHOOK_EVENTS,
      webhooks: s.webhooks || [],
      trackPlayListenerGated: !!policy.trackPlayListenerGated,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/webhooks', requireAdmin, validateBody(webhooksPatchSchema), async (req, res) => {
  // The UI sends the whole list back; update() replaces it atomically. Both
  // fields are optional so either can be saved without re-validating the other.
  try {
    const patch: Record<string, unknown> = {};
    if (req.body?.webhooks !== undefined) {
      patch.webhooks = req.body.webhooks;
    }
    if (req.body?.trackPlayListenerGated !== undefined) {
      patch.webhooksPolicy = { trackPlayListenerGated: !!req.body.trackPlayListenerGated };
    }
    const r = await settings.update(patch);
    const policy = settings.get().webhooksPolicy || {};
    res.json({
      webhooks: settings.getRedacted().webhooks,
      trackPlayListenerGated: !!policy.trackPlayListenerGated,
      requiresRestart: r.requiresRestart,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Uses live, non-redacted settings so the saved authHeader actually goes out.
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
