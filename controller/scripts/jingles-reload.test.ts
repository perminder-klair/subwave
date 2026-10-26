// Every write of jingles.m3u is followed by a telnet `jingles.reload` (#2008).
// The mixer's own reload_mode="watch" cannot be trusted with it: on Liquidsoap
// 2.4.5 the watch follows the inode that the first atomic rewrite replaces, so
// 184 uploaded jingles sat outside the rotate until the mixer restarted. The
// reload is coalesced and never awaited, so a write can neither wait on it nor
// fail because of it. Run: npm test -- jingles-reload

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-jingles-reload-'));
process.env.STATE_DIR = stateDir;
delete process.env.TTS_HEAVY_URL;
writeFileSync(join(stateDir, 'settings.json'), JSON.stringify({
  tts: { defaultEngine: 'remote', remote: { url: 'https://remote.test' } },
}));

// A stand-in mixer. 'no-rotate' is what a mixer started with jingleRatio 0, or
// with the controller drawing jingles, answers: it has no `jingles` playlist.
let reply: 'ok' | 'no-rotate' | 'drop' = 'ok';
const commands: string[] = [];
let heard: (() => void) | null = null;
const mixer = createServer(socket => socket.once('data', data => {
  commands.push(data.toString().split('\n')[0].trim());
  heard?.();
  if (reply === 'drop') socket.destroy();
  else socket.end(reply === 'ok' ? 'OK\r\nEND\r\n' : 'ERROR: unknown command, type "help" to get a list of commands.\r\nEND\r\n');
}));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const settings = await import('../src/settings.js');
await settings.load();
const remoteTts = await import('../src/audio/remoteTts.js');
const jingles = await import('../src/broadcast/jingles.js');
const { reloadJinglesPlaylist } = await import('../src/broadcast/liquidsoap-control.js');

// A real 16-bit PCM WAV, so the upload path's ffmpeg levelling has audio to read.
function wav(seconds = 0.5, rate = 44_100): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let i = 0; i < data.length / 2; i++) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (String(input).endsWith('/health')) return Response.json({ ok: true });
  return new Response(wav(), { status: 200, headers: { 'content-type': 'audio/wav' } });
}) as typeof fetch;
await remoteTts.refresh();

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) => mixer.close(err => err ? reject(err) : resolve()));
});

// Real time, bounded: the reload still has a socket to cross after the mocked
// clock has fired it.
function within(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Run one write on a mocked clock, then let the settle window pass. Returns
// the commands the mixer received after the write had already returned.
async function writeThenSettle(t: TestContext, write: () => Promise<unknown>): Promise<string[]> {
  commands.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await write();
  assert.deepEqual(commands, [], 'the write returned before any reload went out');
  const arrived = new Promise<void>(resolve => { heard = resolve; });
  t.mock.timers.tick(jingles.RELOAD_SETTLE_MS);
  t.mock.timers.reset();
  await within(arrived, 2000);
  heard = null;
  return [...commands];
}

const WRITERS: Array<[string, () => Promise<unknown>]> = [
  ['the boot ident check', () => jingles.ensureDefaultIdent()],
  ['a TTS jingle', () => jingles.create('Station ident.')],
  ['an upload', () => jingles.importAudio(wav(), { originalName: 'upload.wav' })],
  ['a persona bundle jingle', () => jingles.adopt(wav(), { filename: 'bundled.wav', text: 'Bundled' })],
  ['a backup restore', () => jingles.restoreMeta({
    items: { 'station_ident_default.wav': { text: 'ident', builtin: true } },
  })],
];

for (const [name, write] of WRITERS) {
  test(`${name} reloads the mixer's rotate after the write`, async t => {
    assert.deepEqual(await writeThenSettle(t, write), ['jingles.reload']);
  });
}

test('a delete reloads the mixer\'s rotate after the write', async t => {
  let filename = '';
  await writeThenSettle(t, async () => {
    ({ filename } = await jingles.adopt(wav(), { filename: 'doomed.wav' }));
  });
  assert.deepEqual(await writeThenSettle(t, () => jingles.remove(filename)), ['jingles.reload']);
  assert.ok(!readFileSync(join(stateDir, 'jingles.m3u'), 'utf8').includes(filename));
});

test('a batch upload costs one reload, sent once the batch has settled', async t => {
  commands.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const names: string[] = [];
  for (let i = 0; i < 5; i++) {
    names.push((await jingles.importAudio(wav(), { originalName: `batch-${i}.wav` })).filename);
    // The next file lands just inside the wait, which starts over.
    t.mock.timers.tick(jingles.RELOAD_SETTLE_MS - 1);
  }
  assert.deepEqual(commands, []);
  const arrived = new Promise<void>(resolve => { heard = resolve; });
  t.mock.timers.tick(1);
  t.mock.timers.tick(jingles.RELOAD_SETTLE_MS * 10);
  t.mock.timers.reset();
  await within(arrived, 2000);
  heard = null;
  await pause(200);
  assert.deepEqual(commands, ['jingles.reload']);
  // ...and the playlist that one reload re-reads holds the whole batch.
  const playlist = readFileSync(join(stateDir, 'jingles.m3u'), 'utf8');
  for (const name of names) assert.ok(playlist.includes(name), `${name} missing from jingles.m3u`);
});

test('a mixer without the rotate, or one that drops the line, never fails a write', async t => {
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => { rejections.push(err); };
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    process.off('unhandledRejection', onRejection);
    reply = 'ok';
  });
  for (const mode of ['no-rotate', 'drop'] as const) {
    reply = mode;
    const sent = await writeThenSettle(t, () => jingles.adopt(wav(), { filename: `${mode}.wav` }));
    assert.deepEqual(sent, ['jingles.reload'], mode);
    assert.equal(await reloadJinglesPlaylist(), false, mode);
  }
  await pause(200);
  assert.deepEqual(rejections, []);
});
