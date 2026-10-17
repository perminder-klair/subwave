// #1976: the Show editor's genre suggestions average every embedded track's
// text vector per genre. At 150k tracks that walk took 3.2 s in one synchronous
// call, and its cache key (stats.updatedAt:vectorCount) moved with every
// tagger batch, so each open during a tagging run stalled every other request
// for seconds. The contracts pinned here:
//
//   - the walk runs in slices, each stopping on a track boundary, and returns
//     what the original single statement returned (kept here as the reference)
//     however small the slices are;
//   - the tracks rowid range drives the slice's loop, never a sort, with and
//     without ANALYZE, so resuming a slice does not re-read the library;
//   - genreSuggest() hands the event loop back between slices;
//   - an unchanged library is answered from cache, and so is a changed one
//     inside the refresh floor; past the floor the last result is answered at
//     once and one walk re-reads the library behind it;
//   - a reopened library is never answered with the previous handle's result.
//
// Real better-sqlite3 DB in a temp STATE_DIR. Run: `npm test -- genre-suggest`.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-genre-suggest-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { genreSuggest, genreSuggestIdle, GENRE_SUGGEST_REFRESH_FLOOR_MS } = await import('../src/music/genre-suggest.js');
await db.open({ embeddingDim: 4 });
await library.load();
after(() => {
  library.shutdown();
  rmSync(stateDir, { recursive: true, force: true });
});
const d = () => db.requireDb();

// Every shape json_each sees: multi-genre rows, a blank and a padded genre, a
// genre repeated within one track (counted twice, as json_each yields it
// twice), empty and NULL arrays, and tracks with no vector.
const genresFor = (i: number): string | null => {
  switch (i % 10) {
    case 0: return null;
    case 1: return '[]';
    case 2: return JSON.stringify(['  ', 'Jazz']);
    case 3: return JSON.stringify(['Jazz', 'Jazz']);
    case 4: return JSON.stringify([' Soul ']);
    default: return JSON.stringify([`G${i % 4}`, `G${(i + 1) % 4}`]);
  }
};
// Inserted out of id order, so rowid order is not id order.
for (const i of Array.from({ length: 60 }, (_, k) => (k * 37) % 60)) {
  const id = `t${String(i).padStart(2, '0')}`;
  db.upsertTrackMeta(id, { title: id, artist: `Artist ${i % 7}`, genres: [] });
  d().prepare('UPDATE tracks SET genres = ? WHERE id = ?').run(genresFor(i), id);
  if (i % 3 !== 0) db.upsertTrackTags(id, { moods: ['calm'], energy: 'low', source: 'manual' });
  if (i % 7 !== 0) db.upsertTrackVector(id, [Math.sin(i), Math.cos(i), (i % 5) / 5, 1], null);
}

const ORIGINAL_SQL = `SELECT je.value AS genre, v.embedding AS embedding
       FROM tracks t
       JOIN track_vectors v ON v.id = t.id, json_each(t.genres) je
      WHERE je.value IS NOT NULL AND TRIM(je.value) != ''`;

// The pre-#1976 genreCentroids(), one statement start to finish.
function originalCentroids(): Map<string, { count: number; centroid: Float32Array }> {
  const sums = new Map<string, { sum: Float64Array; count: number }>();
  let dim = 0;
  for (const row of d().prepare(ORIGINAL_SQL).iterate() as Iterable<{ genre: string; embedding: Buffer }>) {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    if (!dim) dim = vec.length;
    let acc = sums.get(row.genre);
    if (!acc) sums.set(row.genre, (acc = { sum: new Float64Array(dim), count: 0 }));
    for (let i = 0; i < dim; i++) acc.sum[i] += vec[i];
    acc.count++;
  }
  return new Map([...sums].map(([genre, { sum, count }]) => [genre, { count, centroid: Float32Array.from(sum, (x) => x / count) }]));
}

function assertSameCentroids(actual: Array<{ genre: string; count: number; centroid: Float32Array }>, label: string) {
  const ref = originalCentroids();
  assert.deepEqual(actual.map((c) => c.genre).sort(), [...ref.keys()].sort(), `${label}: genres`);
  for (const c of actual) {
    const want = ref.get(c.genre)!;
    assert.equal(c.count, want.count, `${label}: ${c.genre} count`);
    c.centroid.forEach((x, i) => assert.ok(Math.abs(x - want.centroid[i]) < 1e-6, `${label}: ${c.genre}[${i}]`));
  }
}

const walkSql = (sql: string) => /json_each\(t\.genres\)/.test(sql);

// Every SQL a call prepares, through the real prepare.
async function preparedBy(t: { mock: typeof test.mock }, fn: () => Promise<unknown>): Promise<string[]> {
  const spy = t.mock.method(d(), 'prepare');
  try {
    await fn();
    return spy.mock.calls.map((c) => String(c.arguments[0]));
  } finally {
    spy.mock.restore();
  }
}

test('the sliced walk returns what the original single statement returned', () => {
  assertSameCentroids(db.genreCentroids(), 'one call');
  // A zero budget ends every slice after its first track: the smallest slices there are.
  const acc = db.newGenreVectorSums();
  const resumedAfter: number[] = [];
  for (let at: number | null = db.GENRE_WALK_START; at !== null;) {
    at = db.addGenreVectors(acc, at, 0);
    if (at !== null) resumedAfter.push(at);
  }
  assertSameCentroids(db.centroidsOf(acc), 'one-track slices');
  const contributing = (d().prepare(
    `SELECT COUNT(DISTINCT t.rowid) AS n FROM tracks t
       JOIN track_vectors v ON v.id = t.id, json_each(t.genres) je
      WHERE je.value IS NOT NULL AND TRIM(je.value) != ''`,
  ).get() as { n: number }).n;
  assert.equal(resumedAfter.length, contributing - 1, 'one slice per contributing track');
  assert.ok(resumedAfter.every((r, i) => i === 0 || r > resumedAfter[i - 1]), 'slices move forward');
  const ref = originalCentroids();
  // Five tracks carry Jazz once and six carry it twice.
  assert.equal(ref.get('Jazz')!.count, 17, 'a genre repeated within a track counts twice, as before');
  assert.ok(ref.has(' Soul ') && !ref.has('  '), 'blank genres skipped, padded ones kept verbatim');
});

for (const analyzed of [false, true]) {
  test(`each slice starts at its rowid and never sorts${analyzed ? ' (after ANALYZE)' : ''}`, async (t) => {
    d().exec('SAVEPOINT plans');
    try {
      if (analyzed) d().exec('ANALYZE');
      const sqls = (await preparedBy(t, async () => db.addGenreVectors(db.newGenreVectorSums(), db.GENRE_WALK_START, 0)))
        .filter(walkSql);
      assert.equal(sqls.length, 1);
      const plan = (d().prepare(`EXPLAIN QUERY PLAN ${sqls[0]}`).all(db.GENRE_WALK_START) as Array<{ detail: string }>)
        .map((r) => r.detail);
      assert.match(plan[0], /^SEARCH t USING INTEGER PRIMARY KEY \(rowid>\?\)$/, plan.join(' ; '));
      assert.ok(!plan.some((p) => /TEMP B-TREE/.test(p)), plan.join(' ; '));
    } finally {
      d().exec('ROLLBACK TO plans');
      d().exec('RELEASE plans');
    }
  });
}

test('genreSuggest() hands the event loop back between slices', async (t) => {
  await library.reload(); // a fresh handle, so the next call walks
  // Every row overruns the slice budget, so every track is its own slice.
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock += 1_000));
  let ticks = 0;
  let walking = true;
  const tick = () => {
    ticks++;
    if (walking) setImmediate(tick);
  };
  setImmediate(tick);
  const result = await genreSuggest();
  walking = false;
  t.mock.restoreAll();
  const tracks = (d().prepare(
    `SELECT COUNT(DISTINCT t.rowid) AS n FROM tracks t
       JOIN track_vectors v ON v.id = t.id, json_each(t.genres) je
      WHERE je.value IS NOT NULL AND TRIM(je.value) != ''`,
  ).get() as { n: number }).n;
  assert.ok(ticks >= tracks, `the loop turned ${ticks} times during a ${tracks}-slice walk`);
  assert.equal(result.hasEmbeddings, true);
  for (const genre of [' Soul ', 'G0', 'G1', 'G2', 'G3', 'Jazz']) {
    assert.ok(result.related[genre], `${genre} has a centroid`);
  }
});

test('an unchanged library, and a changed one inside the floor, are answered without a walk', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await library.reload();
  const first = await genreSuggest();
  let answer: unknown;
  const unchanged = await preparedBy(t, async () => { answer = await genreSuggest(); });
  assert.strictEqual(answer, first);
  assert.deepEqual(unchanged.filter(walkSql), [], 'no walk on an unchanged library');
  db.upsertTrackMeta('fresh', { title: 'Fresh', artist: 'New', genres: ['Fresh Genre'] });
  db.upsertTrackVector('fresh', [1, 1, 1, 1], null);
  t.mock.timers.tick(GENRE_SUGGEST_REFRESH_FLOOR_MS - 1);
  const inside = await preparedBy(t, async () => {
    answer = await genreSuggest();
    await genreSuggestIdle();
  });
  assert.strictEqual(answer, first, 'inside the floor the last result stands');
  assert.deepEqual(inside.filter(walkSql), [], 'and no walk starts');
});

test('past the floor the last result is answered at once and one walk re-reads behind it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await library.reload();
  const stale = await genreSuggest();
  db.upsertTrackMeta('later', { title: 'Later', artist: 'New', genres: ['Later Genre'] });
  db.upsertTrackVector('later', [1, 0, 1, 0], null);
  t.mock.timers.tick(GENRE_SUGGEST_REFRESH_FLOOR_MS);
  const answers: unknown[] = [];
  const sqls = await preparedBy(t, async () => {
    answers.push(await genreSuggest(), await genreSuggest());
    await genreSuggestIdle();
  });
  assert.deepEqual(answers, [stale, stale], 'both requests get the last result without waiting');
  assert.strictEqual(answers[0], stale);
  // The fixture fits in one slice, so one walk prepares the slice SQL once.
  assert.equal(sqls.filter(walkSql).length, 1, 'the second request joined the walk the first one started');
  const fresh = await genreSuggest();
  assert.notStrictEqual(fresh, stale);
  assert.ok(fresh.genres.some((g) => g.value === 'Later Genre'), 'the walk saw the write');
  assert.ok(!stale.genres.some((g) => g.value === 'Later Genre'));
});

test('a failed re-read keeps the last result and waits out the floor', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await library.reload();
  const last = await genreSuggest();
  const warn = t.mock.method(console, 'warn', () => {});
  const handle = d();
  const prepare = handle.prepare.bind(handle);
  const failing = t.mock.method(handle, 'prepare', (sql: string) => {
    if (walkSql(sql)) throw new Error('disk I/O error');
    return prepare(sql);
  });
  db.upsertTrackMeta('changed', { title: 'Changed', artist: 'New', genres: ['Changed Genre'] });
  t.mock.timers.tick(GENRE_SUGGEST_REFRESH_FLOOR_MS);
  assert.strictEqual(await genreSuggest(), last);
  await genreSuggestIdle();
  assert.equal(warn.mock.callCount(), 1, 'the failure is logged');
  assert.match(String(warn.mock.calls[0].arguments[0]), /\[genre-suggest\] refresh failed: disk I\/O error/);
  const attempts = failing.mock.calls.filter((c) => walkSql(String(c.arguments[0]))).length;
  assert.strictEqual(await genreSuggest(), last, 'the last result stands');
  await genreSuggestIdle();
  assert.equal(
    failing.mock.calls.filter((c) => walkSql(String(c.arguments[0]))).length,
    attempts,
    'no retry inside the floor',
  );
});

test('a reopened library is never answered with the previous handle\'s result', async (t) => {
  await library.reload();
  const before = await genreSuggest();
  await library.reload();
  const reopened = await preparedBy(t, async () => {
    assert.notStrictEqual(await genreSuggest(), before, 'a new handle waits for its own walk');
  });
  assert.ok(reopened.some(walkSql));

  // A walk in flight when the handle is swapped stops rather than mixing two
  // libraries, and a request on the new handle does not wait on it.
  await library.reload();
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock += 1_000));
  const doomed = genreSuggest();
  await new Promise((resolve) => setImmediate(resolve));
  const reloading = library.reload();
  const next = genreSuggest();
  await assert.rejects(doomed, /library reopened during the genre walk/);
  await reloading;
  const answer = await next;
  t.mock.restoreAll();
  assert.equal(answer.hasEmbeddings, true);
  assert.ok(answer.genres.some((g) => g.value === 'Jazz'));
});
