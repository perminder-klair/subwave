// #1991: genreInputsToken() is the change signal genre suggestions are cached
// on. It must move on every write that changes what the walk produces, and it
// must not move on the writes a playing station makes all the time (a play row
// per track, analysis results, audio vectors), or every editor open after the
// max age waits seconds for a walk that cannot find anything new. Pinned here:
//
//   - for every write path into what the walk reads (library-db's own, raw SQL,
//     and a second connection, which is the tagger child's shape), a changed
//     walk output means a moved token;
//   - the writes outside those inputs leave the token where it was;
//   - track_vectors is vec0, which takes no trigger, so every src/ function
//     that writes it also calls touchGenreInputs();
//   - a library.db from before the table gets it, triggers included, on open.
//   - an open that finds them all in place writes nothing, so it never waits
//     on another connection's write lock;
//   - an open that cannot put them in place still opens, and until one does
//     the token is the one that moves on every commit, never a frozen version.
//
// Real better-sqlite3 DB in a temp STATE_DIR. Run: `npm test -- genre-inputs`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { createTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-genre-inputs-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
await db.open({ embeddingDim: 4 });
await library.load();
// What the tagger and analyzer children are: another connection to the file.
const other = new Database(db.DB_PATH);
after(() => {
  other.close();
  library.shutdown();
  rmSync(stateDir, { recursive: true, force: true });
});
const d = () => db.requireDb();

// Two ids canonicalId() maps one onto the other: a Navidrome id rotation.
const ROTATED_OLD = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const ROTATED_NEW = '6VHl3uR4kss6sUPKA8Cwnk';

function seed(id: string, genres: string[], vector: number[] | null, tagged = true) {
  db.upsertTrackMeta(id, { title: id, artist: `Artist ${id}`, genres });
  if (tagged) db.upsertTrackTags(id, { moods: ['calm'], energy: 'low', source: 'manual' });
  if (vector) db.upsertTrackVector(id, vector, null);
}
for (let i = 0; i < 12; i++) {
  seed(`t${i}`, [`G${i % 3}`, `G${(i + 1) % 3}`], [Math.sin(i), Math.cos(i), (i % 4) / 4, 1], i % 5 !== 0);
}
seed(ROTATED_OLD, ['Rotated'], [1, 0, 1, 0]);
db.upsertTrackMeta(ROTATED_NEW, { title: 'Rotated', artist: 'Artist rotated' });

// Everything the genre-suggest walk produces: centroids in walk order (their
// order breaks neighbour ties) and the tagged count per genre.
function walkOutput(): string {
  const centroids = db.genreCentroids().map((c) => [c.genre, c.count, Array.from(c.centroid, (x) => x.toFixed(6))]);
  const byGenre = Object.entries(library.stats({ fresh: true }).byGenre).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ centroids, byGenre });
}

const liveIds = () => new Set((d().prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map((r) => r.id));

// Run in order: later rows build on the library the earlier ones left. The
// middle field says whether the write changes the walk's output (null: either,
// a float summation order); the token must move on every row regardless, so a
// false row is the token being cautious, which costs a walk and nothing else.
const relevant: Array<[string, boolean | null, () => void]> = [
  ['a new track with genres', false, () => db.upsertTrackMeta('n1', { title: 'N1', artist: 'New', genres: ['Fresh'] })],
  ['its first tags', true, () => db.upsertTrackTags('n1', { moods: ['bright'], energy: 'high', source: 'manual' })],
  ['its first vector', true, () => db.upsertTrackVector('n1', [0.5, 0.5, 0, 1], null)],
  ['a vector replaced', true, () => db.upsertTrackVector('t1', [1, 2, 3, 4], null)],
  ['genres changed by a metadata walk', true, () => db.upsertTrackMeta('t2', { title: 't2', genres: ['G0', 'Moved'] })],
  ['a re-tag', false, () => db.upsertTrackTags('t3', { moods: ['night'], energy: 'medium', source: 'manual' })],
  ['tags cleared', true, () => db.clearTrackTags('t4')],
  ['a scene merge', true, () => { db.mergeScenes(['G2'], 'G1'); }],
  ['an id rotation adopted', true, () => {
    const live = liveIds();
    live.delete(ROTATED_OLD); // the music server now lists the track under its new id
    assert.equal(db.adoptRotatedIds(live).adopted, 1);
  }],
  ['a vanished track pruned', true, () => {
    const live = liveIds();
    live.delete('t6');
    db.pruneMissingTracks(live);
  }],
  ['genres rewritten from another connection', true, () => {
    other.prepare('UPDATE tracks SET genres = ? WHERE id = ?').run(JSON.stringify(['Elsewhere']), 't7');
  }],
  ['a row deleted from another connection', true, () => { other.prepare('DELETE FROM tracks WHERE id = ?').run('t8'); }],
  ['a row replaced, which gives it a new rowid', null, () => {
    d().prepare(
      `INSERT OR REPLACE INTO tracks (id, title, artist, genres, moods, energy, source)
       SELECT id, title, artist, genres, moods, energy, source FROM tracks WHERE id = ?`,
    ).run('t9');
  }],
  ['every vector dropped for a re-embed', true, () => db.dropVectors()],
];

const unrelated: Array<[string, () => void]> = [
  ['a play row', () => db.recordPlay({
    trackId: 't10', title: 't10', artist: 'Artist t10', album: null, playedAt: new Date().toISOString(),
    source: 'auto', requestedBy: null, showId: null, showName: null,
  })],
  ['an analysis result', () => db.upsertTrackAnalysis('t10', { bpm: 120, musicalKey: '8A', introMs: 1000 })],
  ['an audio vector', () => db.upsertTrackAudioVector('t10', new Array(db.AUDIO_EMBEDDING_DIM).fill(0.1))],
  ['audio mood labels', () => db.setTrackAudioMoodLabelsBulk([{ id: 't10', moods: ['night'] }])],
  ['an energy correction', () => db.setTrackEnergyBulk([{ id: 't10', energy: 'high' }])],
  ['an enrichment', () => db.upsertTrackEnrichment('t10', { lastfmTags: ['x'], lyricExcerpt: 'la la' })],
  ['a metadata walk that changes nothing', () => db.upsertTrackMeta('t10', { title: 't10', artist: 'Artist t10', genres: ['G1', 'G2'] })],
  ['a title edit', () => db.upsertTrackMeta('t10', { title: 'Renamed' })],
  ['a no-op write from another connection', () => {
    other.prepare("UPDATE tracks SET title = title WHERE id = 't10'").run();
  }],
];

test('writes outside the walk\'s inputs leave the token where it was', () => {
  for (const [label, write] of unrelated) {
    const token = db.genreInputsToken();
    const output = walkOutput();
    write();
    assert.equal(walkOutput(), output, `${label}: the walk's output is unchanged`);
    assert.equal(db.genreInputsToken(), token, `${label}: the token stays`);
  }
});

test('every write that changes the walk\'s output moves the token', () => {
  for (const [label, changesOutput, write] of relevant) {
    const token = db.genreInputsToken();
    const output = walkOutput();
    write();
    // The fixture must really change the output where it says so, or a row
    // pins nothing.
    if (changesOutput !== null) assert.equal(walkOutput() !== output, changesOutput, `${label}: output changed`);
    assert.notEqual(db.genreInputsToken(), token, `${label}: the token moves`);
  }
});

test('every src/ function that writes track_vectors also bumps the version', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
  const WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+track_vectors\b/i;
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
  const hits: Array<{ at: string; bumps: boolean }> = [];
  for (const file of files) {
    const path = join(src, file);
    const text = readFileSync(path, 'utf8');
    if (!/track_vectors/.test(text)) continue;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
      if (isText && WRITE.test(node.getText(sf))) {
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ at: `${relative(src, path)}:${line + 1}`, bumps: !!fn && /\btouchGenreInputs\(/.test(fn.getText(sf)) });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const unpaired = hits.filter((h) => !h.bumps).map((h) => h.at);
  assert.deepEqual(unpaired, [], 'a track_vectors write without touchGenreInputs() in its function');
  // The scan must see the writers it is guarding, or a broken pattern passes.
  for (const f of ['tracks.ts', 'id-adoption.ts', 'audio-moods.ts', 'schema.ts']) {
    assert.ok(hits.some((h) => h.at.startsWith(`music/library-db/${f}:`)), `${f} is scanned`);
  }
});

test('an open with everything in place takes no write lock', (t) => {
  // Every process opens through migrate(), and a tagger or analyzer child opens
  // while another connection may be mid-write for seconds. A write here would
  // wait out the busy timeout, and the ensure would give up on what it found.
  const warn = t.mock.method(console, 'warn', () => {});
  other.prepare('BEGIN IMMEDIATE').run();
  const opener = new Database(db.DB_PATH, { timeout: 0 });
  try {
    assert.equal(db.ensureGenreInputs(opener), true, 'everything was found in place');
  } finally {
    opener.close();
    other.prepare('ROLLBACK').run();
  }
  assert.equal(warn.mock.callCount(), 0);
});

// What open() runs, on the open handle, while another connection holds a write
// for longer than the busy timeout. user_version is current, so the ensure is
// the only step that would write.
async function migrateUnderAHeldWrite() {
  other.prepare('BEGIN IMMEDIATE').run();
  d().pragma('busy_timeout = 20');
  try {
    await db.migrate(4, false, true);
  } finally {
    other.prepare('ROLLBACK').run();
  }
}

test('an upgrade open that cannot take the write lock still opens, on the token that moves on everything', async (t) => {
  // open() sets the handle before migrate(), so a throw here was never retried:
  // the next load() found the handle set and skipped migrate(), leaving the
  // process without the table, every editor open answering 500 and every
  // vector writer throwing after its write.
  d().exec(`DROP TRIGGER genre_inputs_tracks_insert; DROP TRIGGER genre_inputs_tracks_update;
            DROP TRIGGER genre_inputs_tracks_delete; DROP TABLE genre_inputs;`);
  const warn = t.mock.method(console, 'warn', () => {});
  await migrateUnderAHeldWrite();
  assert.ok(warn.mock.calls.some((c) => /genre_inputs not ensured/.test(String(c.arguments[0]))), 'the failure is logged');
  const token = db.genreInputsToken();
  assert.match(token, /^any\./);
  db.upsertTrackVector('t11', [0.3, 0.3, 0.3, 1], null);
  assert.notEqual(db.genreInputsToken(), token, 'a vector write still moves it');
  const live = liveIds();
  live.delete('t11');
  assert.equal(db.pruneMissingTracks(live), 1, 'a prune is not rolled back by its bump');
  t.mock.restoreAll();
  await library.reload();
  assert.doesNotMatch(db.genreInputsToken(), /^any\./, 'the next open puts the table back');
});

test('a trigger the open could not put back leaves the token on every commit, never frozen', async (t) => {
  // The table and its row are in place, but nothing bumps the version on a
  // genres update any more: trusting it would serve one walk forever.
  d().exec('DROP TRIGGER genre_inputs_tracks_update');
  t.mock.method(console, 'warn', () => {});
  await migrateUnderAHeldWrite();
  const token = db.genreInputsToken();
  other.prepare('UPDATE tracks SET genres = ? WHERE id = ?').run(JSON.stringify(['Unbumped']), 't9');
  assert.notEqual(db.genreInputsToken(), token, 'a genres update still moves it');
  t.mock.restoreAll();
  await library.reload();
  assert.doesNotMatch(db.genreInputsToken(), /^any\./, 'the next open puts the trigger back');
});

test('a trigger missing on its own is put back on open', async () => {
  d().exec('DROP TRIGGER genre_inputs_tracks_update');
  await library.reload();
  assert.ok(d().prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'genre_inputs_tracks_update'`,
  ).get());
  const token = db.genreInputsToken();
  db.upsertTrackMeta('t11', { title: 't11', genres: ['Put Back'] });
  assert.notEqual(db.genreInputsToken(), token);
});

test('a library.db from before the version table gets it, triggers included', async () => {
  d().exec(`DROP TRIGGER genre_inputs_tracks_insert; DROP TRIGGER genre_inputs_tracks_update;
            DROP TRIGGER genre_inputs_tracks_delete; DROP TABLE genre_inputs;`);
  await library.reload();
  const triggers = (d().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'genre_inputs_%' ORDER BY name`,
  ).all() as Array<{ name: string }>).map((r) => r.name);
  assert.deepEqual(triggers, ['genre_inputs_tracks_delete', 'genre_inputs_tracks_insert', 'genre_inputs_tracks_update']);
  const token = db.genreInputsToken();
  db.upsertTrackMeta('after-upgrade', { title: 'After', artist: 'New', genres: ['Later'] });
  assert.notEqual(db.genreInputsToken(), token);
});

test('a missing version row falls back to the token that moves on everything', () => {
  d().prepare('DELETE FROM genre_inputs').run();
  try {
    const token = db.genreInputsToken();
    assert.match(token, /^any\./);
    db.recordPlay({
      trackId: 't10', title: 't10', artist: null, album: null, playedAt: new Date().toISOString(),
      source: 'auto', requestedBy: null, showId: null, showName: null,
    });
    assert.notEqual(db.genreInputsToken(), token, 'never frozen');
  } finally {
    d().prepare('INSERT OR IGNORE INTO genre_inputs (pk, version) VALUES (1, 0)').run();
  }
});
