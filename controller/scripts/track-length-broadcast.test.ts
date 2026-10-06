// Exercise actual auto.m3u and next.txt against an isolated Subsonic HTTP seam.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const root = createTempDir(join(tmpdir(), 'subwave-length-broadcast-'));
process.env.STATE_DIR = root;
const tracks = [1199, 1200, 1201, 2700].map((duration, i) => ({ id: `track${i}`, title: `Song ${i}`, artist: `Artist ${i}`, duration }));
let source: object[] = tracks;
let hold: (() => void) | null = null;
let reached: (() => void) | null = null;
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname.includes('getRandomSongs') && reached) {
    const signal = reached;
    reached = null;
    signal();
    await new Promise<void>(resolve => { hold = resolve; });
  }
  const body = url.pathname.includes('weather') ? { current: { temperature_2m: 15, weather_code: 0, is_day: 1 } } : {
    'subsonic-response': { status: 'ok', randomSongs: { song: source }, starred2: { song: [] }, playlists: { playlist: [] }, albumList2: { album: [] }, genres: { genre: [] }, song: {} },
  };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
process.env.NAVIDROME_URL = origin;
// Only the external weather API is redirected; production context remains real.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(String(input).includes('api.open-meteo.com') ? `${origin}/weather` : input, init);
const settings = await import('../src/settings.js');
await settings.load();
await settings.update({ maxTrackSeconds: 1200, loudness: { source: 'measured' } });
const { config } = await import('../src/config.js');
const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');
const { queue } = await import('../src/broadcast/queue.js');
mkdirSync(dirname(config.liquidsoap.autoPlaylist), { recursive: true });
const playlist = () => readFileSync(config.liquidsoap.autoPlaylist, 'utf8');

test('exclude publishes only eligible backup tracks, cut retains capped entries, and hard emptiness replaces stale music', async () => {
  try {
    await refreshAutoPlaylist();
    assert.ok(playlist().includes('subsonic_id="track3"'));
    assert.ok(playlist().includes('liq_cue_out="1200'));
    await settings.update({ maxTrackLengthMode: 'exclude' });
    await refreshAutoPlaylist();
    assert.ok(playlist().includes('subsonic_id="track1"'));
    assert.ok(!playlist().includes('subsonic_id="track2"'));
    assert.ok(!playlist().includes('subsonic_id="track3"'));
    assert.ok(!playlist().includes('liq_cue_out'));
    source = [tracks[3]];
    await refreshAutoPlaylist();
    assert.equal(playlist(), '#EXTM3U');

    source = tracks;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const old = refreshAutoPlaylist();
    await started;
    await settings.update({ maxTrackSeconds: 1199 });
    hold!();
    assert.equal(await old, 'deferred', 'stale in-flight build may not publish');
    await refreshAutoPlaylist();
    assert.ok(playlist().includes('subsonic_id="track0"'));
    assert.ok(!playlist().includes('subsonic_id="track1"'));

    // Unknown source length carries no maximum cutoff, but trim still owns cues.
    queue.upcoming = [{ track: { id: 'unknown', title: 'Unknown', artist: 'Artist' }, sent: false } as any];
    await queue.drainToLiquidsoap(true);
    assert.ok(!readFileSync(config.liquidsoap.queueFile, 'utf8').includes('liq_cue_out'));
    rmSync(config.liquidsoap.queueFile);
    await settings.update({ silenceTrim: { enabled: true, minGapMs: 1500 } });
    queue.upcoming = [{ track: { id: 'trim', title: 'Trim', artist: 'Artist', duration: 300, leadSilenceMs: 4000, tailSilenceMs: 4000, tailStartMs: 296000 }, sent: false } as any];
    await queue.drainToLiquidsoap(true);
    const uri = readFileSync(config.liquidsoap.queueFile, 'utf8');
    assert.ok(uri.includes('liq_cue_in="3.75"'));
    assert.ok(uri.includes('liq_cue_out="296.25"'));
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
