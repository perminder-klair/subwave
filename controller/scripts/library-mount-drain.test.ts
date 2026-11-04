// The drain's one local-or-stream decision per handoff (#2222), through the REAL
// queue.drainToLiquidsoap against a fake mixer on a real socket.
//
// THE DEFECT. The mount proof reads one sample file, and a local handoff gets no
// resolve probe. A broadcast mount narrower than the controller's still proves
// the mount, and a mount that drops under a running mixer leaves the proof
// standing until the next tick, so a pick the mixer can't open went out local,
// left dj_queue unseen, and held the slot until the reconcile sweep cleared it
// several coast tracks later. Now the drain asks about the pick's own file, and
// anything but a timely yes streams with a probe, so verifyPushResolved can chase
// it. The URI is built from that one decision, and a proof lost while the write
// waits on the previous handoff streams too.
//
// Run: npm test -- library-mount-drain

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const YES = 'yes\nEND\n';
const NO = 'no\nEND\n';

const base = createTempDir(join(tmpdir(), 'subwave-library-mount-drain-'));
process.env.STATE_DIR = join(base, 'state');
mkdirSync(process.env.STATE_DIR, { recursive: true });
process.env.NAVIDROME_URL = 'http://drain-library.invalid';

// The mixer answers path_readable from `reply`, except for the files its own copy
// lacks. Anything else (the resolve probe's status, a reload) is a plain OK.
let reply = YES;
const missing = new Set<string>();
const commands: string[] = [];
const mixer = createServer((socket: Socket) => {
  socket.on('error', () => {});
  socket.once('data', (data) => {
    const command = data.toString().trim();
    commands.push(command);
    if (!command.startsWith('path_readable ')) return void socket.end('OK\nEND\n');
    socket.end(missing.has(command.slice('path_readable '.length)) ? NO : reply);
  });
});
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } });
};

const settings = await import('../src/settings.js');
await settings.load();
const { config } = await import('../src/config.js');
const { queue } = await import('../src/broadcast/queue.js');
const { libraryMountProven, proveLibraryMount, _resetLibraryMount } = await import('../src/music/library-mount.js');
// The queue's own fields this test sets and reads.
type Pick = {
  track: { id: string; title: string; artist: string; album: string; path: string; duration: number };
  sent: boolean;
  aiPicked: boolean;
  resolveProbeId?: string;
};
const q = queue as unknown as {
  upcoming: Pick[];
  current: unknown;
  djLog: { message: string }[];
  _persistTimer?: NodeJS.Timeout;
  _recentPlaysTimer?: NodeJS.Timeout;
};

const SONG = 'Artist/Album/01 - Song.flac';
let run = 0;
let root = '';
const put = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  return path;
};
const pick = (path = SONG): Pick => ({
  track: { id: `t-${run}-${path.length}`, title: 'Song', artist: 'Artist', album: 'Album', path, duration: 240 },
  sent: false,
  aiPicked: true,
});
const handedOver = () => readFileSync(config.liquidsoap.queueFile, 'utf8');
async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  _resetLibraryMount();
  reply = YES;
  missing.clear();
  commands.length = 0;
  root = join(base, `mount-${(run += 1)}`);
  put(join(root, SONG));
  process.env.MUSIC_LIBRARY_PATH = root;
  if (existsSync(config.liquidsoap.queueFile)) rmSync(config.liquidsoap.queueFile);
  q.upcoming = [];
  q.current = null;
});

after(async () => {
  globalThis.fetch = realFetch;
  _resetLibraryMount();
  delete process.env.MUSIC_LIBRARY_PATH;
  if (q._persistTimer) clearTimeout(q._persistTimer);
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  await new Promise<void>(resolve => mixer.close(() => resolve()));
  await removeTempDir(base);
});

test('a pick the mixer says it can read goes out local, with no probe to chase', async () => {
  await proveLibraryMount();
  commands.length = 0;
  const item = pick();
  q.upcoming = [item];
  await queue.drainToLiquidsoap(true);

  assert.ok(handedOver().endsWith(`:${root}/${SONG}`), handedOver());
  assert.equal(item.resolveProbeId, undefined);
  assert.ok(commands.includes(`path_readable ${root}/${SONG}`), 'the mixer was asked about the pick itself');
});

test('a pick the mixer\'s copy lacks streams with a probe, though the mount is proven', async () => {
  const OTHER = 'Other/Album/01 - Elsewhere.flac';
  // Prove the mount using the known-readable song before adding the narrower
  // mixer-only miss. Otherwise findSample may choose OTHER as its sample and
  // the test starts with an unproven mount instead of exercising the per-pick check.
  await proveLibraryMount();
  assert.equal(libraryMountProven(root), true);
  put(join(root, OTHER));
  missing.add(join(root, OTHER));
  const item = pick(OTHER);
  q.upcoming = [item];
  await queue.drainToLiquidsoap(true);
  // A per-file miss schedules an asynchronous mount re-proof. Finish it before
  // the next test resets the shared mount state.
  await proveLibraryMount();

  const uri = handedOver();
  assert.match(uri, /:subhttp:http:\/\/drain-library\.invalid\/rest\/stream\?/);
  assert.ok(item.resolveProbeId, 'a probe id for verifyPushResolved');
  assert.ok(uri.endsWith(`#subwave_probe=${item.resolveProbeId}`), 'the URI carries the probe the queue will chase');
  assert.ok(q.djLog.some(e => e.message.includes(`the mixer did not confirm it can read ${root}/${OTHER}`)));
});

test('a proof lost while the write waits on the previous handoff streams the pick, probed', async () => {
  const PICK = 'Pick/Album/02 - Pick.flac';
  put(join(root, PICK));
  await proveLibraryMount();
  // Liquidsoap has not consumed the last handoff yet, so the write waits.
  writeFileSync(config.liquidsoap.queueFile, 'annotate:title="Previous":/previous.flac');
  const item: Pick = { ...pick(PICK), resolveProbeId: 'not decided yet' };
  q.upcoming = [item];
  const draining = queue.drainToLiquidsoap(true);
  // The mixer said yes to the pick and the drain decided local: no probe id.
  await waitFor(() => item.resolveProbeId === undefined);
  assert.ok(commands.includes(`path_readable ${root}/${PICK}`));

  reply = NO;
  await proveLibraryMount();
  rmSync(config.liquidsoap.queueFile);
  await draining;

  const uri = handedOver();
  assert.match(uri, /:subhttp:/, uri);
  assert.ok(item.resolveProbeId);
  assert.ok(uri.endsWith(`#subwave_probe=${item.resolveProbeId}`));
});

test('a station whose mount is not proven streams every pick and asks the mixer nothing', async () => {
  const item = pick();
  q.upcoming = [item];
  await queue.drainToLiquidsoap(true);

  assert.match(handedOver(), /:subhttp:/);
  assert.ok(item.resolveProbeId);
  assert.ok(!commands.some(c => c.startsWith('path_readable')), commands.join(', '));
});
