// Admin-gated webhook CRUD. The fan-out lives in broadcast/webhooks.ts and reads
// its config from settings on each fire.
//
// Payloads (all carry `event` and `t`, an ISO timestamp):
//   track.play       { title, artist, album?, sourceTrackId?, source, requestedBy?,
//                      listeners? }  sourceTrackId is the music backend's id (null
//                      when unknown); source is auto | ai | request. With
//                      webhooksPolicy.trackPlayListenerGated on it POSTs only when
//                      the listener count is known to be > 0 (fail-closed).
//   dj.say / dj.link { text, kind, voiceId, channel, durationMs, airedAt?, estimated }
//   request.received { requestedBy, text }   // text is the listener's raw ask
//   voice.queued     { voiceId, kind, channel, text, durationMs, estimatedAirInMs,
//                      expectedAirAt, estimated (always true), streamBufferSeconds,
//                      personaId?, personaName? }
//   voice.start      { …, airedAt?, endsAt?, estimated, streamBufferSeconds, persona… }
//   voice.end        { …, airedAt?, endedAt?, estimated }
//
// Timebase (#1382): voice events fire at the LIVE EDGE. Listeners sit
// streamBufferSeconds behind it, so a consumer syncing to what people hear wants
// `airedAt + streamBufferSeconds`; an operator display wants `airedAt` as-is.
// [airedAt, airedAt + durationMs] is the speech window, and `airedAt` is the first
// WORD — the duck starts ~0.8s earlier, behind the mixer's silent lead-in.
// `estimated: true` means the air time could not be measured: airedAt/endsAt/endedAt
// are then ABSENT, never zeroed. voice.queued is a forecast by nature (hence always
// estimated, and no airedAt); it fires when the station commits to a clip so a
// consumer can prepare, is never corrected afterwards, and its lead time varies from
// ~1s to many seconds. voice.queued → voice.start → voice.end pair by `voiceId`.
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
