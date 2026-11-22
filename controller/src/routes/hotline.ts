// The Hotline's HTTP surface (docs/plans/hotline.md).
//
// Listener side, behind the station-password gate (open on a public station,
// fails closed on a private one):
//   GET  /hotline                   closed | open | busy
//   POST /hotline/calls             ring: admits, mints a provider session
//   POST /hotline/calls/:id/tool    one relayed tool call (x-hotline-token)
//   POST /hotline/calls/:id/end     hang up (x-hotline-token)
//
// Operator side, behind requireAdmin:
//   GET    /hotline/admin           the line, today's minutes, bans, recent Calls
//   POST   /hotline/admin/end       end the Call on the line
//   POST   /hotline/admin/bans      ban the device of a recent Call
//   DELETE /hotline/admin/bans/:id  lift a ban
import express from 'express';
import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import { getFullContext } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { requireStationAuth } from '../middleware/station-auth.js';
import { clientIp } from '../middleware/ratelimit.js';
import { validateBody, validatePublicBody } from '../middleware/validate.js';
import { excludesExplicit } from '../music/explicit-policy.js';
import { resolvePersonaVoiceSlot } from '../schemas/persona.js';
import { hotlineBanSchema, hotlineCallStartSchema, hotlineToolCallSchema } from '../schemas/hotline.js';
import { reservedRequesterNames } from '../broadcast/listener-request.js';
import { cleanRequesterName } from '../util/request-guard.js';
import * as line from '../hotline/line.js';
import * as ledger from '../hotline/ledger.js';
import { realtimeVoiceFor, secondsLeftToday, type HotlineCallRefusal } from '../hotline/policy.js';
import { mintCallSession, PROVIDER_LABELS, providerReady } from '../hotline/provider.js';
import { buildCallInstructions, WRAP_UP_CUE } from '../hotline/prompt.js';
import { callToolDefs, runCallTool } from '../hotline/tools.js';

export const router = express.Router();

// The listener's copy for each refusal to connect. The status code says which
// kind: 503 closed, 409 busy, 403 refused to this device, 429 limit reached.
const REFUSALS: Record<HotlineCallRefusal, { status: number; message: string }> = {
  provider: { status: 503, message: "The Hotline isn't set up on this station." },
  requests: { status: 503, message: 'The Hotline is closed while requests are off.' },
  show: { status: 503, message: "The Hotline isn't open during this show." },
  minutes: { status: 503, message: "The Hotline's closed for today — try again tomorrow." },
  'too-short': { status: 503, message: "The Hotline's closed for today — try again tomorrow." },
  busy: { status: 409, message: "The line's busy — someone's on with the DJ. Try again in a few minutes." },
  banned: { status: 403, message: "The Hotline isn't taking calls from this device." },
  'device-limit': { status: 429, message: "You've already called during this show — catch the DJ next show." },
};

function tokenOf(req: express.Request): unknown {
  return req.headers['x-hotline-token'];
}

router.get('/hotline', requireStationAuth, (_req, res) => {
  const s = settings.get() as any;
  const { state } = line.status();
  res.json({ state, provider: PROVIDER_LABELS[s.hotline?.provider] || null });
});

router.post('/hotline/calls', requireStationAuth, validatePublicBody(hotlineCallStartSchema), async (req, res) => {
  const { deviceId, name: rawName } = req.body as { deviceId: string; name: string };
  const ip = clientIp(req);
  const name = cleanRequesterName(rawName, reservedRequesterNames());
  const started = line.startCall({ deviceId, ip, name });
  if (!started.ok) {
    const r = REFUSALS[started.reason];
    return res.status(r.status).json({ success: false, reason: started.reason, message: r.message });
  }
  const call = started.call;
  try {
    const s = settings.get() as any;
    let context: any = {};
    try { context = await getFullContext(); } catch { context = {}; }
    const slot = resolvePersonaVoiceSlot(call.persona?.tts, s.tts);
    const voice = realtimeVoiceFor({
      configured: s.hotline?.voice || '',
      personaProvider: slot?.engine === 'cloud' ? slot.cloudProvider : null,
      personaVoice: slot?.engine === 'cloud' ? slot.voice : null,
    });
    const instructions = buildCallInstructions({
      persona: call.persona,
      context,
      show: settings.resolveActiveShow(),
      callerName: name,
      recentTracks: queue.getRecentTracks(),
      capSec: call.capSec,
      cleanShow: excludesExplicit(settings.resolvePickShow()),
    });
    const session = await mintCallSession({
      provider: 'openai',
      model: s.hotline?.model || 'gpt-realtime',
      voice,
      instructions,
      tools: callToolDefs(call),
    });
    line.confirmCall(call);
    res.status(201).json({
      success: true,
      callId: call.id,
      callToken: call.token,
      provider: session.provider,
      providerLabel: PROVIDER_LABELS[session.provider],
      model: session.model,
      clientSecret: session.clientSecret,
      sdpUrl: session.sdpUrl,
      capSec: call.capSec,
      wrapUpAtSec: call.wrapUpAtSec,
      wrapUpCue: WRAP_UP_CUE,
      dj: call.persona?.name || null,
      station: s.station || 'SUB/WAVE',
    });
  } catch (err) {
    line.abandonCall(call.id);
    queue.log('error', `Hotline could not connect a call: ${(err as Error).message}`);
    res.status(502).json({ success: false, reason: 'provider-error', message: "The DJ can't pick up right now — try again in a bit." });
  }
});

router.post('/hotline/calls/:id/tool', validatePublicBody(hotlineToolCallSchema), async (req, res) => {
  const call = line.callFor(String(req.params.id), tokenOf(req));
  if (!call) return res.status(410).json({ ended: true, error: 'this call has ended' });
  const { name, arguments: args } = req.body as { name: string; arguments?: unknown };
  const output = await runCallTool(call, name, args);
  res.json({ output });
});

router.post('/hotline/calls/:id/end', (req, res) => {
  const call = line.callFor(String(req.params.id), tokenOf(req));
  if (call) line.endCall(call.id, 'caller');
  res.json({ ok: true });
});

// --- operator ---------------------------------------------------------------

router.get('/hotline/admin', requireAdmin, (_req, res) => {
  const s = settings.get() as any;
  const call = line.activeCall();
  const used = ledger.secondsUsedToday();
  const dailyMinutes = Number(s.hotline?.dailyMinutes) || 60;
  res.json({
    ...line.status(),
    providerReady: providerReady(s.hotline?.provider || 'openai'),
    provider: s.hotline?.provider || 'openai',
    call: call ? {
      id: call.id,
      name: call.name,
      showName: call.showName,
      startedAt: new Date(call.startedAt).toISOString(),
      elapsedSec: Math.floor((Date.now() - call.startedAt) / 1000),
      capSec: call.capSec,
      granted: call.grant ? { title: call.grant.title, artist: call.grant.artist } : null,
      declined: !!call.declined,
    } : null,
    today: {
      day: ledger.stationDay(),
      secondsUsed: used,
      dailyMinutes,
      secondsLeft: secondsLeftToday({ secondsUsedToday: used, dailyMinutes }),
    },
    bans: ledger.bans(),
    recent: ledger.recentCalls(),
  });
});

router.post('/hotline/admin/end', requireAdmin, (_req, res) => {
  const call = line.activeCall();
  if (!call) return res.status(404).json({ error: 'no call on the line' });
  line.endCall(call.id, 'operator');
  res.json({ ok: true });
});

router.post('/hotline/admin/bans', requireAdmin, validateBody(hotlineBanSchema), (req, res) => {
  const { callId } = req.body as { callId: string };
  const ban = ledger.addBanFromCall(callId);
  if (!ban) return res.status(404).json({ error: 'no recent call with that id' });
  // A ban on the Caller on the line ends their Call too.
  const call = line.activeCall();
  if (call && (call.deviceId === ban.deviceId || call.ip === ban.ip)) line.endCall(call.id, 'operator');
  queue.log('hotline', `Hotline ban added for ${ban.name ? `"${ban.name}"` : 'a caller'}`);
  res.json({ ok: true, ban });
});

router.delete('/hotline/admin/bans/:id', requireAdmin, (req, res) => {
  if (!ledger.removeBan(String(req.params.id))) return res.status(404).json({ error: 'no ban with that id' });
  res.json({ ok: true });
});
