// The Hotline (docs/plans/hotline.md): its pure policy, and a Grant going
// through the one listener-request chokepoint.
//
// Run: npm test -- hotline

import assert from 'node:assert/strict';
import test from 'node:test';
import { queue } from '../src/broadcast/queue.js';
import * as settings from '../src/settings.js';
import {
  admitCall, billableSeconds, callTimings, isBanned, lineStatus, realtimeVoiceFor, showAiringKey,
} from '../src/hotline/policy.js';
import { buildCallInstructions } from '../src/hotline/prompt.js';
import * as line from '../src/hotline/line.js';
import { runCallTool } from '../src/hotline/tools.js';
import { requests } from '../src/broadcast/listener-request.js';

(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

const open = {
  showOpens: true, providerReady: true, requestsOn: true,
  secondsUsedToday: 0, dailyMinutes: 60, callActive: false,
};

test('the line reports why it is closed, provider first', () => {
  assert.deepEqual(lineStatus({ ...open, providerReady: false, showOpens: false }), { state: 'closed', reason: 'provider' });
  assert.deepEqual(lineStatus({ ...open, requestsOn: false }), { state: 'closed', reason: 'requests' });
  assert.deepEqual(lineStatus({ ...open, showOpens: false }), { state: 'closed', reason: 'show' });
  assert.deepEqual(lineStatus({ ...open, secondsUsedToday: 3600 }), { state: 'closed', reason: 'minutes' });
  assert.deepEqual(lineStatus({ ...open, callActive: true }), { state: 'busy', reason: null });
  assert.deepEqual(lineStatus(open), { state: 'open', reason: null });
});

test('a call is admitted once per device per show, and a ban outranks busy', () => {
  const base = { ...open, banned: false, deviceCallsThisShow: 0, callsPerDevicePerShow: 1 };
  assert.deepEqual(admitCall(base), { ok: true });
  assert.deepEqual(admitCall({ ...base, deviceCallsThisShow: 1 }), { ok: false, reason: 'device-limit' });
  assert.deepEqual(admitCall({ ...base, banned: true, callActive: true }), { ok: false, reason: 'banned' });
  assert.deepEqual(admitCall({ ...base, callActive: true }), { ok: false, reason: 'busy' });
  assert.deepEqual(admitCall({ ...base, secondsUsedToday: 3600 - 30 }), { ok: false, reason: 'too-short' });
});

test('the day\'s minutes cap a call, and the wrap-up always lands before the cap', () => {
  assert.deepEqual(callTimings({ maxCallSec: 180, wrapUpSec: 150, secondsLeftToday: 3600 }), { capSec: 180, wrapUpAtSec: 150 });
  assert.deepEqual(callTimings({ maxCallSec: 180, wrapUpSec: 150, secondsLeftToday: 90 }), { capSec: 90, wrapUpAtSec: 70 });
});

test('a call bills its real length, capped, and at least a second', () => {
  assert.equal(billableSeconds(0, 61_200, 180), 62);
  assert.equal(billableSeconds(0, 400_000, 180), 180);
  assert.equal(billableSeconds(0, 0, 180), 1);
});

test('a ban matches on the device or the address', () => {
  const bans = [{ id: 'b', deviceId: 'dev-aaaaaaaa', ip: '1.1.1.1', name: 'x', at: '' }];
  assert.equal(isBanned(bans, { deviceId: 'dev-aaaaaaaa', ip: '2.2.2.2' }), true);
  assert.equal(isBanned(bans, { deviceId: 'dev-bbbbbbbb', ip: '1.1.1.1' }), true);
  assert.equal(isBanned(bans, { deviceId: 'dev-bbbbbbbb', ip: '2.2.2.2' }), false);
});

test('the per-device count is per show airing, so tomorrow is fresh', () => {
  assert.notEqual(showAiringKey('s1', '2026-11-08'), showAiringKey('s1', '2026-11-09'));
  assert.equal(showAiringKey(null, '2026-11-08'), '2026-11-08:default');
});

test('the DJ keeps an OpenAI persona voice on the phone, otherwise the operator pick or the default', () => {
  assert.equal(realtimeVoiceFor({ configured: '', personaProvider: 'openai', personaVoice: 'Coral' }), 'coral');
  assert.equal(realtimeVoiceFor({ configured: '', personaProvider: 'openai', personaVoice: 'nova' }), 'marin');
  assert.equal(realtimeVoiceFor({ configured: '', personaProvider: 'elevenlabs', personaVoice: 'coral' }), 'marin');
  assert.equal(realtimeVoiceFor({ configured: 'ash', personaProvider: 'openai', personaVoice: 'coral' }), 'ash');
});

test('the call prompt carries no TTS bracket cues and says the call is private', () => {
  const text = buildCallInstructions({
    persona: settings.getEffectivePersona(), context: {}, show: { name: 'Night Shift', topic: '' },
    callerName: 'anon', recentTracks: [], capSec: 180, cleanShow: false,
  });
  assert.match(text, /Nothing said on this call goes out on air/);
  assert.match(text, /Ask who's calling/);
  assert.match(text, /Current show: "Night Shift"/);
  assert.doesNotMatch(text, /\[laugh/);
});

test('the line stays closed without the provider key', () => {
  delete process.env.OPENAI_API_KEY;
  const r = line.startCall({ deviceId: 'dev-cccccccc', ip: '3.3.3.3', name: 'Sam' });
  assert.deepEqual(r, { ok: false, reason: 'provider' });
});

function fakeCall(seen: Map<string, any>) {
  return {
    id: 'call-1', token: 't', deviceId: 'dev-dddddddd', ip: '4.4.4.4', name: 'Sam',
    persona: settings.getEffectivePersona(), showId: null, showName: null,
    startedAt: Date.now(), capSec: 180, wrapUpAtSec: 150,
    picker: { tools: {}, seen }, grant: null, declined: null, endTimer: null, airingKey: 'k',
  } as any;
}

test('a Grant must name a track the call\'s own searches surfaced', async () => {
  const out = await runCallTool(fakeCall(new Map()), 'grant_request', JSON.stringify({ track_id: 'made-up' }));
  assert.equal(out.granted, false);
  assert.equal(out.reason, 'unknown-track');
});

test('a Grant queues through the chokepoint, once per call, with the caller as requester', async () => {
  queue.upcoming = [];
  queue.current = null;
  requests.clear();
  await settings.update({ requests: { enabled: true, maxPending: 6, repeatCooldownMin: 0, onePendingPerIp: true }, tts: { enabled: false } } as never);
  const song = { id: 'hot-1', title: 'Blue Song', artist: 'The Callers', duration: 200 };
  const call = fakeCall(new Map([[song.id, song]]));
  const out = await runCallTool(call, 'grant_request', { track_id: 'hot-1', dedication_for: 'my sister', dedication_note: 'her birthday' });
  assert.equal(out.granted, true);
  assert.equal(typeof out.call_seconds_left, 'number');
  // The push runs off the call's clock; wait for it to land.
  for (let i = 0; i < 50 && !queue.upcoming.length; i++) await new Promise(r => setTimeout(r, 20));
  const item = queue.upcoming.find(i => i.track?.id === 'hot-1');
  assert.ok(item, 'the granted track is queued');
  assert.equal(item!.requestedBy, 'Sam');
  assert.equal(queue.pendingListenerRequests(), 1, 'it counts as a listener request');
  const again = await runCallTool(call, 'grant_request', { track_id: 'hot-1' });
  assert.equal(again.reason, 'already-granted');
});

test('a second Grant from the same address waits for the first to air (one-pending hold)', async () => {
  const song = { id: 'hot-2', title: 'Red Song', artist: 'The Callers', duration: 200 };
  const call = fakeCall(new Map([[song.id, song]]));
  const out = await runCallTool(call, 'grant_request', { track_id: 'hot-2' });
  assert.equal(out.granted, false);
  // The per-IP cooldown from the first Grant answers first; either way, refused.
  assert.ok(['rate-limited', 'one-pending'].includes(String(out.reason)));
});
