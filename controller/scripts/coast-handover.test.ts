// The coast at the moment the DJ stops picking (#1975, #1992) — broadcast/coast-handover.ts,
// the queue moments that report it, and the scheduler rebuild it triggers.
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
// Three things stop picking (#1992): the listener gate, the daily token cap's
// hard tier and the operator's auto-pick switch. The edge is armed by a track
// the queue put on air STARTING, never by a pick cycle running: a capped cycle
// runs at every coast boundary and picks nothing. The token-cap test drives the
// REAL runPickCycle and runTrackEvent with the day's usage over the cap.
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
const { addDailyUsage } = await import('../src/llm/internal/telemetry/budget.js');

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

test('the handover edge fires once per stretch of held boundaries, and only after a queued track aired', () => {
  const edge = createHandoverEdge();
  assert.equal(edge.held(), false, 'a boot into an empty room has nothing to hand over');
  edge.aired();
  edge.aired();
  assert.equal(edge.held(), true, 'the first held boundary after the queue aired something');
  assert.equal(edge.held(), false, 'every coast track after it');
  assert.equal(edge.held(), false);
  edge.aired();
  assert.equal(edge.held(), true, 're-armed by the next queued track');
});

test('a pick cycle never arms the edge: only a queued track starting does', () => {
  const src = readFileSync(new URL('../src/broadcast/queue.ts', import.meta.url), 'utf8');
  const cycle = src.slice(src.indexOf('  runPickCycle({'), src.indexOf('  maybeDeadlinePick() {'));
  assert.ok(cycle.length > 0);
  assert.ok(!cycle.includes('this._coastHandover.aired()'), 'a capped cycle at every coast boundary would re-arm it');
  assert.equal(src.split('this._coastHandover.aired()').length - 1, 1, 'one arming site');
  const started = src.slice(src.indexOf('  onTrackStarted('), src.indexOf('    } else {\n      // Not a tracked request'));
  assert.ok(started.includes('this._coastHandover.aired();'), 'armed where a queued item is matched as it starts');
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
  assert.equal(await refreshCoastOnHandover('listeners'), false);
  assert.equal(libraryCalls, calls, 'no rebuild, so no fan-out');
  assert.deepEqual(coastIds(), built);

  // The DJ's last pick IS in the file: the coast would replay it.
  q.current = { track: byId(built[0]), source: 'ai' };
  assert.equal(await refreshCoastOnHandover('listeners'), true);
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
    const handover = refreshCoastOnHandover('listeners');
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
  // The real cycle runs the whole DJ agent, and never touches the edge (the
  // scrape above): the queued track starting is what arms it.
  q.runPickCycle = () => { picks++; };
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
    assert.equal(handovers, 2, 're-armed by the pick starting');
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
    q._coastHandover.aired(); // the on-air pick started from the queue
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

test('a dropped last pick past the re-pick budget still hands over when the gate holds', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: true } } as never);
  let handovers = 0;
  onCoastHandover(() => { handovers++; });
  const realRecovery = q._considerIdRotationRecovery;
  q._considerIdRotationRecovery = async () => {};
  // Three failures already in a row: this drop is the one past the budget.
  q._resolveFailStreak = 3;
  try {
    listenersNow = 0;
    await listeners.refresh();
    assert.equal(listeners.djCallsAllowed(), false);
    const [onAir, dropped] = catalogue;
    q.current = { track: onAir, source: 'ai' };
    const item = { track: dropped, aiPicked: true, sent: true };
    q.upcoming = [item];
    q._coastHandover.aired();
    q.onPushResolveFailed(item);
    assert.equal(q._resolveFailStreak, 4);
    assert.equal(handovers, 1, 'the coast takes over when the track on air ends, budget or not');
  } finally {
    q._considerIdRotationRecovery = realRecovery;
    q._resolveFailStreak = 0;
    listenersNow = 1;
    await listeners.refresh();
    await refreshAutoPlaylist();
    reset();
  }
});

// Records what the queue reports, with why.
function handoverRecorder() {
  const reasons: string[] = [];
  onCoastHandover(reason => { reasons.push(reason); });
  return reasons;
}
const startQueued = (song: Song, extra: Record<string, unknown> = { aiPicked: true }) => {
  q.upcoming = [{ track: song, sent: true, ...extra }];
  queue.onTrackStarted({ subsonic_id: song.id, title: song.title, artist: song.artist } as never);
};
const startCoast = (song: Song) =>
  queue.onTrackStarted({ subsonic_id: song.id, title: song.title, artist: song.artist } as never);

test('the daily token cap hands over at the capped cycle after a queued track starts, once per stretch', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: false, dailyTokenCap: 1000 }, shows: [], scheduleOverride: null } as never);
  addDailyUsage(5000);
  listenersNow = 1;
  await listeners.refresh();
  assert.equal(listeners.djCallsAllowed(), true, 'the room is not why picking stops');
  const reasons = handoverRecorder();
  assert.equal(await refreshAutoPlaylist(), 'refreshed');
  const built = coastIds();
  const cycleDone = () => waitFor(() => !q.pickerBusy);
  try {
    // The DJ's last pick (in the coast) starts; its cycle is the real one, and
    // runTrackEvent makes no model call at the hard cap.
    startQueued(byId(built[0]));
    assert.equal(q.pickerBusy, true, 'the gate is open, so the cycle still runs');
    await cycleDone();
    assert.equal(q.upcoming.length, 0, 'capped: nothing queued');
    assert.deepEqual(reasons, ['token-cap'], 'the coast takes over when this track ends');
    assert.ok(q.djLog.some((e: { message: string }) => e.message.includes('daily LLM token cap reached')));
    await waitFor(() => !coastIds().includes(built[0]));
    assert.match(handoverLogs()[0].message, /DJ picks paused \(daily token cap reached\) — fallback holds 1 track\(s\)/);

    // Every coast boundary runs another capped cycle; none of them re-arms.
    const after1 = coastIds();
    for (const id of after1.slice(0, 3)) {
      startCoast(byId(id));
      await cycleDone();
    }
    assert.deepEqual(reasons, ['token-cap'], 'one check per stretch, not one per capped cycle');

    // A request can still reach the queue under the cap (llm.exemptRequests):
    // the queue put it on air, so the capped cycle at its start checks again.
    startQueued(byId(after1[3]), { requestedBy: 'Sam' });
    await cycleDone();
    assert.deepEqual(reasons, ['token-cap', 'token-cap']);
  } finally {
    await settings.update({ llm: { dailyTokenCap: 0 } } as never);
    await waitFor(() => !q.pickerBusy);
    await refreshAutoPlaylist();
    reset();
  }
});

test('a capped cycle with a held anchor leaves the handover to that anchor', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: false, dailyTokenCap: 1000 }, shows: [], scheduleOverride: null } as never);
  addDailyUsage(5000);
  listenersNow = 1;
  await listeners.refresh();
  const reasons = handoverRecorder();
  const [onAir, held] = catalogue;
  try {
    q.current = { track: onAir, source: 'ai', startedAt: new Date().toISOString() };
    q._coastHandover.aired();
    const anchor = { track: held, aiPicked: true, sent: false };
    q.upcoming = [anchor];
    // The pair-drain deadline pick for what follows the held track.
    q.runPickCycle({ isAutonomous: true, pickAnchorItem: anchor });
    await waitFor(() => !q.pickerBusy);
    assert.deepEqual(reasons, [], 'the held track still airs before the coast');
  } finally {
    await settings.update({ llm: { dailyTokenCap: 0 } } as never);
    reset();
  }
});

test('auto-pick off hands over where the last queued track starts, and at the switch when nothing is queued', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: false }, shows: [], scheduleOverride: null } as never);
  listenersNow = 1;
  await listeners.refresh();
  const reasons = handoverRecorder();
  const realCycle = q.runPickCycle;
  let picks = 0;
  q.runPickCycle = () => { picks++; };
  const [a, b, c, d, e] = catalogue;
  try {
    assert.equal(await refreshAutoPlaylist(), 'refreshed');
    // Off with a track still queued: the operator's own queue plays out first.
    q.current = { track: a, source: 'ai' };
    q.upcoming = [{ track: b, aiPicked: true, sent: true }];
    queue.setAutoPick(false);
    assert.deepEqual(reasons, []);
    startQueued(b);
    assert.equal(picks, 0, 'no pick with auto-pick off');
    assert.deepEqual(reasons, ['auto-pick-off'], 'the last queued track is on air; the coast follows it');
    startCoast(c);
    assert.deepEqual(reasons, ['auto-pick-off'], 'no second check for the coast\'s own tracks');

    // A studio push under the operator's hand arms it again.
    startQueued(d, { requestedBy: 'studio', operator: true });
    assert.deepEqual(reasons, ['auto-pick-off', 'auto-pick-off']);

    // Back on, a pick that starts and finds no successor (its cycle failed)...
    queue.setAutoPick(true);
    startQueued(e);
    assert.equal(picks, 1);
    // ...is already the last thing queued when the switch goes off: no boundary
    // comes before the coast, so the switch reports it.
    queue.setAutoPick(false);
    assert.deepEqual(reasons, ['auto-pick-off', 'auto-pick-off', 'auto-pick-off']);
    queue.setAutoPick(false);
    assert.equal(reasons.length, 3, 'once per stretch');
    assert.equal(queue.autoPick, false);
  } finally {
    q.runPickCycle = realCycle;
    queue.setAutoPick(true);
    await refreshAutoPlaylist();
    reset();
  }
});

test('auto-pick off rebuilds the coast only when it holds what the operator aired', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: false }, shows: [], scheduleOverride: null } as never);
  listenersNow = 1;
  await listeners.refresh();
  queue.setAutoPick(false);
  try {
    assert.equal(await refreshAutoPlaylist(), 'refreshed');
    const built = coastIds();
    const outside = catalogue.find(s => !built.includes(s.id))!;
    const calls = libraryCalls;
    const reasons = handoverRecorder();
    const logs = handoverLogs().length;
    startQueued(outside, { requestedBy: 'studio', operator: true });
    // The handover fires and the check runs, synchronously: a rebuild would
    // have written its booth line before its first await.
    assert.deepEqual(reasons, ['auto-pick-off'], 'the operator\'s queue ran dry: the coast is checked');
    assert.equal(handoverLogs().length, logs, 'and found clean, so no refresh is requested');
    // Give a rebuild that started anyway the same chance to reach Navidrome.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(libraryCalls, calls, 'clean coast: no rebuild under the operator\'s hand');
    assert.deepEqual(coastIds(), built);

    startQueued(byId(built[0]), { requestedBy: 'studio', operator: true });
    await waitFor(() => !coastIds().includes(built[0]));
    assert.match(handoverLogs()[0].message, /DJ picks paused \(auto-pick off\) — fallback holds \d+ track\(s\)/);
  } finally {
    queue.setAutoPick(true);
    await refreshAutoPlaylist();
    reset();
  }
});

test('a dropped push with auto-pick off is the handover moment too', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: false } } as never);
  listenersNow = 1;
  await listeners.refresh();
  const reasons = handoverRecorder();
  const realRecovery = q._considerIdRotationRecovery;
  q._considerIdRotationRecovery = async () => {};
  const realCycle = q.runPickCycle;
  let picks = 0;
  q.runPickCycle = () => { picks++; };
  q._resolveFailStreak = 0;
  try {
    const [onAir, dropped] = catalogue;
    q.current = { track: onAir, source: 'request' };
    q._coastHandover.aired();
    const item = { track: dropped, requestedBy: 'studio', operator: true, sent: true };
    q.upcoming = [item];
    queue.setAutoPick(false);
    assert.deepEqual(reasons, [], 'still queued at the switch');
    q.onPushResolveFailed(item);
    assert.equal(picks, 0, 'no re-pick with auto-pick off');
    assert.deepEqual(reasons, ['auto-pick-off']);
  } finally {
    q._considerIdRotationRecovery = realRecovery;
    q.runPickCycle = realCycle;
    q._resolveFailStreak = 0;
    queue.setAutoPick(true);
    await refreshAutoPlaylist();
    reset();
  }
});

// The recovered pick is modelled, not recovered: queue.recover() also arms a
// reconcile timer and the handoff fallbacks. What matters is the branch it
// reaches, a queued item matched as it starts with no cycle behind it in this
// process, which is the same branch whoever queued the item.
test('a request and a pick no cycle here made, airing into an empty room, arm the edge; a coast track does not', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: true } } as never);
  const reasons = handoverRecorder();
  const [a, b, c, d] = catalogue;
  try {
    listenersNow = 0;
    await listeners.refresh();
    assert.equal(listeners.djCallsAllowed(), false);
    // A request into the empty room: no pick cycle ever ran.
    startQueued(a, { requestedBy: 'Sam' });
    assert.deepEqual(reasons, ['listeners']);
    startCoast(b);
    assert.deepEqual(reasons, ['listeners']);

    // A pick recovered from queue.json: a fresh process, so a fresh edge that
    // starts unarmed, and no cycle in it picked the item.
    q._coastHandover = createHandoverEdge();
    startCoast(c);
    assert.deepEqual(reasons, ['listeners'], 'a boot into an empty room has nothing to hand over');
    startQueued(d);
    assert.deepEqual(reasons, ['listeners', 'listeners'], 'the recovered pick airing is what the coast can hold');
  } finally {
    listenersNow = 1;
    await listeners.refresh();
    await refreshAutoPlaylist();
    reset();
  }
});

test('a cycle in flight when picking stops hands over as it ends without a pick', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: true }, shows: [], scheduleOverride: null } as never);
  listenersNow = 1;
  await listeners.refresh();
  const reasons = handoverRecorder();
  // The cycle's last step before the pick, past all of its awaits: throwing
  // there ends the real cycle with no pick, at a point the test controls.
  const realConfirm = q.confirmOnAirBoundaryHandoff;
  q.confirmOnAirBoundaryHandoff = () => { throw new Error('no pick this cycle'); };
  const [a, b, c, d] = catalogue;
  try {
    // Gate open: a pick that failed is not picking stopping.
    startQueued(a);
    assert.equal(q.pickerBusy, true);
    await waitFor(() => !q.pickerBusy);
    assert.deepEqual(reasons, [], 'the next boundary picks again');

    // Switched off while B's cycle is in flight. The switch cannot report it
    // (a pick may still land), and no queued track is left to start.
    startQueued(b);
    assert.equal(q.pickerBusy, true);
    queue.setAutoPick(false);
    assert.deepEqual(reasons, []);
    await waitFor(() => !q.pickerBusy);
    assert.deepEqual(reasons, ['auto-pick-off'], 'reported as the cycle ends, before the first coast track');
    startCoast(c);
    assert.deepEqual(reasons, ['auto-pick-off'], 'once per stretch');
    queue.setAutoPick(true);

    // The room empties while D's cycle is in flight. runPickCycle never reads
    // the gate, so a cycle started into a room already empty stands for it.
    q.current = { track: d, source: 'ai' };
    q.upcoming = [];
    q._coastHandover.aired();
    listenersNow = 0;
    await listeners.refresh();
    q.runPickCycle({ isAutonomous: true });
    await waitFor(() => !q.pickerBusy);
    assert.deepEqual(reasons, ['auto-pick-off', 'listeners']);
  } finally {
    q.confirmOnAirBoundaryHandoff = realConfirm;
    queue.setAutoPick(true);
    listenersNow = 1;
    await listeners.refresh();
    await refreshAutoPlaylist();
    reset();
  }
});

test('a dropped last push past the re-pick budget hands over at the hard cap', async () => {
  reset();
  await settings.update({ llm: { pauseWhenEmpty: false, dailyTokenCap: 0 }, shows: [], scheduleOverride: null } as never);
  listenersNow = 1;
  await listeners.refresh();
  const reasons = handoverRecorder();
  const realRecovery = q._considerIdRotationRecovery;
  q._considerIdRotationRecovery = async () => {};
  const realCycle = q.runPickCycle;
  let picks = 0;
  q.runPickCycle = () => { picks++; };
  const [onAir, dropped] = catalogue;
  // A request is the push a capped station still queues (llm.exemptRequests).
  const dropLastPush = () => {
    // Three failures already in a row: this drop is the one past the budget.
    q._resolveFailStreak = 3;
    q.current = { track: onAir, source: 'request' };
    q._coastHandover.aired();
    const item = { track: dropped, requestedBy: 'Sam', sent: true };
    q.upcoming = [item];
    q.onPushResolveFailed(item);
    assert.equal(q._resolveFailStreak, 4);
    assert.equal(picks, 0, 'past the budget: no re-pick');
  };
  try {
    // No cap: picking has not stopped, and the next boundary picks again.
    dropLastPush();
    assert.deepEqual(reasons, []);

    // At the hard cap, no capped cycle runs to report it.
    await settings.update({ llm: { dailyTokenCap: 1000 } } as never);
    addDailyUsage(5000);
    dropLastPush();
    assert.deepEqual(reasons, ['token-cap']);
  } finally {
    q._considerIdRotationRecovery = realRecovery;
    q.runPickCycle = realCycle;
    q._resolveFailStreak = 0;
    await settings.update({ llm: { dailyTokenCap: 0 } } as never);
    await refreshAutoPlaylist();
    reset();
  }
});

test('onPushResolveFailed asks one gate, with the re-pick budget inside its open arm', () => {
  const src = readFileSync(new URL('../src/broadcast/queue.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('  onPushResolveFailed(item: QueueItem) {'), src.indexOf('  async reconcileWithDjQueue() {'));
  assert.ok(fn.length > 0);
  assert.equal(fn.split('this.pickGateClosed()').length - 1, 1, 'one gate');
  assert.ok(!fn.includes('djCallsAllowed()') && !fn.includes('this.autoPick'), 'the gate is not restated');
  const closedArm = fn.indexOf('this.handOverToCoast(closed)');
  const repickArm = fn.indexOf('} else if (repick) {');
  const cappedArm = fn.indexOf('} else if (!picksAllowed()) {');
  assert.ok(closedArm > 0 && repickArm > closedArm, 'the budget test sits in the open arm');
  // The cap is dj-budget's call, made after the re-pick that would report it.
  assert.ok(cappedArm > repickArm, 'past the budget, the cap is asked of dj-budget');
  assert.ok(!/dailyTokenCap|budgetMode|currentMode|dailyTokensUsed/.test(fn), 'no cap policy inline');
  assert.equal(fn.split('this.handOverToCoast(').length - 1, 2, 'a closed gate and the cap past the budget');
});
