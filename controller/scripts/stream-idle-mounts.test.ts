// Which MP3 mount is up, from the committed status poll (#2072). GET /state's
// idle window is tied to Icecast's stream_start for /stream.mp3, which changes
// whenever the mount is created anew, so a restart the controller did not cause
// withdraws it. Unknown (a failed poll, a missing mount or field, no poll yet)
// must never read as unchanged. The monitor's side is in
// stream-idle-window.test.ts.
//
// Run: npm test -- stream-idle-mounts

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

// A stand-in Icecast status endpoint, bound before config reads
// ICECAST_STATUS_URL. `reply` is what the next poll gets.
let reply = { status: 200, body: '{}' };
let requests = 0;
const icecast = createServer((_req, res) => {
  requests++;
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(reply.body);
});
await new Promise<void>(resolve => icecast.listen(0, '127.0.0.1', resolve));
process.env.ICECAST_STATUS_URL =
  `http://127.0.0.1:${(icecast.address() as AddressInfo).port}/status-json.xsl`;
after(() => {
  icecast.closeAllConnections();
  icecast.close();
});

const listeners = await import('../src/broadcast/listeners.js');

// The MP3 source exactly as Icecast-KH 2.4.0-kh22 listed it on the rig. A
// station with only MP3 on gets `source` as one object, not an array.
const KH_MP3 = {
  audio_info: 'channels=2;samplerate=44100;bitrate=192', bitrate: 192, connected: 5, dummy: null,
  incoming_bitrate: 234704, listener_peak: 0, listeners: 0, listenurl: 'http://localhost:7702/stream.mp3',
  outgoing_kbitrate: 0, queue_size: 115983, server_name: 'SUB/WAVE', server_url: 'http://localhost:7700',
  stream_start: '29/Oct/2026:11:58:12 +0000', total_mbytes_sent: 0,
};
const icestats = (source: unknown) => ({ source });
const status = (source: unknown) => JSON.stringify({ icestats: icestats(source) });

test('nothing is known before the first committed poll', () => {
  assert.equal(listeners.broadcastMountStart(), null);
});

test('the MP3 mount is read off a lone source object and off a list', () => {
  assert.equal(listeners.mp3MountStart(icestats(KH_MP3)), '29/Oct/2026:11:58:12 +0000');
  const opus = { ...KH_MP3, listenurl: 'http://localhost:7702/stream.opus', stream_start: '29/Oct/2026:09:00:00 +0000' };
  const stray = { ...KH_MP3, listenurl: 'http://localhost:7702/test.mp3x', stream_start: 'x' };
  assert.equal(listeners.mp3MountStart(icestats([opus, stray, KH_MP3])), '29/Oct/2026:11:58:12 +0000');
});

test('a vanished mount or a missing, blank or odd field reads as unknown', () => {
  const opusOnly = { ...KH_MP3, listenurl: 'http://localhost:7702/stream.opus' };
  for (const ic of [
    icestats(opusOnly),
    icestats([]),
    {},
    undefined,
    icestats({ ...KH_MP3, stream_start: undefined }),
    icestats({ ...KH_MP3, stream_start: '  ' }),
    icestats({ ...KH_MP3, stream_start: 1793272692 }),
    icestats({ ...KH_MP3, stream_start: null }),
  ]) {
    assert.equal(listeners.mp3MountStart(ic), null, JSON.stringify(ic));
  }
});

test('a committed poll records the mount; the rest of the source churning does not change it', async () => {
  reply = { status: 200, body: status(KH_MP3) };
  await listeners.refresh();
  assert.equal(listeners.broadcastMountStart(), '29/Oct/2026:11:58:12 +0000');
  // Five seconds on: the same mount, with its counters moved.
  reply = { status: 200, body: status({ ...KH_MP3, connected: 10, queue_size: 120001, incoming_bitrate: 230000 }) };
  await listeners.refresh();
  assert.equal(listeners.broadcastMountStart(), '29/Oct/2026:11:58:12 +0000');
});

test('a new stream_start, a vanished mount and a failed poll each move it', async () => {
  reply = { status: 200, body: status({ ...KH_MP3, connected: 0, stream_start: '29/Oct/2026:11:58:22 +0000' }) };
  await listeners.refresh();
  assert.equal(listeners.broadcastMountStart(), '29/Oct/2026:11:58:22 +0000');

  reply = { status: 200, body: status({ ...KH_MP3, listenurl: 'http://localhost:7702/stream.opus' }) };
  await listeners.refresh();
  assert.equal(listeners.broadcastMountStart(), null);

  reply = { status: 200, body: status(KH_MP3) };
  await listeners.refresh();
  assert.equal(listeners.broadcastMountStart(), '29/Oct/2026:11:58:12 +0000');
  reply = { status: 503, body: 'down' };
  await listeners.refresh();
  assert.equal(listeners.broadcastMountStart(), null);
});

test('the wake probe reads the same status but records nothing', async () => {
  reply = { status: 200, body: status(KH_MP3) };
  await listeners.refresh();
  const before = requests;
  reply = { status: 200, body: status({ ...KH_MP3, stream_start: '29/Oct/2026:12:00:00 +0000' }) };
  assert.equal(await listeners.peekListeners(), 0);
  assert.equal(requests, before + 1);
  assert.equal(listeners.broadcastMountStart(), '29/Oct/2026:11:58:12 +0000');
});
