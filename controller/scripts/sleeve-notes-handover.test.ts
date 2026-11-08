// Outgoing Sleeve Notes must not escape into the incoming show's voice chain.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { deferred } from './test-utils/async.js';
import { weekFor } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'notes-handover-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
const { runSleeveNotesSegment } = await import('../src/sleeve-notes/segment.js');
const { voiceBusy } = await import('../src/broadcast/queue/voice-io.js');
const { withTalkAir, suppressScheduledSpeechDuringHandoff } = await import('../src/broadcast/talk-air.js');
const original = settings.get();
const host = original.personas[0];
const guest = { ...host, id: 'handover-guest', name: 'Guest' };

function startShow(id: string) {
  const show = { id, name: id, personaId: host.id };
  store.setCache({ ...settings.get(), personas: [host, guest], shows: [show], schedule: weekFor(id), scheduleOverride: null });
  session.start({ at: new Date().toISOString(), activeShow: show, time: { period: 'night', vibe: 'calm', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm' } as Parameters<typeof session.start>[0]);
}
const lines = [{ persona: host, text: 'A recording story.' }, { persona: guest, text: 'An interesting detail.' }];
beforeEach(() => {
  store.setCache({ ...original, djBehaviour: { ...original.djBehaviour, extendedSleeveNotes: true } });
  queue.senderBusy = true;
  startShow('outgoing');
});
after(async () => {
  store.setCache(original);
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 600));
  await removeTempDir(root);
});

test('manual writing is discarded across a show change even with the same host', async () => {
  const model = deferred<unknown>();
  let published = false;
  let reason = '';
  const running = runSleeveNotesSegment({ kind: 'sleeve-notes', manual: true, cooldownMs: 0,
    track: { id: 'track', artist: 'Artist', title: 'Song' }, notes: [], earlierToday: [], cast: [host], show: null },
  async () => { published = true; return true; }, () => model.promise, why => { reason = why; });
  startShow('incoming');
  model.resolve({ air: true, reason: 'Supported story', lines: [{ speaker: host.id, text: 'A recording story.' }] });
  assert.equal(await running, false);
  assert.equal(published, false);
  assert.match(reason, /show or host changed/);
});

test('exchange rendering stops when its commissioning show changes', async t => {
  const stamp = session.captureHostSpeech();
  const render = deferred<string>();
  const speak = t.mock.method(queue, '_speak', () => render.promise);
  const air = t.mock.method(queue, '_airVoice', async () => { throw new Error('Stale speech reached publication'); });
  const running = queue.announceExchange(lines, 'sleeve-notes', { hostSpeech: stamp });
  startShow('incoming');
  render.resolve(join(root, 'unused.wav'));
  assert.equal(await running, false);
  assert.equal(speak.mock.callCount(), 1, 'do not render the remaining guest speech');
  assert.equal(air.mock.callCount(), 0);
});

test('a show change while waiting for the speech file vetoes publication and all later lines', async t => {
  const stamp = session.captureHostSpeech();
  t.mock.method(queue, '_speak', async () => join(root, 'speech.wav'));
  const spoken = t.mock.method(queue, 'onSpoken', async () => true);
  writeFileSync(config.liquidsoap.sayFile, 'previous clip');
  const queued = deferred<void>();
  t.mock.method(queue, 'onQueued', () => { queued.resolve(); });
  const running = queue.announceExchange(lines, 'sleeve-notes', { hostSpeech: stamp });
  await queued.promise;
  startShow('incoming');
  unlinkSync(config.liquidsoap.sayFile);
  assert.equal(await running, false);
  assert.equal(existsSync(config.liquidsoap.sayFile), false, 'no outgoing WAV was handed to the mixer');
  assert.equal(spoken.mock.callCount(), 0, 'cancelled speech must not reach air bookkeeping');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(voiceBusy(), false, 'cancelled ordinary speech releases the upstream overlay voice reservation');
});

test('boundary-deferred exchanges retain their original show ownership', async t => {
  const stamp = session.captureHostSpeech();
  const wav = join(root, 'deferred.wav');
  writeFileSync(wav, 'fixture');
  t.mock.method(queue, '_speak', async () => wav);
  assert.equal(await withTalkAir('next-track', () => queue.announceExchange(lines, 'sleeve-notes', { hostSpeech: stamp })), true);
  startShow('incoming');
  await queue.airPendingVoice();
  assert.equal(queue.pendingVoiceTalk(), null);
  assert.equal(existsSync(config.liquidsoap.introFile), false);
});

// The explicit operator override remains available for ordinary speech.
test('a claimed handoff suppresses manual Sleeve Notes but preserves manual Banter', async () => {
  assert.equal(suppressScheduledSpeechDuringHandoff('sleeve-notes', true), true);
  assert.equal(suppressScheduledSpeechDuringHandoff('banter', true), false);
  assert.equal(suppressScheduledSpeechDuringHandoff('handoff', true), false);
  assert.equal(suppressScheduledSpeechDuringHandoff('sleeve-notes', false), false);
  assert.equal(await withTalkAir('immediate', async () => suppressScheduledSpeechDuringHandoff('banter', true)), true);
});

test('a prepared brief cannot acquire a fresh show stamp when finally selected', async () => {
  const stamp = session.captureHostSpeech();
  startShow('incoming');
  let called = false;
  assert.equal(await runSleeveNotesSegment({ kind: 'sleeve-notes', manual: true, cooldownMs: 0,
    hostSpeech: stamp, track: { id: 'track', artist: 'Artist', title: 'Song' },
    notes: [], earlierToday: [], cast: [host], show: null }, async () => true,
  async () => { called = true; return {}; }), false);
  assert.equal(called, false, 'reject an obsolete brief before spending another writing call');
});
