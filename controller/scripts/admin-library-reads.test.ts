// #1937: on a 150k-track library the admin console's library reads were each a
// full scan of the wide `tracks` rows (kilobytes of analysis JSON apiece), run
// synchronously on the controller's event loop and repeated by polls, so a
// Library page during a tagging run starved every other request. The
// contracts pinned here:
//
//   - the coverage counts and stats() read covering indexes, never the wide
//     rows, and still do once ANALYZE has written planner statistics;
//   - every rewritten read returns exactly what the original SQL returned
//     (the originals are kept here as references);
//   - stats() and the coverage DB counts are reused while changeToken() is
//     unchanged, and a commit from ANY connection (the tagger child is
//     another process) forces a recount — coverage is never staler than a
//     fresh read, stats() never staler than its old 5 s TTL;
//   - the browse page is paged by id and returns the same rows, in the same
//     order, as the original `SELECT *` sort.
//
// Real better-sqlite3 DB in a temp STATE_DIR. Run: `tsx scripts/admin-library-reads.test.ts`.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-admin-reads-'));
process.env.STATE_DIR = stateDir;
// coverage.get() probes the analysis backend once; give it nowhere to go.
process.env.ANALYZE_URL = 'http://127.0.0.1:9';

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const coverage = await import('../src/music/library-coverage.js');
await library.load();
const d = db.requireDb();

const MOODS = ['calm', 'dark', 'warm', 'night'];
const SOURCES = ['llm', 'propagated', 'manual', null];
const ENERGIES = ['low', 'medium', 'high', null];
for (let i = 0; i < 400; i++) {
  const id = `t${String(i).padStart(3, '0')}`;
  // Duplicate artist/album/title groups so the browse sort has real ties.
  const artist = i % 50 === 0 ? '   ' : i % 9 === 0 ? ` Artist ${i % 30} ` : `artist ${i % 30}`;
  db.upsertTrackMeta(id, {
    title: i % 4 === 0 ? 'Same Title' : `Song ${i}`,
    artist,
    album: `Album ${i % 6}`,
    year: 1970 + (i % 50),
    genres: i % 7 === 0 ? [] : [`Genre ${i % 5}`, `Genre ${(i + 2) % 8}`],
    duration: 200,
  });
  if (i % 5 !== 0) {
    db.upsertTrackTags(id, {
      moods: [MOODS[i % 4], MOODS[(i + 1) % 4]],
      energy: ENERGIES[i % 4] ?? undefined,
      source: SOURCES[i % 4] ?? undefined,
    } as never);
  }
  // Rows whose moods are '[]' are uncertainty results, not tags.
  if (i % 11 === 0) d.prepare(`UPDATE tracks SET moods = '[]' WHERE id = ?`).run(id);
  d.prepare(
    `UPDATE tracks SET bpm = ?, vocal_ranges_json = ?, analyze_fail_count = ?, tagged_at = ? WHERE id = ?`,
  ).run(
    i % 3 === 0 ? null : 90 + (i % 60),
    i % 4 === 0 ? null : i % 4 === 1 ? '[]' : '[{"startMs":0,"endMs":30000}]',
    [null, 0, 1, 2, 3, 5][i % 6],
    i % 5 !== 0 ? `2026-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z` : null,
    id,
  );
  if (i % 3 === 0) db.upsertTrackAudioVector(id, new Float32Array(512).fill(0.1));
}
db.invalidateStats();

const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
const planOf = (sql: string) =>
  (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(r => r.detail).join(' ; ');

// Every SQL a call prepares, through the real prepare.
function preparedBy(t: { mock: typeof test.mock }, fn: () => void): string[] {
  const spy = t.mock.method(d, 'prepare');
  try {
    fn();
    return spy.mock.calls.map(c => String(c.arguments[0]));
  } finally {
    spy.mock.restore();
  }
}

// A full read of the wide rows is a `SCAN tracks` that is not a covering-index scan.
const WIDE_SCAN = /\bSCAN tracks\b(?! USING COVERING INDEX)/;

// The original single-pass computeStats() totals, the reference for the split.
function originalStats() {
  const H = 'moods IS NOT NULL AND json_array_length(moods) > 0';
  const totals = d.prepare(`
    SELECT COUNT(*) AS mirrorTotal,
           COUNT(*) FILTER (WHERE ${H}) AS total,
           COUNT(DISTINCT LOWER(TRIM(artist))) FILTER (
             WHERE ${H} AND artist IS NOT NULL AND TRIM(artist) != ''
           ) AS distinctArtists,
           MAX(tagged_at) FILTER (WHERE ${H}) AS updatedAt
      FROM tracks`).get() as Record<string, unknown>;
  return { ...totals, updatedAt: totals.updatedAt || null };
}

test('every rewritten count returns what the original SQL returned', () => {
  assert.equal(db.analysedCount(), count('SELECT COUNT(*) AS n FROM tracks WHERE bpm IS NOT NULL'));
  assert.equal(db.vocalAnalyzedCount(), count('SELECT COUNT(*) AS n FROM tracks WHERE vocal_ranges_json IS NOT NULL'));
  assert.equal(
    db.analysisFailedCount(),
    count('SELECT COUNT(*) AS n FROM tracks WHERE COALESCE(analyze_fail_count, 0) >= 3'),
  );
  assert.ok(db.vocalAnalyzedCount() > 0 && db.analysisFailedCount() > 0, 'the fixture exercises both');
  db.invalidateStats();
  const s = db.stats();
  const ref = originalStats();
  assert.deepEqual(
    { mirrorTotal: s.mirrorTotal, total: s.total, distinctArtists: s.distinctArtists, updatedAt: s.updatedAt },
    ref,
  );
  assert.ok(s.total < s.mirrorTotal, 'untagged rows stay out of total');
});

test('an empty library keeps the original totals (zeros and a null updatedAt)', () => {
  d.exec('SAVEPOINT empty');
  try {
    d.exec('DELETE FROM tracks');
    db.invalidateStats();
    const s = db.stats();
    assert.deepEqual(
      { mirrorTotal: s.mirrorTotal, total: s.total, distinctArtists: s.distinctArtists, updatedAt: s.updatedAt },
      originalStats(),
    );
    assert.equal(s.updatedAt, null);
  } finally {
    d.exec('ROLLBACK TO empty');
    d.exec('RELEASE empty');
    db.invalidateStats();
  }
});

for (const analyzed of [false, true]) {
  test(`the coverage counts and stats() never read the wide rows${analyzed ? ' (after ANALYZE)' : ''}`, (t) => {
    d.exec('SAVEPOINT plans');
    try {
      if (analyzed) d.exec('ANALYZE');
      db.invalidateStats();
      const sqls = preparedBy(t, () => {
        db.analysedCount();
        db.vocalAnalyzedCount();
        db.analysisFailedCount();
        library.countTagged();
        db.stats();
      }).filter(sql => /\bFROM tracks\b/.test(sql));
      assert.ok(sqls.length >= 9, `captured the reads (${sqls.length})`);
      for (const sql of sqls) {
        const plan = planOf(sql);
        assert.doesNotMatch(plan, WIDE_SCAN, `${sql.replace(/\s+/g, ' ').trim()}\n  → ${plan}`);
      }
    } finally {
      d.exec('ROLLBACK TO plans');
      d.exec('RELEASE plans');
      db.invalidateStats();
    }
  });
}

test('stats() is reused past its TTL while nothing has committed, and recounted after a write', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  db.invalidateStats();
  const first = db.stats();
  t.mock.timers.tick(60_000);
  const aggregates = preparedBy(t, () => assert.equal(db.stats(), first, 'unchanged library: the cached object'))
    .filter(sql => /\bFROM tracks\b/.test(sql));
  assert.deepEqual(aggregates, [], 'no aggregate ran');

  db.upsertTrackMeta('later', { title: 'Later', artist: 'New', album: 'B', duration: 200 });
  assert.equal(db.stats().mirrorTotal, first.mirrorTotal + 1, 'a committed write forces the recount');
  d.prepare(`DELETE FROM tracks WHERE id = 'later'`).run();
  db.invalidateStats();
});

test('a commit from another connection (the tagger child) also forces the recount', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  db.invalidateStats();
  const first = db.stats();
  const other = new Database(join(stateDir, 'library.db'));
  try {
    other.prepare(`INSERT INTO tracks (id, title, artist) VALUES ('child', 'From the tagger', 'Child')`).run();
  } finally {
    other.close();
  }
  t.mock.timers.tick(5_001);
  assert.equal(db.stats().mirrorTotal, first.mirrorTotal + 1);
  d.prepare(`DELETE FROM tracks WHERE id = 'child'`).run();
  db.invalidateStats();
});

test('a rival writer during the one-time index build does not fail open()', (t) => {
  // The first open after an upgrade builds these over the whole table; a
  // second process opening meanwhile waits out the busy timeout on that
  // build's write lock. Shortened here so the test does not sit for 5 s.
  const NEW = ['idx_tracks_analysed', 'idx_tracks_vocal_measured', 'idx_tracks_fail_count', 'idx_tracks_stats'];
  const present = () => (d.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${NEW.map(() => '?').join(', ')})`,
  ).all(...NEW) as Array<{ name: string }>).map(r => r.name).sort();
  for (const name of NEW) d.exec(`DROP INDEX ${name}`);
  const expected = db.analysedCount();
  const warn = t.mock.method(console, 'warn', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const logged = () => log.mock.calls.map(c => String(c.arguments[0]));
  const rival = new Database(join(stateDir, 'library.db'));
  d.pragma('busy_timeout = 50');
  try {
    rival.exec('BEGIN IMMEDIATE');
    assert.doesNotThrow(() => db.ensureStatsIndexes(), 'a locked build is skipped, not thrown');
    assert.deepEqual(present(), [], 'nothing was built under the lock');
    assert.equal(warn.mock.callCount(), 1, 'and the skip is logged');
    assert.deepEqual(
      logged(), ['[library-db] building count indexes (one-time, 4 missing)…'],
      'the build announced itself and never claimed to finish',
    );
    assert.equal(db.analysedCount(), expected, 'counts stay exact without the index');
  } finally {
    if (rival.inTransaction) rival.exec('ROLLBACK');
    rival.close();
    d.pragma('busy_timeout = 5000');
  }
  log.mock.resetCalls();
  db.ensureStatsIndexes();
  assert.deepEqual(present(), [...NEW].sort(), 'the next open builds them');
  assert.equal(logged().length, 2);
  assert.match(logged()[1] ?? '', /^\[library-db\] count indexes built in \d+ms$/);
  log.mock.resetCalls();
  db.ensureStatsIndexes();
  assert.deepEqual(logged(), [], 'an open that finds them all builds and logs nothing');
});

test('coverage counts are reused only while the library is unchanged', async (t) => {
  const before = await coverage.get();
  // Unchanged: the second read runs no count at all.
  const spy = t.mock.method(d, 'prepare');
  const again = await coverage.get();
  const counts = spy.mock.calls.map(c => String(c.arguments[0])).filter(sql => /COUNT\(\*\)/.test(sql));
  spy.mock.restore();
  assert.deepEqual(counts, [], 'an unchanged library recounts nothing');
  assert.equal(again.tagged, before.tagged);

  // The tagger child writes through its own connection; the very next read sees it.
  const other = new Database(join(stateDir, 'library.db'));
  try {
    other.prepare(
      `UPDATE tracks SET bpm = 120, vocal_ranges_json = '[]', analyze_fail_count = 9 WHERE id = 't000'`,
    ).run();
  } finally {
    other.close();
  }
  const after = await coverage.get();
  assert.equal(after.analysed, before.analysed + 1);
  assert.equal(after.vocalAnalyzed, before.vocalAnalyzed + 1);
  assert.equal(after.analysisFailed, before.analysisFailed + 1);
  assert.equal(after.analysed, db.analysedCount(), 'no staleness against a fresh read');
});

test('the browse page returns the original SELECT * sort, row for row', (t) => {
  interface BrowseCase { moods?: string[]; energy?: string; genre?: string; q?: string; sort?: string }
  const cases: BrowseCase[] = [
    {},
    { sort: 'title' },
    { sort: 'year' },
    { sort: 'taggedAt' },
    { sort: 'bpm' },
    { sort: 'pace' },
    { moods: ['night'], sort: 'bpm' },
    { genre: 'Genre 3' },
    { q: 'same title' },
    { energy: 'low', sort: 'title' },
  ];
  for (const c of cases) {
    for (const [offset, limit] of [[0, 50], [37, 13], [300, 200], [1000, 50]] as const) {
      const opts = { ...c, offset, limit };
      let page!: ReturnType<typeof db.filter>;
      const sqls = preparedBy(t, () => { page = db.filter(opts as never); });
      // The id page is the original query with `SELECT id`; run the original.
      const idSql = sqls.find(sql => /^SELECT id FROM tracks\b/.test(sql));
      assert.ok(idSql, `the id page is prepared for ${JSON.stringify(opts)}`);
      const params = paramsFor(opts);
      const original = d.prepare(idSql.replace(/^SELECT id FROM/, 'SELECT * FROM')).all(...params, limit, offset) as Array<{ id: string }>;
      assert.deepEqual(page.rows.map(r => r.id), original.map(r => r.id), JSON.stringify(opts));
      if (offset === 0 && original.length) assert.ok(page.rows[0].title !== undefined, 'full rows, mapped');
    }
  }
});

// The bound parameters filter() passes before LIMIT/OFFSET, in its own order.
function paramsFor(o: { moods?: string[]; energy?: string; genre?: string; q?: string }): unknown[] {
  const p: unknown[] = [];
  if (o.moods?.length) p.push(...o.moods);
  if (o.energy) p.push(o.energy);
  if (o.genre) p.push(o.genre);
  if (o.q) { const pat = `%${o.q.toLowerCase()}%`; p.push(pat, pat, pat); }
  return p;
}

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});
