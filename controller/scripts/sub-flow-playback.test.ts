import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Flow } from '../src/music/sub-flow.js';

process.env.NAVIDROME_URL = 'http://navidrome.test:4533';
process.env.NAVIDROME_USER = 'dj';
process.env.NAVIDROME_PASS = 'test';
let mixer = { version: 1, pending: '', playing: '' };
let canAir = false;
let gateSeen = () => {};
const mixerServer = createServer(socket => {
  socket.on('data', chunk => {
    if (chunk.toString().includes('subflow.status')) socket.write(`${JSON.stringify(mixer)}\nEND\n`);
    if (chunk.toString().includes('subflow.can_air')) { gateSeen(); socket.write(`${canAir}\nEND\n`); }
  });
});
await new Promise<void>(resolve => mixerServer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixerServer.address() as AddressInfo).port);
const { config } = await import('../src/config.js');
const { prepareFlow, discardFlow, flowPlaybackUri, expectFlowPlayback } = await import('../src/music/sub-flow-playback.js');
const { queue } = await import('../src/broadcast/queue.js');
const { nextTransitionLabel } = await import('../src/broadcast/queue/pure.js');
const { airVoice } = await import('../src/broadcast/queue/voice-io.js');
const originalFetch = globalThis.fetch;
const originalDrain = queue.drainToLiquidsoap;

function wav(value: number) {
  const pcm = Buffer.alloc(44100 * 4 * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44100, 24); header.writeUInt32LE(44100 * 4, 28); header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const audio = { one: wav(100), two: wav(200) };
const definition: Flow = {
  id: 'ddbd0b85-9b25-4671-b675-f25e1e07a5cd', name: 'Pair', enabled: true, revision: 1, orderVerified: true,
  verification: 'verified', verificationError: null, createdAt: '', updatedAt: '',
  tracks: Object.entries(audio).map(([id, bytes]) => ({ id, title: id, artist: 'Artist', album: 'Album', duration: 2,
    fingerprint: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, decodedSeconds: 2 } })),
};
let replaceSecond = false;
globalThis.fetch = (async input => {
  const id = new URL(String(input)).searchParams.get('id') as keyof typeof audio;
  return new Response(replaceSecond && id === 'two' ? wav(201) : audio[id], { headers: { 'content-type': 'audio/wav' } });
}) as typeof fetch;
test.after(async () => {
  globalThis.fetch = originalFetch; queue.drainToLiquidsoap = originalDrain; expectFlowPlayback(false);
  await new Promise<void>(resolve => mixerServer.close(() => resolve()));
});

test('preparation checks both fingerprints and publishes exactly the checked decoded samples', async () => {
  const settings = await import('../src/settings.js');
  await settings.update({ picker: { flowProtectBeforeSec: 3, flowProtectAfterSec: 7 } });
  const flow = await prepareFlow(definition);
  try {
    await settings.update({ picker: { flowProtectBeforeSec: 5, flowProtectAfterSec: 5 } });
    const result = await readFile(flow.path);
    assert.deepEqual(result.subarray(44), Buffer.concat([audio.one.subarray(44), audio.two.subarray(44)]));
    assert.equal((await stat(flow.path)).mode & 0o222, 0);
    assert.equal((await stat(dirname(flow.path))).mode & 0o005, 0o005);
    assert.deepEqual(flow.members.map(member => member.duration), [2, 2]);
    const uri = flowPlaybackUri(flow, 10);
    assert.match(uri, /subwave_flow_count="2"/);
    assert.match(uri, /subwave_flow_before="3"/);
    assert.match(uri, /subwave_flow_after="7"/);
    assert.match(flowPlaybackUri({ ...flow, members: flow.members.map(member => ({ ...member, duration: 20 })) }, 30), /subwave_flow_entry="16.9".*liq_cross_duration="12.9"/);
    await assert.rejects(() => queue.queueFlow(flow), /Rebuild the broadcast service/);
    assert.match(uri, /subwave_flow_1_offset="2"/);
    assert.match(uri, /liq_cross_duration="0"/);
    assert.doesNotMatch(uri, /liq_cue_|liq_amplify|liq_washout|subhttp/);
  } finally { await discardFlow(flow); }
});

test('a changed companion refuses the complete occurrence and removes partial audio', async () => {
  replaceSecond = true;
  try { await assert.rejects(() => prepareFlow(definition), /changed/); }
  finally { replaceSecond = false; }
  assert.deepEqual(await readdir(join(config.stateDir, 'sub-flow-playback')), []);
  await assert.rejects(() => prepareFlow({ ...definition, verification: 'failed' }), /Check the Flow/);
  await discardFlow({ path: join(config.stateDir, 'sub-flow-playback', 'audio.wav') });
  assert.ok((await stat(join(config.stateDir, 'sub-flow-playback'))).isDirectory());
});

test('queue admission is durable and whole, and cancelling any member cancels the whole unsent Flow', async () => {
  const flow = await prepareFlow(definition);
  flow.protectBeforeSec = 3; flow.protectAfterSec = 7;
  mixer.version = 2;
  queue.upcoming = []; queue.current = null;
  let drains = 0;
  queue.drainToLiquidsoap = async () => {
    drains++;
    const saved = JSON.parse(await readFile(config.queue.file, 'utf8'));
    assert.equal(saved.upcoming.length, 2);
    assert.equal(saved.upcoming[0].flow.protectBeforeSec, 3);
    assert.equal(saved.upcoming[1].flow.protectAfterSec, 7);
  };
  try {
    assert.equal(await queue.queueFlow(flow), 2);
    assert.equal(drains, 1);
    assert.deepEqual(queue.upcoming.map(item => item.track.id), ['one', 'two']);
    const rows = queue.snapshot().upcoming;
    assert.equal(rows[1]?.flow?.index, 1);
    assert.equal(rows[1]?.flow?.label, 'Pair');
    assert.equal(nextTransitionLabel(queue.upcoming[0], { ...queue.upcoming[1]!, sent: true }), 'Flow (gapless)');
    await assert.rejects(() => queue.queueFlow(flow), /already queued/);
    queue.drainToLiquidsoap = async () => {};
    assert.deepEqual(await queue.removeUpcoming('two'), { ok: true });
    assert.equal(queue.upcoming.length, 0);
    await assert.rejects(() => stat(flow.path));
  } finally { mixer.version = 1; queue.upcoming = []; await discardFlow(flow); }
});

test('recovery recognises a delivered occurrence without submitting it again', async () => {
  const flow = await prepareFlow(definition);
  queue.current = null;
  queue.upcoming = flow.members.map((track, index) => ({ track, requestedBy: 'studio', sent: false, flow: { ...flow, index } }));
  mixer = { version: 1, pending: flow.occurrenceId, playing: '' };
  try {
    await originalDrain.call(queue);
    assert.ok(queue.upcoming.every(item => item.sent));
    assert.ok(queue.upcoming.every(item => item.flow?.handedAt));
    await assert.rejects(() => stat(config.liquidsoap.queueFile));
  } finally { queue.upcoming = []; mixer.pending = ''; await discardFlow(flow); }
});

test('active members survive queue reconciliation, and a missing mixer occurrence is cancelled without replay', async () => {
  const flow = await prepareFlow(definition);
  const handedAt = Date.now() - 20_000;
  queue.current = { track: flow.members[0]!, flow: { ...flow, index: 0, handedAt } };
  queue.upcoming = [{ track: flow.members[1]!, sent: true, flow: { ...flow, index: 1, handedAt } }];
  mixer = { version: 1, pending: '', playing: flow.occurrenceId };
  try {
    await queue.reconcileFlowPlayback();
    assert.equal(queue.upcoming.length, 1);
    assert.deepEqual(await queue.commitBeforeSkip(), { pending: false, committed: false, waitedMs: 0 });
    assert.deepEqual(await queue.removeUpcoming('two'), { ok: false, reason: 'already-playing' });
    mixer.playing = '';
    await queue.reconcileFlowPlayback();
    assert.equal(queue.upcoming.length, 0);
    assert.equal(queue.current.flow, undefined);
    await assert.rejects(() => stat(flow.path));
    await assert.rejects(() => stat(config.liquidsoap.queueFile));
  } finally { queue.current = null; queue.upcoming = []; await discardFlow(flow); }
});

test('an uncertain handoff after both services restart is cancelled, never replayed', async () => {
  const flow = await prepareFlow(definition);
  queue.current = null;
  queue.upcoming = flow.members.map((track, index) => ({ track, requestedBy: 'studio', sent: false,
    flow: { ...flow, index, deliveryStartedAt: Date.now() - 10_000 } }));
  mixer = { version: 1, pending: '', playing: '' };
  try {
    await originalDrain.call(queue);
    assert.equal(queue.upcoming.length, 0);
    await assert.rejects(() => stat(config.liquidsoap.queueFile));
    await assert.rejects(() => stat(flow.path));
  } finally { queue.upcoming = []; await discardFlow(flow); }
});

test('speech waits for the mixer window and is cancelled if its publication becomes stale', async () => {
  const path = join(config.stateDir, 'voice.wav');
  await writeFile(path, audio.one);
  expectFlowPlayback(true);
  canAir = false;
  let seen!: () => void;
  let checked = new Promise<void>(resolve => { seen = resolve; });
  gateSeen = () => seen();
  const handoff = airVoice(config.liquidsoap.sayFile, path, 'A safe clip');
  await checked;
  await assert.rejects(() => stat(config.liquidsoap.sayFile));
  canAir = true;
  await handoff;
  assert.ok((await readFile(config.liquidsoap.sayFile, 'utf8')).includes(path));
  await unlink(config.liquidsoap.sayFile);

  canAir = false;
  let wanted = true;
  checked = new Promise<void>(resolve => { seen = resolve; });
  const stale = airVoice(config.liquidsoap.sayFile, path, 'An outdated clip', 0, { beforeWrite: () => wanted });
  await checked;
  wanted = false;
  assert.equal(await stale, null);
  await assert.rejects(() => stat(config.liquidsoap.sayFile));
  expectFlowPlayback(false);
});
