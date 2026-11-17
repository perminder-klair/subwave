// the playing FILE's own format (suffix, sample rate, bit depth, bit
// rate) for the Dash, looked up from Navidrome once per track.
//
// Pins: the projection of a Subsonic song (unknown/zero fields are absent,
// never zeroed), the per-track memo (one getSong per id however often the
// Dash polls, concurrent polls share one call, a failure is retried only
// after a short back-off), and the admin route's gate and shape.
//
// Run: npm test -- now-playing-file

import assert from 'node:assert/strict';
import test from 'node:test';
import { listen } from './test-utils/http.js';

process.env.ADMIN_USER = 'file-admin';
process.env.ADMIN_PASS = 'file-admin-pass';
const ADMIN = { authorization: `Basic ${Buffer.from('file-admin:file-admin-pass').toString('base64')}` };

const { fileFormatOf, createFileFormatLookup } = await import('../src/music/file-format.js');
const { FILE_FORMAT_RETRY_MS } = await import('../src/schemas/file-format.js');
const { createNowPlayingFileRouter } = await import('../src/routes/now-playing-file.js');
const express = (await import('express')).default;

// The shapes production Navidrome 0.64.2 returned on 19 Oct.
const FLAC = { id: 'a', suffix: 'flac', contentType: 'audio/flac', bitRate: 979, samplingRate: 44100, bitDepth: 16, channelCount: 2 };
const MP3 = { id: 'b', suffix: 'MP3', contentType: 'audio/mpeg', bitRate: 192, samplingRate: 44100, bitDepth: 0, channelCount: 2 };
const DSF = { id: 'c', suffix: 'dsf', contentType: 'audio/x-dsf', bitRate: 11290, samplingRate: 5644800, bitDepth: 1, channelCount: 2 };

test('projection: every field the Dash shows, off a FLAC', () => {
  assert.deepEqual(fileFormatOf(FLAC), {
    suffix: 'flac', bitRate: 979, samplingRate: 44100, bitDepth: 16, channelCount: 2,
  });
});

test('projection: a zero bit depth (lossy) is absent, not 0; the suffix is lowercased', () => {
  const f = fileFormatOf(MP3);
  assert.equal(f.suffix, 'mp3');
  assert.equal('bitDepth' in f, false);
  assert.equal(f.bitRate, 192);
});

test('projection: a 1-bit DSD file keeps its bit depth', () => {
  assert.equal(fileFormatOf(DSF).bitDepth, 1);
  assert.equal(fileFormatOf(DSF).samplingRate, 5644800);
});

test('projection: missing, non-numeric and negative fields are dropped', () => {
  assert.deepEqual(fileFormatOf({ suffix: '', bitRate: 'x', samplingRate: -1, bitDepth: null }), {});
  assert.deepEqual(fileFormatOf(null), {});
});

function fakeSongs(songs: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    getSong: async (id: string) => {
      calls.push(id);
      await new Promise(r => setTimeout(r, 5));
      if (!(id in songs)) throw new Error('not found');
      return songs[id];
    },
  };
}

test('lookup: one Navidrome call per track, however often it is asked', async () => {
  const f = fakeSongs({ a: FLAC });
  const lookup = createFileFormatLookup({ getSong: f.getSong });
  for (let i = 0; i < 5; i++) assert.equal((await lookup('a'))?.suffix, 'flac');
  assert.deepEqual(f.calls, ['a']);
});

test('lookup: concurrent polls for the same track share one call', async () => {
  const f = fakeSongs({ a: FLAC });
  const lookup = createFileFormatLookup({ getSong: f.getSong });
  const all = await Promise.all([lookup('a'), lookup('a'), lookup('a')]);
  assert.ok(all.every(x => x?.bitDepth === 16));
  assert.deepEqual(f.calls, ['a']);
});

test('lookup: a failure answers null and is retried only after the back-off', async () => {
  const f = fakeSongs({});
  let now = 1_000_000;
  const lookup = createFileFormatLookup({ getSong: f.getSong, now: () => now });
  assert.equal(await lookup('x'), null);
  assert.equal(await lookup('x'), null);
  assert.deepEqual(f.calls, ['x'], 'a Dash polling every 3 s must not hammer a down Navidrome');
  now += FILE_FORMAT_RETRY_MS + 1;
  await lookup('x');
  assert.deepEqual(f.calls, ['x', 'x']);
});

test('lookup: the memo stays bounded', async () => {
  const songs: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) songs[`t${i}`] = { ...FLAC, id: `t${i}` };
  const f = fakeSongs(songs);
  const lookup = createFileFormatLookup({ getSong: f.getSong, max: 3 });
  for (let i = 0; i < 10; i++) await lookup(`t${i}`);
  await lookup('t0'); // evicted long ago: fetched again
  assert.equal(f.calls.filter(c => c === 't0').length, 2);
  await lookup('t9'); // still held
  assert.equal(f.calls.filter(c => c === 't9').length, 1);
});

async function serve(deps: Parameters<typeof createNowPlayingFileRouter>[0]) {
  const app = express();
  app.use(createNowPlayingFileRouter(deps));
  const s = await listen(app);
  s.server.unref();
  return s;
}

const get = (s: { url: string }, path: string, headers: Record<string, string> = ADMIN) =>
  fetch(`${s.url}${path}`, { headers });

test('route: admin-only, so no credentials or wrong ones are a 401 with no lookup', async () => {
  const f = fakeSongs({ a: FLAC });
  const s = await serve({ nowPlaying: async () => ({ subsonic_id: 'a' }), lookup: createFileFormatLookup({ getSong: f.getSong }) });
  assert.equal((await get(s, '/now-playing/file', {})).status, 401);
  const wrong = { authorization: `Basic ${Buffer.from('file-admin:nope').toString('base64')}` };
  assert.equal((await get(s, '/now-playing/file', wrong)).status, 401);
  assert.deepEqual(f.calls, []);
  assert.equal((await get(s, '/now-playing/file')).status, 200);
  await s.close();
});

test('route: the playing track\'s id and format', async () => {
  const f = fakeSongs({ a: FLAC });
  const s = await serve({ nowPlaying: async () => ({ subsonic_id: 'a', title: 'T' }), lookup: createFileFormatLookup({ getSong: f.getSong }) });
  const body = await (await get(s, '/now-playing/file')).json();
  assert.deepEqual(body, { id: 'a', format: fileFormatOf(FLAC) });
  await s.close();
});

// A jingle or bed never writes now-playing.json, so it is not this case: the
// song before it stays on record. Nulls mean no song on record at all.
test('route: no song on record (boot, or the stream idled down) answers nulls', async () => {
  for (const np of [null, { title: 'T', subsonic_id: '' }]) {
    const f = fakeSongs({ a: FLAC });
    const s = await serve({ nowPlaying: async () => np, lookup: createFileFormatLookup({ getSong: f.getSong }) });
    assert.deepEqual(await (await get(s, '/now-playing/file')).json(), { id: null, format: null });
    assert.deepEqual(f.calls, []);
    await s.close();
  }
});

test('route: ?id= naming the track on air answers its format', async () => {
  const f = fakeSongs({ a: FLAC });
  const s = await serve({ nowPlaying: async () => ({ subsonic_id: 'a' }), lookup: createFileFormatLookup({ getSong: f.getSong }) });
  assert.deepEqual(await (await get(s, '/now-playing/file?id=a')).json(), { id: 'a', format: fileFormatOf(FLAC) });
  await s.close();
});

test('route: ?id= naming a track no longer on air answers the on-air id and no format, without a lookup', async () => {
  const f = fakeSongs({ a: FLAC, b: MP3 });
  const s = await serve({ nowPlaying: async () => ({ subsonic_id: 'b' }), lookup: createFileFormatLookup({ getSong: f.getSong }) });
  assert.deepEqual(await (await get(s, '/now-playing/file?id=a')).json(), { id: 'b', format: null });
  assert.deepEqual(f.calls, []);
  await s.close();
});

test('route: an unreachable Navidrome is a null format, not an error', async () => {
  const f = fakeSongs({});
  const s = await serve({ nowPlaying: async () => ({ subsonic_id: 'gone' }), lookup: createFileFormatLookup({ getSong: f.getSong }) });
  const res = await get(s, '/now-playing/file');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'gone', format: null });
  await s.close();
});
