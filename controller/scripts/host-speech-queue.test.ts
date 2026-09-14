// Queue ownership regressions for issue #1666. Ordinary host speech is removed
// only while it is still a forecast. Music and committed or independently-owned
// audio remain untouched.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-host-speech-queue-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { enqueuePick, generatePickLink } = await import('../src/broadcast/dj-agent/enqueue.js');
const { config } = await import('../src/config.js');
const realBedCatalog = (queue as any)._bedCatalog;
const realBedGetPath = (queue as any)._bedGetPath;
const realWriteHandoff = (queue as any)._writeHandoff;
const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;

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
  (queue as any)._bedCatalog = realBedCatalog;
  (queue as any)._bedGetPath = realBedGetPath;
  (queue as any)._writeHandoff = realWriteHandoff;
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
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

test('the production generation seam discards a delayed A link across A to B to A without losing its song', async () => {
  const generation = deferred<string>();
  let generatedFor: string | null = null;
  const pending = generatePickLink(
    { previous: null, current: { id: 'song-new', title: 'New Song', artist: 'Artist' } },
    async (args) => {
      generatedFor = (args.persona as any)?.id ?? null;
      return generation.promise;
    },
  );
  await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  await settings.update({ shows: [show(A.id)] } as never);
  generation.resolve('An obsolete Host A link.');
  const generated = await pending;

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
    generated.link,
    null,
    {},
    { introPersona: generated.introPersona, hostSpeech: generated.hostSpeech },
  );

  assert.equal(generatedFor, A.id, 'the actual writer received the captured A persona');
  assert.equal(generated.link, null, 'returning to A does not revive the old A generation');
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

test('queue.push refuses stale request speech without losing listener provenance or music', async () => {
  const oldHost = session.captureHostSpeech();
  await settings.update({ shows: [show(B.id)] } as never);

  const pos = await queue.push({
    track: { id: 'listener-song', title: 'Listener Song', artist: 'Artist' },
    requestedBy: 'alice',
    intent: 'listener request',
    introScript: 'Host A wrote this request intro.',
    introKind: 'dj-speak',
    introPersona: A,
    introHostSpeech: oldHost,
  });

  assert.equal(pos, 1);
  assert.equal(queue.upcoming[0].track.id, 'listener-song');
  assert.equal(queue.upcoming[0].requestedBy, 'alice');
  assert.equal(queue.upcoming[0].intent, 'listener request');
  assert.equal(queue.upcoming[0].introScript, null);
  assert.equal(queue.upcoming[0].introPersona, null);
  assert.equal(queue.upcoming[0].introHostSpeech, null);
});

test('rapid A to B to A saves persist the speech epoch before a queue snapshot can outrun it', async () => {
  // Let seed()'s ordinary debounced session snapshot land as revision 0, then
  // recreate the reported crash window: queue.json lands at 500 ms while the
  // changed session used to wait 1,000 ms.
  await new Promise(resolve => setTimeout(resolve, 1_100));
  const originalStamp = session.captureHostSpeech();
  await settings.update({ shows: [show(B.id)] } as never);
  await settings.update({ shows: [show(A.id)] } as never);
  const freshStamp = session.captureHostSpeech();
  assert.equal(freshStamp?.revision, 2);

  const fresh = item(freshStamp);
  fresh.track = { id: 'fresh-after-return', title: 'Fresh After Return', artist: 'Artist' };
  fresh.introScript = 'Fresh Host A speech from revision two.';
  queue.upcoming = [fresh];
  queue.persist();
  await new Promise(resolve => setTimeout(resolve, 600));

  const sessionDisk = JSON.parse(readFileSync(config.session.currentFile, 'utf8'));
  const queueDisk = JSON.parse(readFileSync(config.queue.file, 'utf8'));
  assert.equal(sessionDisk.hostRevision, 2, 'the session epoch is durable before queue.json can carry it');
  assert.equal(queueDisk.upcoming[0].introHostSpeech.revision, 2);

  // Simulate the controller-only restart ordering in server.ts: session first,
  // queue second. The valid final-A speech and its music must both survive.
  queue.upcoming = [];
  await session.recover(ctx());
  queue.recover();
  assert.equal(session.captureHostSpeech()?.revision, 2);
  assert.equal(queue.upcoming[0].track.id, 'fresh-after-return');
  assert.equal(queue.upcoming[0].introScript, 'Fresh Host A speech from revision two.');

  // The matching persona id is not enough: speech from the first A epoch must
  // still be removed after the A -> B -> A restart, without removing the
  // listener-owned queue item around it.
  const stale = item(originalStamp);
  stale.track = { id: 'old-a-request', title: 'Old A Request', artist: 'Artist' };
  stale.requestedBy = 'alice';
  stale.intent = 'listener request';
  writeFileSync(config.queue.file, JSON.stringify({
    upcoming: [stale], current: null, history: [], savedAt: new Date().toISOString(),
  }));
  queue.upcoming = [];
  queue.recover();
  assert.equal(queue.upcoming[0].track.id, 'old-a-request');
  assert.equal(queue.upcoming[0].requestedBy, 'alice');
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


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function bedItem() {
  const queued = item();
  queued.introScript = 'Host A carries a deliberately long spoken link across enough words to require an instrumental bed before this incoming song begins for listeners tonight.';
  queued.introWav = '/tmp/host-a-link.wav';
  queued.track = { id: 'bed-song', title: 'Bed Song', artist: 'Artist', duration: 240 };
  return queued;
}

test('a host save during bed lookup prevents the obsolete bed from being committed', async () => {
  await settings.update({ beds: { enabled: true, thresholdSec: 1 } } as never);
  const queued = bedItem();
  queue.upcoming = [queued];
  const catalog = deferred<{ name: string; durationSec: number }[]>();
  let writes = 0;
  (queue as any)._bedCatalog = () => catalog.promise;
  (queue as any)._bedGetPath = async () => '/tmp/bed.mp3';
  (queue as any)._writeHandoff = async () => { writes += 1; };

  const pushing = (queue as any).maybePushBed(queued);
  await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  catalog.resolve([{ name: 'test-bed', durationSec: 120 }]);
  await pushing;

  assert.equal(writes, 0, 'no bed reaches next.txt after its speech was invalidated');
  assert.notEqual(queued.bedded, true);
  assert.equal(queued.introScript, null);
});

test('a bed is protected as committed while its handoff write is pending', async () => {
  await settings.update({ beds: { enabled: true, thresholdSec: 1 } } as never);
  const queued = bedItem();
  queue.upcoming = [queued];
  const handoff = deferred<void>();
  let writeStarted = false;
  (queue as any)._bedCatalog = async () => [{ name: 'test-bed', durationSec: 120 }];
  (queue as any)._bedGetPath = async () => '/tmp/bed.mp3';
  (queue as any)._writeHandoff = async () => {
    writeStarted = true;
    await handoff.promise;
  };

  const pushing = (queue as any).maybePushBed(queued);
  while (!writeStarted) await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);

  assert.equal(queued.bedded, true, 'the in-progress mixer handoff is already a timeline commitment');
  assert.ok(queued.introScript, 'committed speech is not rewritten during the handoff');
  handoff.resolve();
  await pushing;
  assert.equal(queued.bedded, true);
});


test('late queue render completion cannot restore an invalidated unsent link', async () => {
  const queued = item();
  queued.introWav = null;
  queue.upcoming = [queued];
  const rendered = deferred<string>();
  (queue as any)._speak = () => rendered.promise;

  const pending = (queue as any).startIntroRender(queued);
  await settings.update({ shows: [show(B.id)] } as never);
  rendered.resolve('/tmp/late-host-a.wav');
  await pending;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(queued.introScript, null);
  assert.equal(queued.introWav, null, 'the old observer cannot put its WAV back');
});

test('a render already committed to the mixer may complete after the host changes', async () => {
  const committed = item();
  committed.introWav = null;
  committed.sent = true;
  queue.upcoming = [committed];
  const rendered = deferred<string>();
  (queue as any)._speak = () => rendered.promise;

  const pending = (queue as any).startIntroRender(committed);
  await settings.update({ shows: [show(B.id)] } as never);
  rendered.resolve('/tmp/committed-host-a.wav');
  await pending;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(committed.introScript, 'Host A wrote this.');
  assert.equal(committed.introWav, '/tmp/committed-host-a.wav');
});

test('a timed-out render transferred to current is reused and accepted once', async () => {
  const queued = item();
  queued.introWav = null;
  queued.sent = true;
  queue.upcoming = [queued];
  const rendered = deferred<string>();
  (queue as any)._speak = () => rendered.promise;
  let accepted = 0;
  (queue as any)._airVoice = async (_file: string, _wav: string, _text: string, _gain: number, opts: any) => {
    accepted += 1;
    opts?.onQueued?.({ voiceId: 'voice-current', clipMs: 1000, estimatedAirInMs: 0 });
    return { voiceId: 'voice-current', clipMs: 1000, aired: Promise.resolve(null) };
  };

  const pending = (queue as any).startIntroRender(queued);
  const current = { ...queued, startedAt: new Date().toISOString() };
  queue.current = current;
  queue.upcoming = [];
  (queue as any)._introRenders.transfer(queued, current);
  const airing = queue.airIntro(current);
  const wav = join(root, 'transferred.wav');
  writeFileSync(wav, 'wav');
  rendered.resolve(wav);
  await pending;
  await airing;

  assert.equal(current.introWav, wav);
  assert.equal(accepted, 1);
});

test('standalone host speech is refused after stale TTS, but remains accepted once it enters the voice chain', async () => {
  const staleStamp = session.captureHostSpeech();
  const firstRender = deferred<string>();
  let accepted = 0;
  (queue as any)._speak = () => firstRender.promise;
  (queue as any)._airVoice = async () => {
    accepted += 1;
    return { voiceId: 'unexpected', clipMs: 1000, aired: Promise.resolve(null) };
  };
  const staleAnnounce = queue.announce('Old host automatic ident', 'station-id', {
    persona: A, hostSpeech: staleStamp,
  });
  await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  firstRender.resolve('/tmp/stale-standalone.wav');
  const staleOutcome = await staleAnnounce;
  assert.equal(staleOutcome.accepted, false);
  assert.equal(accepted, 0);

  await seed(A.id);
  const committedStamp = session.captureHostSpeech();
  (queue as any)._speak = async () => '/tmp/accepted-standalone.wav';
  const chain = deferred<any>();
  let entered = false;
  (queue as any)._airVoice = async (_file: string, _wav: string, _text: string, _gain: number, opts: any) => {
    entered = true;
    opts?.onQueued?.({ voiceId: 'accepted', clipMs: 1000, estimatedAirInMs: 0 });
    return chain.promise;
  };
  const acceptedAnnounce = queue.announce('Committed host automatic ident', 'station-id', {
    persona: A, hostSpeech: committedStamp,
  });
  while (!entered) await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  chain.resolve({ voiceId: 'accepted', clipMs: 1000, aired: Promise.resolve(null) });
  const acceptedOutcome = await acceptedAnnounce;
  assert.equal(acceptedOutcome.accepted, true, 'voice-chain acceptance is the commitment boundary');
});
