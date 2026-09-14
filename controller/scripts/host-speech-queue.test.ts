// Queue ownership regressions for issue #1666. Ordinary host speech is removed
// only while it is still a forecast. Music and committed or independently-owned
// audio remain untouched.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-host-speech-queue-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { enqueuePick } = await import('../src/broadcast/dj-agent/enqueue.js');
const { config } = await import('../src/config.js');

const template = settings.get().personas[0];
const A = { ...template, id: 'p_a', name: 'Host A' };
const B = { ...template, id: 'p_b', name: 'Host B' };
const SHOW = 's_active';

function week() {
  const out: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) out[day] = Array(24).fill(SHOW);
  return out;
}

function show(personaId: string) {
  return { id: SHOW, name: 'Active Show', topic: 'tests', personaId };
}

function ctx() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Active Show', topic: 'tests' },
  } as any;
}

async function seed(personaId = A.id) {
  await settings.update({
    personas: [A, B], activePersonaId: A.id,
    shows: [show(personaId)], schedule: week(), scheduleOverride: null,
  } as never);
  session.start(ctx());
}

beforeEach(async () => {
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  await seed();
});

after(async () => {
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 600));
  rmSync(root, { recursive: true, force: true });
});

function item(stamp = session.captureHostSpeech()) {
  return {
    track: { id: Math.random().toString(), title: 'Song', artist: 'Artist' },
    requestedBy: null,
    introScript: 'Host A wrote this.',
    introKind: 'link',
    introPersona: A,
    introHostSpeech: stamp,
    introSessionKey: stamp?.showKey,
    introWav: '/tmp/old.wav',
    introAired: false,
    aiPicked: true,
    linkPrev: { id: 'prev', title: 'Previous', artist: 'Artist' },
    linkClockAt: Date.now(),
    sent: false,
    confirmedInLiquidsoap: false,
    queuedAt: new Date().toISOString(),
  } as any;
}

test('a host save strips only obsolete uncommitted speech from upcoming music', async () => {
  const stale = item();
  const sent = { ...item(), track: { id: 'sent', title: 'Sent', artist: 'Artist' }, sent: true };
  const confirmed = { ...item(), track: { id: 'confirmed', title: 'Confirmed', artist: 'Artist' }, confirmedInLiquidsoap: true };
  const bedded = { ...item(), track: { id: 'bedded', title: 'Bedded', artist: 'Artist' }, bedded: true };
  const independent = {
    ...item(null), track: { id: 'manual', title: 'Manual', artist: 'Artist' },
    introHostSpeech: null, requestedBy: 'studio', aiPicked: false,
  };
  const current = { ...item(), track: { id: 'current', title: 'Current', artist: 'Artist' } };
  const history = { ...item(), track: { id: 'history', title: 'History', artist: 'Artist' } };
  queue.upcoming = [stale, sent, confirmed, bedded, independent];
  queue.current = current;
  queue.history = [history];
  const order = queue.upcoming.map(entry => entry.track.id);

  await settings.update({ shows: [show(B.id)] } as never);

  assert.deepEqual(queue.upcoming.map(entry => entry.track.id), order, 'music FIFO is unchanged');
  assert.equal(stale.introScript, null);
  assert.equal(stale.introWav, null);
  assert.equal(stale.introPersona, null);
  assert.equal(stale.linkPrev, null);
  assert.equal(stale.linkClockAt, null);
  assert.equal(sent.introScript, 'Host A wrote this.');
  assert.equal(confirmed.introScript, 'Host A wrote this.');
  assert.equal(bedded.introScript, 'Host A wrote this.');
  assert.equal(independent.introScript, 'Host A wrote this.');
  assert.equal(queue.current?.introScript, 'Host A wrote this.');
  assert.equal(queue.history[0]?.introScript, 'Host A wrote this.');
});

test('legacy same-show AI links with a known old author are invalidated', async () => {
  const legacy = item(null);
  delete legacy.introHostSpeech;
  legacy.introSessionKey = `show:${SHOW}`;
  queue.upcoming = [legacy];

  await settings.update({ shows: [show(B.id)] } as never);

  assert.equal(legacy.introScript, null);
  assert.equal(legacy.track.title, 'Song');
});

test('a delayed old-host link is discarded at enqueue without losing its song or relabelling it', async () => {
  const oldStamp = session.captureHostSpeech();
  const oldPersona = session.onAirPersona();
  await settings.update({ shows: [show(B.id)] } as never);
  let pushed: any = null;
  const fakeQueue = {
    push: async (entry: any) => { pushed = entry; return 1; },
    log: () => {},
  };

  const result = await enqueuePick(
    fakeQueue,
    { id: 'song-new', title: 'New Song', artist: 'Artist', duration: 240 },
    'reason',
    'agent',
    'An obsolete Host A link.',
    null,
    {},
    { introPersona: oldPersona, hostSpeech: oldStamp },
  );

  assert.equal(result, 1);
  assert.equal(pushed.track.id, 'song-new');
  assert.equal(pushed.introScript, null);
  assert.equal(pushed.introPersona, null);
  assert.equal(pushed.introHostSpeech, null);
});


test('queue recovery invalidates legacy old-host speech before attempting a redrain', async () => {
  await settings.update({ shows: [show(B.id)] } as never);
  const legacy = item(null);
  delete legacy.introHostSpeech;
  legacy.introSessionKey = `show:${SHOW}`;
  writeFileSync(config.queue.file, JSON.stringify({
    upcoming: [legacy], current: null, history: [], savedAt: new Date().toISOString(),
  }));
  queue.upcoming = [];

  queue.recover();

  assert.equal(queue.upcoming.length, 1);
  assert.equal(queue.upcoming[0].track.title, 'Song');
  assert.equal(queue.upcoming[0].introScript, null);
});


test('a stale uncommitted deferred host clip is settled false, while a committed pause is retained', async () => {
  const stamp = session.captureHostSpeech();
  let settled: boolean | null = null;
  assert.equal((queue as any).holdForNextTrack(
    'station-id',
    [{ text: 'Old host ident', wavPath: '/tmp/old-host.wav', persona: A, meta: {} }],
    { hostSpeech: stamp, onCompleted: (aired: boolean) => { settled = aired; } },
  ), true);

  await settings.update({ shows: [show(B.id)] } as never);
  assert.equal(queue.pendingVoiceTalk(), null);
  assert.equal(settled, false);

  await seed(A.id);
  const committedStamp = session.captureHostSpeech();
  assert.equal((queue as any).holdForNextTrack(
    'station-id',
    [{ text: 'Committed old host ident', wavPath: '/tmp/committed.wav', persona: A, meta: {} }],
    { hostSpeech: committedStamp },
  ), true);
  (queue as any)._pendingVoice.pauseId = 'committed-pause';
  (queue as any)._pendingVoice.pauseArmedAt = Date.now();

  await settings.update({ shows: [show(B.id)] } as never);
  assert.ok(queue.pendingVoiceTalk(), 'the mixer-owned pause commitment cannot be cancelled');
  (queue as any)._pendingVoice = null;
});
