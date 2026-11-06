// The numbered migrations that add columns (28, 29, 33 to 36) run on open, and
// several processes open state/library.db: the controller, and the tagger and
// analyzer children. On the first open after an upgrade two of them can both
// find a column missing, and the second ALTER threw "duplicate column name",
// failing that process's open(). Each step now goes through schema.ts
// addColumnsOnce, which does its read, ALTERs and stamp under the write lock.
//
// Pinned here, against a real second connection acting at a chosen moment, for
// the real steps through open():
//   - a rival adding a step's column between its read and its ALTER can't fail
//     open(), for every column step;
//   - step 33 reads the columns, adds the missing one and stamps user_version
//     under the write lock;
//   - a rival that finished the steps first leaves them nothing to do, and
//     user_version never goes back;
//   - any other failure still throws out of open(), and the next open finishes
//     the step;
//   - a database already past the steps takes no write lock for them;
// and for addColumnsOnce on a bare database: the same five, plus that it adds
// only what is missing, in order, and that a step failing partway applies none
// of itself.
// Run: `npm test -- library-migration-columns`.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-migration-columns-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
const { SEARCH_KEY_DDL } = await import('../src/music/library-db/search-keys.js');
// node:test hands a SqliteError across to the runner as its code alone, so this
// re-raises one as a plain Error that keeps its message ("duplicate column name").
const open = () => db.open({ embeddingDim: 8, adoptStoredDim: true }).catch((err: Error & { code?: string }) => {
  throw Object.assign(new Error(err.message), { code: err.code });
});
after(async () => {
  db.close();
  await removeTempDir(dir);
});

const version = () => db.requireDb().pragma('user_version', { simple: true }) as number;
// Every step's version, as a fresh open stamps it.
await open();
const LATEST = version();
assert.ok(LATEST >= 37);
const columnsOf = (d: Database.Database, table: string) =>
  (d.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
const hasExplicitStatus = () => columnsOf(db.requireDb(), 'tracks').includes('explicit_status');

// A database with no file yet, so the next open runs every step.
function startFresh() {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, `library.db${suffix}`), { force: true });
}

// The database an upgrade from 32 finds, closed, so the next open runs the steps
// from 33 and step 33 has a column to add. Built afresh, so no test leans on the
// state the one before it left.
async function at32() {
  startFresh();
  await open();
  db.requireDb().exec('ALTER TABLE tracks DROP COLUMN explicit_status; PRAGMA user_version = 32;');
  db.close();
}

type Move = (rival: Database.Database, opener: Database.Database, sql: string) => void;
const inTurn = (...moves: Move[]): Move => {
  let n = 0;
  return (rival, opener, sql) => moves[n++]?.(rival, opener, sql);
};

const scratch = new Database(':memory:');
const Statement = Object.getPrototypeOf(scratch.prepare('SELECT 1')) as Record<'all' | 'get' | 'run', (...args: unknown[]) => unknown>;
scratch.close();

// Runs `run` with a real second connection, the rival, acting at chosen moments:
// `move` runs right after each opener statement whose SQL matches `at`, whichever
// call ran it (prepare().all(), pragma(), get()), and right before each matching
// exec(). The rival opens on the first match and never waits for a lock, so a
// write the opener's lock holds off throws SQLITE_BUSY at once. Returns how many
// statements matched.
async function withRival(at: RegExp, move: Move, run: () => Promise<unknown>): Promise<number> {
  const real = { all: Statement.all, get: Statement.get, run: Statement.run, exec: Database.prototype.exec };
  let rival: Database.Database | null = null;
  let matched = 0;
  const act = (opener: Database.Database, sql: string) => {
    rival ??= new Database(opener.name, { timeout: 0 });
    matched++;
    move(rival, opener, sql);
  };
  for (const name of ['all', 'get', 'run'] as const) {
    Statement[name] = function (this: Database.Statement, ...args: unknown[]) {
      const result = real[name].apply(this, args);
      if (this.database !== rival && at.test(this.source)) act(this.database, this.source);
      return result;
    };
  }
  Database.prototype.exec = function exec(this: Database.Database, sql: string) {
    if (this !== rival && at.test(sql)) act(this, sql);
    return real.exec.call(this, sql);
  };
  try {
    await run();
  } finally {
    Object.assign(Statement, { all: real.all, get: real.get, run: real.run });
    Database.prototype.exec = real.exec;
    (rival as Database.Database | null)?.close();
  }
  return matched;
}

const isBusy = (err: unknown) => (err as { code?: string }).code === 'SQLITE_BUSY';
// The rival tries a write. Held off by the opener's lock, or done: either way the
// opener has to cope.
function tryWrite(rival: Database.Database, sql: string): 'held off' | 'written' {
  try {
    rival.exec(sql);
    return 'written';
  } catch (err) {
    if (isBusy(err)) return 'held off';
    throw err;
  }
}
const lockedOut = (rival: Database.Database) =>
  assert.throws(() => rival.exec('BEGIN IMMEDIATE'), { code: 'SQLITE_BUSY' }, 'the opener holds the write lock');

// Each column step, with the first column it adds.
const STEPS: Array<{ step: number; table: string; column: string }> = [
  { step: 28, table: 'plays', column: 'transition' },
  { step: 29, table: 'tracks', column: SEARCH_KEY_DDL.columns[0] },
  { step: 33, table: 'tracks', column: 'explicit_status' },
  { step: 34, table: 'tracks', column: 'lastfm_track_tags_at' },
  { step: 35, table: 'tracks', column: 'audio_descriptors' },
  { step: 36, table: 'tracks', column: 'text_vector_sound' },
  { step: 37, table: 'tracks', column: 'loudness_version' },
];

for (const { step, table, column } of STEPS) {
  test(`step ${step}: a rival adding ${column} between the read and the ALTER cannot fail open()`, async () => {
    startFresh();
    const tried: string[] = [];
    await withRival(new RegExp(`^PRAGMA table_info\\(${table}\\)$`), (rival) => {
      // The step's own read: the rival still sees the version before it.
      if (tried.length || rival.pragma('user_version', { simple: true }) !== step - 1) return;
      tried.push(tryWrite(rival, `ALTER TABLE ${table} ADD COLUMN ${column} TEXT`));
    }, open);
    assert.equal(tried.length, 1, `the rival acted at step ${step}`);
    assert.equal(version(), LATEST);
    assert.ok(columnsOf(db.requireDb(), table).includes(column));
  });
}

test('step 33 reads the columns, adds explicit_status and stamps 33 under the write lock', async () => {
  await at32();
  const seen: string[] = [];
  await withRival(/^PRAGMA table_info\(tracks\)$|ADD COLUMN explicit_status|^PRAGMA user_version = 33$/, (rival, opener, sql) => {
    // Step 33's own statements only: the steps after it read the columns again,
    // and an unlocked read elsewhere in migrate is not its.
    if (seen.includes('PRAGMA user_version = 33') || (sql.startsWith('PRAGMA table_info') && !opener.inTransaction)) return;
    lockedOut(rival);
    seen.push(sql.replace(/;$/, ''));
  }, open);
  assert.deepEqual(seen, [
    'PRAGMA table_info(tracks)',
    'ALTER TABLE tracks ADD COLUMN explicit_status TEXT',
    'PRAGMA user_version = 33',
  ]);
  assert.equal(version(), LATEST);
  assert.ok(hasExplicitStatus());
});

test('a rival that finished the steps first leaves them nothing to do, and user_version never goes back', async () => {
  await at32();
  const versions: number[] = [];
  const matched = await withRival(/^PRAGMA (user_version|table_info\(tracks\))$/, inTurn(
    // The gate read: this opener has decided to run the steps from 33, and a rival
    // finishes them.
    (rival) => rival.exec(`BEGIN IMMEDIATE; ALTER TABLE tracks ADD COLUMN explicit_status TEXT;
      PRAGMA user_version = ${LATEST}; COMMIT;`),
    ...Array.from({ length: 20 }, (): Move => (rival) => {
      versions.push(rival.pragma('user_version', { simple: true }) as number);
    }),
  ), open);
  assert.ok(matched > 1);
  assert.deepEqual(versions, versions.map(() => LATEST), `user_version went back: ${versions.join(', ')}`);
  assert.equal(version(), LATEST);
  assert.ok(hasExplicitStatus());
});

test('any other failure throws out of open(), and the next open finishes the step', async () => {
  await at32();
  await assert.rejects(withRival(/^PRAGMA user_version$/, inTurn((rival, opener) => {
    opener.pragma('busy_timeout = 20'); // the default would hold this test for 5 s
    rival.exec('BEGIN IMMEDIATE');
  }), open), { code: 'SQLITE_BUSY' });
  db.close();
  await open();
  assert.equal(version(), LATEST);
  assert.ok(hasExplicitStatus());
});

test('a database already past the steps takes no write lock for them', async () => {
  startFresh();
  await open();
  assert.equal(version(), LATEST);
  db.close();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    await withRival(/^PRAGMA user_version$/, inTurn((rival, opener) => {
      opener.pragma('busy_timeout = 20');
      rival.exec('BEGIN IMMEDIATE');
    }), open);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
  assert.equal(version(), LATEST);
});

// The helper on its own: a bare database with two tables, at version 32.
let bareDbs = 0;
function bareDb(): Database.Database {
  const d = new Database(join(dir, `bare-${++bareDbs}.db`));
  d.pragma('journal_mode = WAL');
  d.exec('CREATE TABLE tracks (id TEXT PRIMARY KEY, a TEXT); CREATE TABLE meta (pk INTEGER PRIMARY KEY); PRAGMA user_version = 32;');
  return d;
}
const SPEC = { tracks: { a: 'TEXT', b: 'INTEGER', c: 'TEXT' }, meta: { m: 'TEXT' } };
const shape = (d: Database.Database) => ({
  tracks: columnsOf(d, 'tracks'),
  meta: columnsOf(d, 'meta'),
  version: d.pragma('user_version', { simple: true }),
});
const DONE = { tracks: ['id', 'a', 'b', 'c'], meta: ['pk', 'm'], version: 33 };
const UNTOUCHED = { tracks: ['id', 'a'], meta: ['pk'], version: 32 };

test('the helper adds only the missing columns, in order, and stamps the version with them', () => {
  const d = bareDb();
  try {
    db.addColumnsOnce(d, 33, SPEC);
    assert.deepEqual(shape(d), DONE);
    assert.deepEqual((d.pragma('table_info(tracks)') as Array<{ type: string }>).map((c) => c.type), ['TEXT', 'TEXT', 'INTEGER', 'TEXT']);
  } finally {
    d.close();
  }
});

test('the helper: a rival adding a column between the read and the ALTER cannot fail it', async () => {
  const d = bareDb();
  try {
    const tried: string[] = [];
    await withRival(/^PRAGMA table_info\(tracks\)$/, inTurn((rival) => {
      tried.push(tryWrite(rival, 'ALTER TABLE tracks ADD COLUMN b INTEGER'));
    }), async () => db.addColumnsOnce(d, 33, SPEC));
    assert.equal(tried.length, 1);
    assert.deepEqual(shape(d), DONE);
  } finally {
    d.close();
  }
});

test('the helper reads, adds and stamps under the write lock', async () => {
  const d = bareDb();
  try {
    const seen: string[] = [];
    await withRival(/^PRAGMA table_info\((tracks|meta)\)$|ADD COLUMN|^PRAGMA user_version = 33$/, (rival, _, sql) => {
      lockedOut(rival);
      seen.push(sql.replace(/;$/, ''));
    }, async () => db.addColumnsOnce(d, 33, SPEC));
    assert.deepEqual(seen, [
      'PRAGMA table_info(tracks)',
      'ALTER TABLE tracks ADD COLUMN b INTEGER',
      'ALTER TABLE tracks ADD COLUMN c TEXT',
      'PRAGMA table_info(meta)',
      'ALTER TABLE meta ADD COLUMN m TEXT',
      'PRAGMA user_version = 33',
    ]);
    assert.deepEqual(shape(d), DONE);
  } finally {
    d.close();
  }
});

test('the helper: a rival that ran the step while it waited for the lock leaves it nothing to do', async () => {
  const d = bareDb();
  try {
    // Right after its unlocked read, a rival runs the step and goes on past it.
    await withRival(/^PRAGMA user_version$/, inTurn((rival) => rival.exec(`BEGIN IMMEDIATE;
      ALTER TABLE tracks ADD COLUMN b INTEGER; ALTER TABLE tracks ADD COLUMN c TEXT;
      ALTER TABLE meta ADD COLUMN m TEXT; PRAGMA user_version = 40; COMMIT;`)),
    async () => db.addColumnsOnce(d, 33, SPEC));
    assert.deepEqual(shape(d), { ...DONE, version: 40 }, 'nothing added twice, and the version not stamped back');
  } finally {
    d.close();
  }
});

test('the helper: any other failure throws, and the next call finishes the step', async () => {
  const d = bareDb();
  try {
    await assert.rejects(withRival(/^PRAGMA user_version$/, inTurn((rival, opener) => {
      opener.pragma('busy_timeout = 20');
      rival.exec('BEGIN IMMEDIATE');
    }), async () => db.addColumnsOnce(d, 33, SPEC)), { code: 'SQLITE_BUSY' });
    assert.deepEqual(shape(d), UNTOUCHED);
    db.addColumnsOnce(d, 33, SPEC);
    assert.deepEqual(shape(d), DONE);
  } finally {
    d.close();
  }
});

test('the helper: a step that fails partway applies none of it', () => {
  const d = bareDb();
  try {
    // b is added, then c can't be: ADD COLUMN refuses NOT NULL with no default once
    // the table has a row.
    d.exec(`INSERT INTO tracks (id) VALUES ('row')`);
    assert.throws(() => db.addColumnsOnce(d, 33, { tracks: { b: 'INTEGER', c: 'TEXT NOT NULL' } }), /NOT NULL/);
    assert.deepEqual(shape(d), UNTOUCHED);
  } finally {
    d.close();
  }
});

test('the helper takes no write lock on a database already past its step', () => {
  const d = bareDb();
  const rival = new Database(d.name, { timeout: 0 });
  try {
    d.pragma('user_version = 33');
    d.pragma('busy_timeout = 20');
    rival.exec('BEGIN IMMEDIATE');
    db.addColumnsOnce(d, 33, SPEC);
    assert.deepEqual(shape(d), { ...UNTOUCHED, version: 33 });
  } finally {
    rival.close();
    d.close();
  }
});
