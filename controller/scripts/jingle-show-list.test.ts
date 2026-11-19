// The mixer-counted rotate draws from the on-air show's jingle list (#2367).
//
// jingles.m3u is that rotate's draw list, written only by jingles.ts
// rewritePlaylist through jingle-playlist-policy.ts; jingle-show-sync.ts decides
// which show: the on-air one after every roll and settings change, and the
// incoming one EARLY, once the outgoing show's confirmed final track is on air,
// so the stinger at the seam that ends that track is the incoming show's. A
// show swap reloads the mixer at once (no settle wait) and writes nothing when
// the bytes are unchanged, so a station without lists sees no new traffic.
//
// The mixer side (a swap between stingers drops the prepared clip) is
// scripts/liquidsoap-jingle-swap.py, against the real radio.liq in Docker.
// Run: npm test -- jingle-show-list

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor } from './test-utils/fixtures.js';
import type { SessionContext } from '../src/broadcast/session.js';

const root = createTempDir(join(tmpdir(), 'subwave-jingle-show-list-'));
process.env.STATE_DIR = root;

// A stand-in mixer. 'no-rotate' is a mixer whose rotate the controller owns
// (jingleRatio 0 on the mixer): it has no `jingles` playlist.
let reply: 'ok' | 'no-rotate' = 'ok';
const commands: string[] = [];
const mixer = createServer(socket => socket.once('data', data => {
  commands.push(data.toString().split('\n')[0].trim());
  socket.end(reply === 'ok' ? 'OK\r\nEND\r\n' : 'ERROR: unknown command, type "help" to get a list of commands.\r\nEND\r\n');
}));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

// The library: three jingles in sidecar order.
const LIBRARY = ['j_out.wav', 'j_in.wav', 'j_any.wav'];
mkdirSync(join(root, 'jingles'), { recursive: true });
for (const f of LIBRARY) writeFileSync(join(root, 'jingles', f), 'audio');
writeFileSync(join(root, 'jingles.json'), JSON.stringify({
  items: Object.fromEntries(LIBRARY.map(f => [f, { text: f }])),
}));

const settings = await import('../src/settings.js');
await settings.load();
const session = await import('../src/broadcast/session.js');
const jingles = await import('../src/broadcast/jingles.js');
const policy = await import('../src/broadcast/jingle-playlist-policy.js');
const sync = await import('../src/broadcast/jingle-show-sync.js');
const { getDateContext, getClockContext } = await import('../src/context.js');

const DIR = join(root, 'jingles');
const PLAYLIST = join(root, 'jingles.m3u');
const m3u = () => readFileSync(PLAYLIST, 'utf8');
const lines = (names: string[]) => names.map(n => `${DIR}/${n}\n`).join('');
// Every jingle in sidecar order; the boot ident check may have added its own.
const allKeys = () => Object.keys(JSON.parse(readFileSync(join(root, 'jingles.json'), 'utf8')).items);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => boolean, what: string, ms = 2000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail(`timed out: ${what}`);
    await pause(20);
  }
}

after(async () => {
  await new Promise<void>((resolve, reject) => mixer.close(err => err ? reject(err) : resolve()));
  await removeTempDir(root);
});

// ── the policy ───────────────────────────────────────────────────────────────

test('an empty or absent list is every jingle, in library order, as the file has always been', () => {
  assert.deepEqual(policy.rotatePlaylistFilenames(LIBRARY, undefined), LIBRARY);
  assert.deepEqual(policy.rotatePlaylistFilenames(LIBRARY, []), LIBRARY);
  // The bytes rewritePlaylist wrote before #2367, for the same keys.
  const before = LIBRARY.map(f => `/d/${f}`).join('\n') + '\n';
  assert.equal(policy.rotatePlaylistText('/d', policy.rotatePlaylistFilenames(LIBRARY, undefined)), before);
  assert.equal(policy.rotatePlaylistText('/d', []), '', 'no lines, no trailing newline');
});

test('a list is strict, and one that matches nothing leaves the file empty', () => {
  assert.deepEqual(policy.rotatePlaylistFilenames(LIBRARY, ['j_in.wav', 'gone.wav']), ['j_in.wav']);
  assert.deepEqual(policy.rotatePlaylistFilenames(LIBRARY, ['gone.wav']), []);
  assert.deepEqual(policy.rotatePlaylistView(LIBRARY, ['gone.wav']), { library: 3, playlist: 0, filtered: true });
  assert.deepEqual(policy.rotatePlaylistView(LIBRARY, undefined), { library: 3, playlist: 3, filtered: false });
});

// ── the writer ───────────────────────────────────────────────────────────────

test('with no list, a show change writes nothing and reloads nothing', async () => {
  await jingles.ensureDefaultIdent().catch(() => {}); // the boot rewrite, with no list set
  const bootBytes = m3u();
  await pause(jingles.RELOAD_SETTLE_MS + 300);
  commands.length = 0;
  assert.equal(await jingles.applyShowList(undefined), false);
  assert.equal(await jingles.applyShowList([]), false);
  assert.equal(m3u(), bootBytes);
  await pause(300);
  assert.deepEqual(commands, []);
});

test('a show swap writes the list and reloads at once; the same list again does nothing', async () => {
  commands.length = 0;
  assert.equal(await jingles.applyShowList(['j_out.wav']), true);
  assert.equal(m3u(), lines(['j_out.wav']));
  // Well inside RELOAD_SETTLE_MS: the swap does not wait for a batch to settle.
  await eventually(() => commands.length === 1, 'the immediate reload', jingles.RELOAD_SETTLE_MS / 2);
  assert.deepEqual(commands, ['jingles.reload']);
  assert.equal(await jingles.applyShowList(['j_out.wav']), false);
  await pause(300);
  assert.deepEqual(commands, ['jingles.reload'], 'idempotent on the written bytes');
});

test('a library edit keeps the on-air show\'s filter', async () => {
  await jingles.applyShowList(['j_out.wav']);
  const { filename } = await jingles.adopt(Buffer.from('audio'), { filename: 'j_new.wav' });
  assert.equal(m3u(), lines(['j_out.wav']), 'an unlisted upload stays out of the rotate');
  await jingles.remove(filename);
  assert.equal(m3u(), lines(['j_out.wav']));
});

test('a list that matches nothing writes an empty file, and the rotate skips', async () => {
  assert.equal(await jingles.applyShowList(['gone.wav']), true);
  assert.equal(m3u(), '');
  assert.deepEqual(await jingles.playlistView(), { library: allKeys().length, playlist: 0, filtered: true });
});

test('when the controller owns the rotate the reload is answered "unknown command" and nothing fails', async () => {
  reply = 'no-rotate';
  try {
    commands.length = 0;
    assert.equal(await jingles.applyShowList(['j_any.wav']), true);
    await eventually(() => commands.length === 1, 'the reload attempt');
    // The file still follows the show, so a later switch back to the mixer
    // (a mixer restart) starts from the right list.
    assert.equal(m3u(), lines(['j_any.wav']));
  } finally {
    reply = 'ok';
  }
});

// ── the wiring ───────────────────────────────────────────────────────────────

const template = settings.get().personas[0];
const TOM = { ...template, id: 'p_tom', name: 'Tom' };
const PROF = { ...template, id: 'p_prof', name: 'Prof' };
const OUT = { id: 's_out', name: 'Outgoing', topic: 'out', personaId: TOM.id, allowedJingles: ['j_out.wav'] };
const IN = { id: 's_in', name: 'Incoming', topic: 'in', personaId: PROF.id, allowedJingles: ['j_in.wav'] };
const FINAL = { id: 'final', title: 'Last Song', artist: 'Out Band' };
const OTHER = { id: 'other', title: 'Another Song', artist: 'Out Band' };

function context(show: { id: string; name: string } | null, atMs: number): SessionContext {
  return {
    at: new Date(atMs).toISOString(),
    time: { period: 'night', vibe: 'night', mood: 'calm', show: '' },
    weather: null, festival: null, dominantMood: 'calm',
    date: getDateContext(new Date(atMs)), clock: getClockContext(new Date(atMs)), listeners: { count: 1 },
    showHandover: null,
    activeShow: show ? { ...show, topic: '', moods: ['calm'] } : null,
  } as SessionContext;
}

// The outgoing show on air, the incoming one scheduled, its final track armed.
async function armedBoundary(incoming: typeof IN | null = IN) {
  sync._resetForTests();
  await settings.update({
    personas: [TOM, PROF], activePersonaId: TOM.id, shows: [OUT, IN], schedule: weekFor(OUT.id),
  } as never);
  const now = Date.now();
  session.start(context(OUT, now));
  sync.initJingleShowList();
  await sync.syncJingleShowList('test setup');
  await settings.update({ activePersonaId: PROF.id, schedule: weekFor(incoming?.id ?? null) } as never);
  assert.equal(session.armBoundaryHandoff(context(incoming, now + 5 * 60_000), FINAL), true);
  return now;
}

sync.startJingleShowSync();

test('boot takes the on-air show\'s list before the first write', async () => {
  await armedBoundary();
  sync.initJingleShowList();
  assert.deepEqual(jingles.currentShowList(), ['j_out.wav']);
  assert.equal(m3u(), lines(['j_out.wav']));
});

test('the boundary record names the incoming show', async () => {
  await armedBoundary();
  assert.equal(session.getSession()!.boundaryHandoff!.incomingShowId, IN.id);
});

test('the confirmed final outgoing track hands the rotate the incoming list, ahead of the roll', async () => {
  await armedBoundary();
  assert.equal(await sync.onMusicStarted(OTHER), false, 'any other track leaves the outgoing list');
  assert.equal(m3u(), lines(['j_out.wav']));
  commands.length = 0;
  assert.equal(await sync.onMusicStarted(FINAL), true);
  assert.equal(m3u(), lines(['j_in.wav']));
  await eventually(() => commands.includes('jingles.reload'), 'the immediate reload');
  // A settings save during the final track re-applies, and keeps the incoming list.
  await settings.update({ djHouseRules: 'a save mid-track' } as never);
  await pause(200);
  assert.equal(m3u(), lines(['j_in.wav']));
  // The roll lands on the same list: nothing is written or sent.
  commands.length = 0;
  await session.maybeRoll(context(IN, Date.now()));
  await pause(300);
  assert.equal(session.getSession()!.show?.id, IN.id);
  assert.deepEqual(sync.rotateShowList(), ['j_in.wav']);
  assert.equal(m3u(), lines(['j_in.wav']));
  assert.deepEqual(commands, [], 'the roll is an idempotent re-apply');
});

test('without an early swap, the roll applies the incoming list', async () => {
  await armedBoundary();
  await session.maybeRoll(context(IN, Date.now()));
  await eventually(() => m3u() === lines(['j_in.wav']), 'the roll applied the incoming list');
});

test('a boundary into autonomous radio hands the rotate every jingle', async () => {
  await armedBoundary(null);
  assert.equal(session.getSession()!.boundaryHandoff!.incomingShowId, null);
  assert.equal(await sync.onMusicStarted(FINAL), true);
  assert.equal(m3u(), lines(allKeys()));
});

test('a record armed before #2367 waits for the roll', async () => {
  await armedBoundary();
  delete session.getSession()!.boundaryHandoff!.incomingShowId;
  assert.equal(await sync.onMusicStarted(FINAL), false);
  assert.equal(m3u(), lines(['j_out.wav']));
});

test('a boundary called off during the final track falls back to the on-air show', async () => {
  await armedBoundary();
  assert.equal(await sync.onMusicStarted(FINAL), true);
  session.getSession()!.boundaryHandoff = null;
  assert.deepEqual(sync.rotateShowList(), ['j_out.wav']);
});

test('an edit to the on-air show\'s own list reaches the rotate with no roll', async () => {
  await armedBoundary();
  await settings.update({ shows: [{ ...OUT, allowedJingles: ['j_any.wav'] }, IN] } as never);
  await eventually(() => m3u() === lines(['j_any.wav']), 'the edited list');
  await settings.update({ shows: [{ ...OUT, allowedJingles: [] }, IN] } as never);
  await eventually(() => m3u() === lines(allKeys()), 'a cleared list is every jingle');
});

test('every music start offers the track on air to the jingle sync', async () => {
  const { queue } = await import('../src/broadcast/queue.js');
  const seen: unknown[] = [];
  const real = queue._onMusicStartedForJingles;
  const realRunner = queue.runArmedBoundaryHandoff;
  queue._onMusicStartedForJingles = (track => { seen.push(track); return Promise.resolve(false); }) as typeof real;
  queue.runArmedBoundaryHandoff = (async () => {}) as typeof realRunner;
  try {
    queue.onTrackStarted({ title: FINAL.title, artist: FINAL.artist, subsonic_id: FINAL.id, timestamp: Math.floor(Date.now() / 1000) } as never);
    assert.equal(seen.length, 1);
    assert.equal((seen[0] as { id: string }).id, FINAL.id);
  } finally {
    queue._onMusicStartedForJingles = real;
    queue.runArmedBoundaryHandoff = realRunner;
  }
});

// The pick cycle usually arms on the track ALREADY on air: its music start, the
// hook above, ran before the record existed. Seen live on the dev stack: armed
// five seconds into the final track, and the list changed only at the roll.
test('a pick cycle that arms on the on-air track hands over the incoming list at once', async () => {
  const { queue } = await import('../src/broadcast/queue.js');
  const realCurrent = queue.current;
  try {
    await armedBoundary();
    queue.current = { track: { ...FINAL }, startedAt: new Date().toISOString(), source: 'auto' } as never;
    assert.equal(queue.confirmOnAirJingleList(true, { track: { id: 'held' } } as never), false,
      'a held anchor (deadline path): its own start hands it over');
    assert.equal(queue.confirmOnAirJingleList(false, null), false, 'nothing armed this cycle');
    await pause(200);
    assert.equal(m3u(), lines(['j_out.wav']));
    commands.length = 0;
    assert.equal(queue.confirmOnAirJingleList(true, null), true);
    await eventually(() => m3u() === lines(['j_in.wav']), 'the incoming list, before the roll');
    await eventually(() => commands.includes('jingles.reload'), 'the immediate reload');
  } finally {
    queue.current = realCurrent;
  }
});

test('runPickCycle hands the list over straight after the arm, before the plan and the mic-pass', () => {
  const src = readFileSync(new URL('../src/broadcast/queue.ts', import.meta.url), 'utf8');
  const cycle = src.slice(src.indexOf('  runPickCycle('));
  const armAt = cycle.indexOf('session.armBoundaryHandoff(');
  const swapAt = cycle.indexOf('this.confirmOnAirJingleList(finalTrackHandoff, pickAnchorItem)');
  const planAt = cycle.indexOf('programme.prepareBoundaryPlan(');
  const micPassAt = cycle.indexOf('djAgent.runPersonaHandoff(');
  assert.ok(armAt > 0 && swapAt > armAt, 'after the arm');
  assert.ok(swapAt < planAt && swapAt < micPassAt, 'ahead of the awaited plan and render');
});
