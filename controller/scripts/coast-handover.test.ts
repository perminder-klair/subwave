// The coast at the moment the DJ stops picking (#1975) — broadcast/coast-handover.ts,
// the queue boundary that reports it, and the scheduler rebuild it triggers.
//
// THE DEFECT. With `llm.pauseWhenEmpty` the DJ stops picking when the room
// empties and the station coasts on auto.m3u until the next rebuild, up to an
// hour away. A full rotation's coast (#1919) is the rotation's longest-waiting
// half, and both pickers take its most overdue track, so every DJ pick after a
// rebuild is the head of that file: a mid-hour departure coasted on a file in
// which up to ~15 of ~32 tracks had just aired.
//
// The chain test drives the REAL queue.onTrackStarted with the listener gate
// closed by a real (stubbed-Icecast) poll, and the REAL refreshAutoPlaylist
// against a stubbed Navidrome, a temp library.db and a fake mixer.
//
// Run: npm test -- coast-handover

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const root = mkdtempSync(join(tmpdir(), 'subwave-coast-handover-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://coast-library.invalid';
process.env.ICECAST_STATUS_URL = 'http://coast-icecast.invalid/status-json.xsl';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
const mixer = createServer(socket => socket.once('data', () => socket.end('OK\nEND\n')));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const listeners = await import('../src/broadcast/listeners.js');
const { queue } = await import('../src/broadcast/queue.js');
const { refreshAutoPlaylist, refreshCoastOnHandover } = await import('../src/broadcast/scheduler.js');
const { coastContents, coastRepeats, createHandoverEdge, onCoastHandover } = await import('../src/broadcast/coast-handover.js');

type Song = { id: string; title: string; artist: string; duration: number };
const songs = (prefix: string, n: number): Song[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i + 1}`, title: `${prefix} ${i + 1}`, artist: `${prefix} Artist ${i + 1}`, duration: 240,
  }));
const rotation = songs('rot', 109);
const catalogue = songs('lib', 60);
let listenersNow = 1;
let libraryCalls = 0;
// Holds a build at its catalogue fetch, after it has read the air history.
let randomSongs: Song[] = catalogue;
let holdRandom: Promise<void> | null = null;
let reachedRandom: () => void = () => {};

const realFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  if (url.hostname === 'coast-icecast.invalid') {
    return Response.json({ icestats: { source: [{ listenurl: 'http://coast-icecast.invalid/stream.mp3', listeners: listenersNow }] } });
  }
  assert.equal(url.hostname, 'coast-library.invalid', 'no live service calls');
  libraryCalls++;
  const endpoint = url.pathname.split('/').at(-1);
  if (endpoint === 'getRandomSongs' && holdRandom) {
    reachedRandom();
    await holdRandom;
  }
  const data = endpoint === 'getPlaylists' ? { playlists: { playlist: [{ id: 'rotation', name: 'rotation' }] } }
    : endpoint === 'getPlaylist' ? { playlist: { entry: url.searchParams.get('id') === 'rotation' ? rotation : [] } }
      : endpoint === 'getRandomSongs' ? { randomSongs: { song: randomSongs } }
        : endpoint === 'getAlbumList2' ? { albumList2: { album: [] } }
          : endpoint === 'getStarred2' ? { starred2: { song: [] } } : {};
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
};
const q = queue as any;
after(async () => {
  globalThis.fetch = realFetch;
  if (q._persistTimer) clearTimeout(q._persistTimer);
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  library.shutdown();
  await new Promise<void>(resolve => mixer.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const coastIds = () => readFileSync(join(root, 'auto.m3u'), 'utf8').split('\n')
  .filter(line => line.includes('subsonic_id='))
  .map(line => line.match(/subsonic_id="([^"]+)"/)![1]);
const byId = (id: string) => [...rotation, ...catalogue].find(s => s.id === id)!;
const handoverLogs = () => q.djLog.filter((e: { message: string }) => e.message.includes('DJ picks paused'));
async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const reset = () => {
  q._recentPlays = [];
  q.history = [];
  q.current = null;
  q.upcoming = [];
  q.lastSeenKey = null;
  q.djLog = [];
};
// A play the queue put on air, written the way onTrackStarted writes one.
const airedFromQueue = (song: Song) => {
  const endedAt = new Date().toISOString();
  q.history.unshift({ track: song, source: 'ai', startedAt: endedAt, endedAt });
  q._recentPlays.unshift({ id: song.id, title: song.title, artist: song.artist, endedAt });
};

await settings.load();
await library.load();

test('coastRepeats counts aired tracks the coast holds, by id or by title|artist', () => {
  const coast = coastContents([
    { id: 'a', title: 'Alpha', artist: 'One' },
    { id: 'b', title: 'Beta', artist: 'Two' },
  ], 1000);
  assert.equal(coast.builtAt, 1000);
  assert.equal(coastRepeats(coast, []), 0);
  assert.equal(coastRepeats(coast, [{ id: 'x', title: 'Other', artist: 'Three' }]), 0);
  assert.equal(coastRepeats(coast, [{ id: 'a', title: 'Alpha', artist: 'One' }]), 1);
  // A duplicate rip of a coast track is the same song to a listener.
  assert.equal(coastRepeats(coast, [{ id: 'b-rip', title: 'beta ', artist: 'TWO' }]), 1);
  assert.equal(coastRepeats(coast, [{ id: 'a' }, { title: 'Beta', artist: 'Two' }, { id: 'x' }]), 2);
});

test('the handover edge fires once per stretch of held boundaries, and only after a pick', () => {
  const edge = createHandoverEdge();
  assert.equal(edge.held(), false, 'a boot into an empty room has nothing to hand over');
  edge.picked();
  edge.picked();
  assert.equal(edge.held(), true, 'the first held boundary after picking');
  assert.equal(edge.held(), false, 'every coast track after it');
  assert.equal(edge.held(), false);
  edge.picked();
  assert.equal(edge.held(), true, 're-armed by the next pick');
});

test('every pick cycle arms the edge, and only the held branch of the auto-DJ gate fires it', () => {
  const src = readFileSync(new URL('../src/broadcast/queue.ts', import.meta.url), 'utf8');
  const cycle = src.slice(src.indexOf('  runPickCycle({'), src.indexOf('  maybeDeadlinePick() {'));
  assert.ok(cycle.indexOf('this._coastHandover.picked();') > 0, 'runPickCycle arms the edge');
  assert.ok(cycle.indexOf('this._coastHandover.picked();') < cycle.indexOf('(async () => {'),
    'armed synchronously, before the pick can fail or be awaited');
  assert.match(src, /if \(djCallsAllowed\(\)\) this\.runPickCycle\(\{ isAutonomous \}\);\n(\s*\/\/.*\n)*\s*else if \(this\._coastHandover\.held\(\)\) notifyCoastHandover\(\);/);
});

test('a coast holding none of what the queue aired is left alone, at no Navidrome cost', async () => {
  reset();
  await settings.update({ shows: [], scheduleOverride: null } as never);
  assert.equal(await refreshAutoPlaylist(), 'refreshed');
  const built = coastIds();
  assert.ok(built.length >= 30, 'a sampled coast from the catalogue');
  const outside = catalogue.filter(s => !built.includes(s.id));
  airedFromQueue(outside[0]);
  q.current = { track: outside[1], source: 'ai' };
  const calls = libraryCalls;
  assert.equal(await refreshCoastOnHandover(), false);
  assert.equal(libraryCalls, calls, 'no rebuild, so no fan-out');
  assert.deepEqual(coastIds(), built);

  // The DJ's last pick IS in the file: the coast would replay it.
  q.current = { track: byId(built[0]), source: 'ai' };
  assert.equal(await refreshCoastOnHandover(), true);
  assert.ok(!coastIds().includes(built[0]), 'the on-air pick steps out of the rebuilt coast');
  reset();
});

test('a build already in flight when picking stops cannot vouch for the file it lands', async () => {
  reset();
  await settings.update({ shows: [], scheduleOverride: null } as never);
  assert.equal(await refreshAutoPlaylist(), 'refreshed');
  const built = coastIds();
  // The DJ's last picks, outside the file on disk: that stamp alone says "clean".
  const outside = catalogue.filter(s => !built.includes(s.id));
  const pick = outside[0];
  const others = outside.slice(1, 8);
  q.current = { track: others[0], source: 'ai' };
  q.upcoming = [{ track: pick, aiPicked: true, sent: true }];

  // The hourly rebuild reads the history while the pick is still only queued,
  // which a default build does not exclude, then waits on the catalogue.
  randomSongs = [pick, ...others.slice(1)];
  let release!: () => void;
  holdRandom = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { reachedRandom = resolve; });
  const hourly = refreshAutoPlaylist({ automatic: true });
  try {
    await Promise.race([reached, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('the build never reached its catalogue fetch')), 5000).unref())]);
    // The pick reaches air and the gate holds the next one.
    airedFromQueue(others[0]);
    q.current = { track: pick, source: 'ai' };
    q.upcoming = [];
    const handover = refreshCoastOnHandover();
    holdRandom = null;
    release();
    assert.equal(await hourly, 'refreshed');
    assert.equal(await handover, true, 'rebuilt behind the build in flight');
    assert.ok(!coastIds().includes(pick.id), 'the on-air pick is not left in the coast that lands');
    assert.match(handoverLogs()[0].message, /in flight/);
  } finally {
    holdRandom = null;
    release();
    randomSongs = catalogue;
    reset();
  }
});

test('a full rotation rebuilds at the boundary where the listener gate stops the DJ', async () => {
  reset();
  const now = Date.now();
  await settings.update({
    llm: { pauseWhenEmpty: true },
    shows: [{ id: 's_rotation', name: 'Rotation', personaId: settings.get().personas[0].id, playlistIds: ['rotation'], playlistStrict: true, playlistExhaust: true }],
    scheduleOverride: { showId: 's_rotation', startedAt: now - 60_000, expiresAt: now + 3600_000 },
  } as never);
  assert.equal(await refreshAutoPlaylist(), 'refreshed');
  const before = coastIds();
  assert.equal(before.length, 32, 'the longest-waiting half, capped');

  let handovers = 0;
  onCoastHandover(() => { handovers++; });
  const realCycle = q.runPickCycle;
  let picks = 0;
  // The real cycle runs the whole DJ agent. Its first effect on the edge is
  // pinned by the scrape above; this stands in for it.
  q.runPickCycle = () => { picks++; q._coastHandover.picked(); };
  const start = (song: Song, picked = true) => {
    if (picked) q.upcoming = [{ track: song, aiPicked: true, sent: true }];
    queue.onTrackStarted({ subsonic_id: song.id, title: song.title, artist: song.artist } as never);
  };
  try {
    listenersNow = 1;
    await listeners.refresh();
    assert.equal(listeners.djCallsAllowed(), true);
    // Both pickers take the most overdue track: the head of the coast.
    start(byId(before[0]));
    start(byId(before[1]));
    assert.equal(picks, 2);
    assert.equal(handovers, 0);

    // The room empties while the DJ's last pick is queued.
    listenersNow = 0;
    await listeners.refresh();
    assert.equal(listeners.djCallsAllowed(), false);
    start(byId(before[2]));
    assert.equal(picks, 2, 'the gate held the pick');
    assert.equal(handovers, 1, 'picking stopped here');
    await waitFor(() => !coastIds().includes(before[2]));
    const after1 = coastIds();
    for (const id of before.slice(0, 3)) assert.ok(!after1.includes(id), `${id} aired from the queue and leaves the coast`);
    assert.match(handoverLogs()[0].message, /holds 3 track\(s\) aired since it was built/);

    // The coast's own tracks: no second handover however long the room stays empty.
    start(byId(after1[0]), false);
    start(byId(after1[1]), false);
    assert.equal(handovers, 1);
    assert.equal(picks, 2);

    // A listener comes back for one pick and leaves again: one more check.
    listenersNow = 1;
    await listeners.refresh();
    start(byId(after1[2]), false);
    assert.equal(picks, 3);
    listenersNow = 0;
    await listeners.refresh();
    start(byId(after1[3]));
    assert.equal(handovers, 2, 're-armed by the pick');
  } finally {
    q.runPickCycle = realCycle;
    listenersNow = 1;
    await listeners.refresh();
    // Let any rebuild still in flight land before the temp dir goes.
    await refreshAutoPlaylist();
    reset();
  }
});

test('a dropped last pick hands over too, when the listener gate holds its re-pick', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: true } } as never);
  let handovers = 0;
  onCoastHandover(() => { handovers++; });
  const realRecovery = q._considerIdRotationRecovery;
  q._considerIdRotationRecovery = async () => {};
  q._resolveFailStreak = 0;
  try {
    listenersNow = 0;
    await listeners.refresh();
    assert.equal(listeners.djCallsAllowed(), false);
    const [onAir, dropped] = catalogue;
    q.current = { track: onAir, source: 'ai' };
    const item = { track: dropped, aiPicked: true, sent: true };
    q.upcoming = [item];
    q._coastHandover.picked(); // the cycle that picked it
    // Liquidsoap never resolved it, and nothing is queued behind it.
    q.onPushResolveFailed(item);
    assert.equal(q.upcoming.length, 0);
    assert.equal(handovers, 1, 'the coast takes over when the track on air ends');
    // The next boundary is a coast track: no second handover.
    queue.onTrackStarted({ subsonic_id: catalogue[2].id, title: catalogue[2].title, artist: catalogue[2].artist } as never);
    assert.equal(handovers, 1);
  } finally {
    q._considerIdRotationRecovery = realRecovery;
    q._resolveFailStreak = 0;
    listenersNow = 1;
    await listeners.refresh();
    // Let any rebuild still in flight land before the temp dir goes.
    await refreshAutoPlaylist();
    reset();
  }
});
