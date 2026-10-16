// Issue #1911: DJ-mode mini-runs and their sonic journeys follow the show on air.
//
// The reported failure: a run that started on the previous host's last track
// was still the run on the next host's first picks (module state cleared only
// by running out or DJ mode going off), and its journey headed for the CLAP
// centroid of a random high/low energy bucket — a lane one show's brief
// excluded. The contracts pinned here:
//   - a change of the show a pick is FOR ends the active run, and no new run
//     starts on that pick; the next pick may start one;
//   - autonomous blocks share one run identity, so a daypart soft shift keeps
//     the run, as it keeps the session;
//   - a journey started inside a show heads for that show's own tracks
//     (playlist anchor, else its music filters applied hard, minus exclusions);
//   - a show that cannot be placed in the library (a brief alone) gets the
//     tempo/key run but no journey;
//   - with no show on air the destination is still the daypart energy bucket.
//
// Real better-sqlite3 library in a temp STATE_DIR. Run: `npm test -- journey-follows-show`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-journey-show-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const runs = await import('../src/broadcast/dj-agent/runs.js');
const { showDestinationPool, destinationOrder, journeyDestinationIds } = await import('../src/music/journey-destination.js');
const { energyForDaypart } = await import('../src/context.js');

after(() => rmSync(stateDir, { recursive: true, force: true }));

await db.open({ embeddingDim: 8, adoptStoredDim: true });

// Three orthogonal directions in the 512-d CLAP space: the jazz shelf, the rock
// shelf, and the track on air. A centroid of one shelf IS that shelf's axis, so
// the destination (the last waypoint) says exactly where a journey was headed.
const DIM = 512;
const axis = (i: number) => { const v = new Float32Array(DIM); v[i] = 1; return v; };
const JAZZ = axis(0);
const ROCK = axis(1);
const START = axis(2);

for (let i = 0; i < 10; i++) {
  const jazz = `jazz${i}`;
  db.upsertTrackMeta(jazz, { title: `Blue ${i}`, artist: `Quartet ${i}`, album: 'Late Set', year: 1961, genres: ['Jazz'], duration: 300 });
  db.upsertTrackTags(jazz, { moods: ['calm'], energy: 'low', source: 'llm' } as never);
  db.upsertTrackAudioVector(jazz, JAZZ);
  const rock = `rock${i}`;
  db.upsertTrackMeta(rock, { title: `Anthem ${i}`, artist: `Arena ${i}`, album: 'Stadium', year: 1986, genres: ['Rock'], duration: 240 });
  db.upsertTrackTags(rock, { moods: ['energetic'], energy: 'high', source: 'llm' } as never);
  db.upsertTrackAudioVector(rock, ROCK);
}
// Outside both shows' eras, untagged: never part of a destination.
db.upsertTrackMeta('start', { title: 'Hook', artist: 'Pop Act', album: 'Single', year: 1975, genres: ['Pop'], duration: 200 });
db.upsertTrackAudioVector('start', START);
await library.load();

// bpm rides on the track object: library.bpmKeyFor falls back to it when the
// row carries no analysis, which is all the run-start gate needs.
const onAir = { id: 'start', title: 'Hook', artist: 'Pop Act', bpm: 120 };

const JAZZ_SHOW = { id: 'jazz-hour', name: 'Jazz Hour', eras: [{ fromYear: 1950, toYear: 1969 }] };
const ROCK_SHOW = { id: 'arena', name: 'Arena', eras: [{ fromYear: 1980, toYear: 1989 }] };
const BRIEF_ONLY = { id: 'talk', name: 'Late Talk', topic: 'quiet conversation music' };

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

type Show = Parameters<typeof journeyDestinationIds>[0];

// Clear any run and record `show` as the previous pick's show, so each test
// starts from a known place in the module's state.
async function reset(show: Show) {
  await runs.advanceRun(false, null, { show });
}

// Walk a whole run (Math.random pinned to 0: it always starts, and lasts the
// start pick plus one), returning every step.
async function walkRun(show: Show) {
  const first = await runs.advanceRun(true, onAir, { show });
  const steps = [first];
  while (runs.runActive()) steps.push(await runs.advanceRun(true, onAir, { show }));
  return steps;
}

test('a show change ends the active run, and the changeover pick starts none', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  await reset(JAZZ_SHOW);
  const started = await runs.advanceRun(true, onAir, { show: JAZZ_SHOW });
  assert.ok(started.rankTarget, 'the run starts inside the outgoing show');
  assert.equal(runs.runActive(), true);

  const changeover = await runs.advanceRun(true, onAir, { show: ROCK_SHOW });
  assert.deepEqual(changeover, { rankTarget: null, audioWaypoint: null, endedForShow: true },
    'the first pick of the incoming show is not a step of the outgoing arc');
  assert.equal(runs.runActive(), false);

  const next = await runs.advanceRun(true, onAir, { show: ROCK_SHOW });
  assert.ok(next.rankTarget, 'the next pick of the new show may start its own run');
  assert.equal(next.endedForShow, undefined);
});

test('a changeover pick with no run going reports nothing ended and starts nothing', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  await reset(JAZZ_SHOW);
  const changeover = await runs.advanceRun(true, onAir, { show: null });
  assert.deepEqual(changeover, { rankTarget: null, audioWaypoint: null });
  assert.equal(runs.runActive(), false);
});

test('an in-order show between two autonomous stretches ends the autonomous run', async (t) => {
  // The in-order walk never calls advanceRun. Without notePickShow, the run
  // left going when the show began resumed on the first autonomous pick after
  // it: same 'auto' key on both sides, so nothing looked like a change.
  t.mock.method(Math, 'random', () => 0);
  await reset(null);
  const started = await runs.advanceRun(true, onAir, { show: null });
  assert.ok(started.rankTarget);
  assert.equal(runs.runActive(), true, 'a run is going as the in-order show starts');

  runs.notePickShow({ id: 'in-order-hour' });
  runs.notePickShow({ id: 'in-order-hour' });
  assert.equal(runs.runActive(), false, 'the walked show ends the autonomous run');

  const back = await runs.advanceRun(true, onAir, { show: null });
  assert.deepEqual(back, { rankTarget: null, audioWaypoint: null },
    'the first autonomous pick after the show is a changeover pick, not the old run');
  assert.ok((await runs.advanceRun(true, onAir, { show: null })).rankTarget, 'the next pick may start a fresh run');
});

test('a walked pick inside the run\'s own show leaves the run alone', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  await reset(JAZZ_SHOW);
  await runs.advanceRun(true, onAir, { show: JAZZ_SHOW });
  runs.notePickShow(JAZZ_SHOW);
  assert.equal(runs.runActive(), true);
});

test('autonomous blocks share one run identity, so a run keeps going without a show', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  await reset(null);
  assert.equal(runs.runShowKey(null), runs.runShowKey(undefined));
  assert.equal(runs.runShowKey({ id: 'x' }), 'show:x');
  const steps = await walkRun(null);
  assert.equal(steps.length, 2, 'start pick plus one more, uninterrupted');
  assert.ok(steps.every(step => step.rankTarget && !step.endedForShow));
});

test('a journey started inside a show heads for that show, not an energy bucket', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  for (const [show, home, away] of [[JAZZ_SHOW, JAZZ, ROCK], [ROCK_SHOW, ROCK, JAZZ]] as const) {
    await reset(show);
    const steps = await walkRun(show);
    const destination = steps.at(-1)!.audioWaypoint;
    assert.ok(destination, `${show.name}: a journey attached`);
    assert.ok(dot(destination!, home) > 0.999, `${show.name}: the arc lands on the show's own shelf`);
    assert.ok(Math.abs(dot(destination!, away)) < 1e-6, `${show.name}: and nowhere near the other one`);
  }
});

test('a show the library cannot place gets the tempo/key run but no journey', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  await reset(BRIEF_ONLY);
  const steps = await walkRun(BRIEF_ONLY);
  assert.ok(steps[0].rankTarget, 'the mini-run itself still plays');
  assert.ok(steps.every(step => step.audioWaypoint === null), 'but nothing steers toward a guess');
});

test('with no show on air the destination is still the daypart energy bucket', async (t) => {
  t.mock.method(Math, 'random', () => 0);
  await reset(null);
  const steps = await walkRun(null);
  const destination = steps.at(-1)!.audioWaypoint!;
  const expected = energyForDaypart().speed >= 1 ? ROCK : JAZZ;  // high bucket = rock fixture
  assert.ok(dot(destination, expected) > 0.999, 'autonomous radio is unchanged by #1911');
});

test('excluded playlists drop out of a show destination; a fully excluded show has none', () => {
  const rows = library.candidateFilterTracks();
  const show = { eras: [{ fromYear: 1950, toYear: 1969 }] };
  const all = showDestinationPool({ show, playlistTracks: null, libraryRows: () => rows, resolvedGenres: [], excludedIds: null })!;
  assert.deepEqual(all.map(r => r.id).sort(), Array.from({ length: 10 }, (_, i) => `jazz${i}`).sort());
  const some = showDestinationPool({ show, playlistTracks: null, libraryRows: () => rows, resolvedGenres: [], excludedIds: new Set(['jazz0', 'jazz1']) })!;
  assert.equal(some.length, 8);
  assert.ok(!some.some(r => r.id === 'jazz0' || r.id === 'jazz1'));
  const none = showDestinationPool({ show, playlistTracks: null, libraryRows: () => rows, resolvedGenres: [], excludedIds: new Set(all.map(r => r.id!)) });
  assert.equal(none, null);
});

test('soft and strict shows are both placed by their filters, applied hard', () => {
  const rows = library.candidateFilterTracks();
  for (const filtersStrict of [false, true]) {
    const byGenre = showDestinationPool({ show: { genres: ['jazz'], filtersStrict }, playlistTracks: null, libraryRows: () => rows, resolvedGenres: ['Jazz'], excludedIds: null })!;
    assert.ok(byGenre.length && byGenre.every(r => r.id!.startsWith('jazz')), `genre lock, strict=${filtersStrict}`);
    const byMood = showDestinationPool({ show: { moods: ['energetic'], filtersStrict }, playlistTracks: null, libraryRows: () => rows, resolvedGenres: [], excludedIds: null })!;
    assert.ok(byMood.length && byMood.every(r => r.id!.startsWith('rock')), `mood lock, strict=${filtersStrict}`);
  }
  // A genre that resolved to no library tag is OFF, as on the pick paths, so a
  // genre-only show with nothing resolved is a show that cannot be placed.
  assert.equal(showDestinationPool({ show: { genres: ['Polka'] }, playlistTracks: null, libraryRows: () => rows, resolvedGenres: [], excludedIds: null }), null);
  // No filters at all (a brief alone): no destination, and no library read.
  let read = false;
  assert.equal(showDestinationPool({ show: {}, playlistTracks: null, libraryRows: () => { read = true; return rows; }, resolvedGenres: [], excludedIds: null }), null);
  assert.equal(read, false);
});

test('a dimension the library has no data for is not a lock', () => {
  // Same rows with the mood tags stripped: a mood-only show would otherwise
  // read as "nothing in this show" rather than "this show cannot be placed".
  const untagged = library.candidateFilterTracks().map(r => ({ ...r, moods: [], audioMoods: [] }));
  assert.equal(showDestinationPool({ show: { moods: ['calm'] }, playlistTracks: null, libraryRows: () => untagged, resolvedGenres: [], excludedIds: null }), null);
  const withEra = showDestinationPool({ show: { moods: ['calm'], eras: [{ fromYear: 1980, toYear: 1989 }] }, playlistTracks: null, libraryRows: () => untagged, resolvedGenres: [], excludedIds: null })!;
  assert.ok(withEra.length && withEra.every(r => r.id!.startsWith('rock')), 'the covered dimension still places it');
});

test('a resolved playlist anchor is the show\'s sound, minus exclusions', () => {
  const rows = library.candidateFilterTracks();
  const playlist = rows.filter(r => r.id === 'rock3' || r.id === 'jazz4' || r.id === 'jazz5');
  let read = false;
  const pool = showDestinationPool({
    show: { playlistIds: ['pl1'], eras: [{ fromYear: 1950, toYear: 1969 }] },
    playlistTracks: playlist,
    libraryRows: () => { read = true; return rows; },
    resolvedGenres: [],
    excludedIds: new Set(['jazz5']),
  })!;
  // A soft-filter show keeps its whole playlist (airableAnchorTracks applies
  // the locks for a strict show only); the exclusion still drops.
  assert.deepEqual(pool.map(r => r.id).sort(), ['jazz4', 'rock3']);
  assert.equal(read, false, 'the full-library projection is never read when the anchor answers');
  const strict = showDestinationPool({
    show: { playlistIds: ['pl1'], filtersStrict: true, eras: [{ fromYear: 1950, toYear: 1969 }] },
    playlistTracks: playlist, libraryRows: () => rows, resolvedGenres: [], excludedIds: null,
  })!;
  assert.deepEqual(strict.map(r => r.id).sort(), ['jazz4', 'jazz5']);
});

test('the daypart energy bucket leads inside the show, the rest of the show follows', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const rows = library.candidateFilterTracks().filter(r => r.id !== 'start');
  const order = destinationOrder(rows, 'high');
  assert.equal(order.length, 20);
  assert.ok(order.slice(0, 10).every(id => id.startsWith('rock')), 'preferred energy first');
  assert.ok(order.slice(10).every(id => id.startsWith('jazz')), 'then the rest, not dropped');
});

test('journeyDestinationIds keeps the autonomous energy bucket and places a show', async () => {
  const auto = await journeyDestinationIds(null, 'low');
  assert.deepEqual([...auto!].sort(), library.idsByEnergy('low').sort());
  const show = await journeyDestinationIds({ eras: [{ fromYear: 1980, toYear: 1989 }] }, 'low');
  assert.ok(show!.length === 10 && show!.every(id => id.startsWith('rock')), 'the show wins over the daypart bucket');
  assert.equal(await journeyDestinationIds({ id: 'brief-only' }, 'low'), null);
});

test('the Shortlist\'s run, journey and favourites steers defer to the brief only with a show on air', async () => {
  const { shortlistPickPrompt, FAVOURITES_INSIDE_SHOW } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
  const context = {
    journeyActive: true,
    mixRun: { bpm: 120, key: '8A' },
    listenerFavourites: [{ title: 'Anthem 1', artist: 'Arena 1', likes: 3 }],
  } as never;
  const autonomous = shortlistPickPrompt([], context);
  assert.equal(shortlistPickPrompt([], context, { showOnAir: false }), autonomous, 'no show: the prompt is unchanged');
  assert.match(autonomous, /If none fits, keep its energy direction\./);
  assert.ok(!autonomous.includes(FAVOURITES_INSIDE_SHOW));

  const inShow = shortlistPickPrompt([], context, { showOnAir: true });
  assert.doesNotMatch(inShow, /keep its energy direction/, '"same energy" is no reason to leave the show');
  assert.match(inShow, /The brief outranks the arc/);
  assert.match(inShow, /The show's brief outranks the run\./);
  assert.ok(inShow.includes(FAVOURITES_INSIDE_SHOW), 'a favourite is a lean inside the brief');

  const shortlistSource = readFileSync(new URL('../src/broadcast/dj-agent/shortlist-pick.ts', import.meta.url), 'utf8');
  assert.match(shortlistSource, /prompt: shortlistPickPrompt\(candidates, context, \{ showOnAir: !!settings\.resolveActiveShow\(showAt \?\? undefined\) \}\)/,
    'the live Shortlist pick resolves the show on the pick\'s own clock');
  const agentSource = readFileSync(new URL('../src/broadcast/dj-agent.ts', import.meta.url), 'utf8');
  assert.match(agentSource, /shortlistPickPrompt\(\[\.\.\.seen\.values\(\)\], selectionContext, \{ showOnAir: !!settings\.resolveActiveShow\(showAt \?\? undefined\) \}\)/,
    'and so does its corrective re-pick');
});

test('the Agentic pick event names favourites as a lean inside the show, and only with one on', () => {
  const source = readFileSync(new URL('../src/broadcast/dj-agent.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function runTrackEvent('));
  assert.match(body, /const favShowClause = favClause && pickShow \? FAVOURITES_INSIDE_SHOW : '';/);
  assert.match(body, /\$\{favClause\}\$\{favShowClause\}/);
});

test('runTrackEvent resolves the pick\'s show on the brief\'s clock and hands it to the run', () => {
  const source = readFileSync(new URL('../src/broadcast/dj-agent.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function runTrackEvent('));
  assert.match(body, /const pickShow = settings\.resolveActiveShow\(showAt \?\? undefined\);/);
  assert.match(body, /await timePhase\('pick\.advanceRun', \(\) => advanceRun\(djMode, pickAnchor, \{ show: pickShow \}\)\)/);
  assert.match(body, /if \(await pickInOrder\([^)]*\)\) \{\s*notePickShow\(settings\.resolveActiveShow\(showAt \?\? undefined\)\);\s*return;/,
    'an in-order pick records the show it was for');
});
