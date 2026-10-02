import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'subwave-library-lookup-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const blocklist = await import('../src/music/blocklist.js');
await library.load();
await blocklist.load();
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function seed(id: string, moods = ['reflective']) {
  db.upsertTrackMeta(id, { title: id, artist: 'Artist', album: 'Album', albumId: 'album',
    artistId: 'artist', year: 2000, genres: ['Rock'], duration: 180 });
  db.upsertTrackTags(id, { moods, energy: 'low', source: 'manual' });
}

test('public pools preserve payloads and required acoustic values', () => {
  seed('payload');
  db.getDb()!.prepare(`UPDATE tracks SET original_year=1990, is_compilation=1,
    bpm=120, musical_key='8A', intro_ms=200, loudness_lufs=-12,
    audio_moods='["reflective","Custom"]',
    structure_json='[{"startMs":0,"endMs":100,"kind":"intro"}]',
    vocal_ranges_json='[{"startMs":10,"endMs":20}, {"startMs":5,"endMs":4}]',
    pace_json='[{"startMs":0,"endMs":100,"value":0.12345}]', beats_json='[1,2,3]'
    WHERE id='payload'`).run();
  const mood = library.songsByMood('reflective').find(r => r.id === 'payload');
  assert.deepEqual(mood, { id: 'payload', title: 'payload', artist: 'Artist', album: 'Album',
    albumId: 'album', artistId: 'artist', year: 2000, genres: ['Rock'], genre: 'Rock',
    moods: ['reflective'], energy: 'low', durationSec: 180 });
  const energy = library.songsByEnergy('low').find(r => r.id === 'payload');
  assert.deepEqual(energy, { ...mood, originalYear: 1990, isCompilation: true,
    yearUntrusted: true, audioMoods: ['reflective', 'Custom'], bpm: 120, musicalKey: '8A',
    introMs: 200, loudnessLufs: -12, structure: [{ startMs: 0, endMs: 100, kind: 'intro' }],
    vocalRanges: [{ startMs: 10, endMs: 20 }], paceMean: 0.123 });
  assert.deepEqual(db.getTrack('payload')!.beats, [1, 2, 3]);
  assert.deepEqual(library.songsByEnergy('invalid'), []);
});

test('hot filters have indexed access rather than whole-library scans', () => {
  const d = db.getDb()!;
  const energy = d.prepare('EXPLAIN QUERY PLAN SELECT id FROM tracks WHERE energy=?').all('low') as any[];
  assert.match(energy.map(r => r.detail).join('\n'), /SEARCH tracks USING.*idx_tracks_energy/);
  const mood = d.prepare(`EXPLAIN QUERY PLAN SELECT t.id FROM track_moods m
    JOIN tracks t ON t.id=m.track_id WHERE m.mood=? ORDER BY t.rowid`).all('reflective') as any[];
  const plan = mood.map(r => r.detail).join('\n');
  assert.match(plan, /SEARCH m USING COVERING INDEX idx_track_moods_mood/);
  assert.match(plan, /SEARCH t USING/);
  assert.doesNotMatch(plan, /SCAN t\b/);
});

const ids = (mood: string) => db.songsByMood(mood).map(r => r.id);
function noOrphans() {
  assert.deepEqual(db.getDb()!.prepare(`SELECT m.track_id FROM track_moods m
    LEFT JOIN tracks t ON t.id=m.track_id WHERE t.id IS NULL`).all(), []);
}

test('membership is a case-sensitive union maintained by all tag/analysis writers', () => {
  seed('union', ['Custom', 'Custom', '', 'custom']);
  db.setTrackAudioMoodLabelsBulk([{ id: 'union', moods: ['Custom', 'audio'] }]);
  assert.deepEqual(ids('Custom'), ['payload', 'union']);
  assert.deepEqual(ids('custom'), ['union']);
  assert.deepEqual(ids(''), ['union']);
  db.upsertTrackTags('union', { moods: ['replacement'], energy: 'high', source: 'manual' });
  assert.deepEqual(ids('custom'), []);
  assert.deepEqual(ids('Custom'), ['payload', 'union'], 'overlap survives removal from editorial source');
  db.clearTrackTags('union');
  assert.deepEqual(ids('replacement'), []);
  assert.deepEqual(ids('audio'), ['union']);
  db.setTrackAudioMoodLabelsBulk([{ id: 'union', moods: ['new-audio'] }]);
  assert.deepEqual(ids('audio'), []);
  db.clearAnalysis();
  assert.deepEqual(ids('new-audio'), []);
  assert.deepEqual(ids('reflective'), ['payload']);
  db.setTrackEnergyBulk([{ id: 'union', energy: 'low' }]);
  assert.equal(db.songsByEnergy('low').some(r => r.id === 'union'), true);
  assert.throws(() => db.setTrackEnergyBulk([{ id: 'union', energy: 'high' }, { id: 'payload', energy: 'invalid' }]));
  assert.equal(db.getTrack('union')!.energy, 'low');
  noOrphans();
});

test('cross-connection writes, changed ids and transaction rollback stay consistent', () => {
  const other = new Database(join(dir, 'library.db'));
  try {
    other.prepare(`INSERT INTO tracks(id,moods,audio_moods) VALUES ('external','["external","external"]','["external"]')`).run();
    assert.deepEqual(ids('external'), ['external']);
    other.prepare(`UPDATE tracks SET id='external-new', moods='broken', audio_moods='["safe",1,null]' WHERE id='external'`).run();
    assert.deepEqual(ids('external'), []);
    assert.deepEqual(ids('safe'), ['external-new']);
    assert.throws(() => other.transaction(() => {
      other.prepare(`UPDATE tracks SET moods='["rolled-back"]' WHERE id='external-new'`).run();
      throw new Error('rollback');
    })());
    assert.deepEqual(ids('rolled-back'), []);
    assert.deepEqual(ids('safe'), ['external-new']);
    other.prepare(`DELETE FROM tracks WHERE id='external-new'`).run();
    assert.deepEqual(ids('safe'), []);
    noOrphans();
  } finally { other.close(); }
});

test('blocklists count before widening, exact matches precede deduplicated neighbours', async () => {
  for (let i = 0; i < 12; i++) seed(`morning${i}`, ['morning', 'calm']);
  seed('calm-only', ['calm']);
  assert.deepEqual(library.songsByMood('morning').map(r => r.id), Array.from({ length: 12 }, (_, i) => `morning${i}`));
  await blocklist.add({ type: 'track', id: 'morning0', name: 'morning0', artist: 'Artist' });
  const widened = library.songsByMood('morning').map(r => r.id);
  assert.deepEqual(widened, [...Array.from({ length: 11 }, (_, i) => `morning${i + 1}`), 'calm-only']);
});

test('id adoption and failed adoption transactions move the union atomically', () => {
  const old = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
  const neu = '6VHl3uR4kss6sUPKA8Cwnk';
  seed(old, ['adopted']);
  db.setTrackAudioMoodLabelsBulk([{ id: old, moods: ['adopted-audio'] }]);
  db.upsertTrackMeta(neu, { title: 'new' });
  const live = new Set([neu]);
  assert.throws(() => db.getDb()!.transaction(() => {
    db.adoptRotatedIds(live);
    throw new Error('rollback');
  })());
  assert.deepEqual(ids('adopted'), [old]);
  assert.deepEqual(ids('adopted-audio'), [old]);
  assert.equal(db.adoptRotatedIds(live).adopted, 1);
  assert.deepEqual(ids('adopted'), [neu]);
  assert.deepEqual(ids('adopted-audio'), [neu]);
  db.pruneMissingTracks(new Set(['payload', neu]));
  noOrphans();
  assert.deepEqual(ids('morning'), []);
});

function downgrade() {
  db.runDdl(db.getDb()!, `DROP TRIGGER tracks_moods_insert; DROP TRIGGER tracks_moods_update;
    DROP TRIGGER tracks_moods_delete; DROP TABLE track_moods; DROP INDEX idx_tracks_energy;
    PRAGMA user_version=26;`);
}

test('v26 backfill tolerates malformed sources, rolls back failed DDL and restores both backup versions', async () => {
  downgrade();
  const d = db.getDb()!;
  d.prepare(`INSERT INTO tracks(id,moods,audio_moods) VALUES(?,?,?)`).run('malformed', 'broken', '["valid", "valid", "", "Case", "case", 1, null]');
  d.prepare(`INSERT INTO tracks(id,moods,audio_moods) VALUES(?,?,?)`).run('empty', null, '[]');
  const before = join(dir, 'v26.db');
  await db.backup(before);
  // A conflicting object fails after the energy index was created.
  db.runDdl(d, 'CREATE TABLE track_moods(conflict TEXT)');
  await assert.rejects(db.migrate(3), /already exists/);
  assert.equal(d.pragma('user_version', { simple: true }), 26);
  assert.equal(d.prepare("SELECT name FROM sqlite_master WHERE name='idx_tracks_energy'").get(), undefined);
  db.runDdl(d, 'DROP TABLE track_moods');
  await db.migrate(3);
  assert.deepEqual(ids('valid'), ['malformed']);
  assert.deepEqual(ids('Case'), ['malformed']);
  assert.deepEqual(ids('case'), ['malformed']);
  assert.deepEqual(ids(''), ['malformed']);
  assert.equal(db.getTrack('malformed')!.moods.length, 0);
  const after = join(dir, 'v27.db');
  await db.backup(after);
  // Reopen must not rebuild an already migrated derived table.
  db.runDdl(d, `CREATE TRIGGER reject_backfill BEFORE INSERT ON track_moods
    BEGIN SELECT RAISE(ABORT, 'unexpected rebuild'); END;`);
  db.close();
  await db.open({ embeddingDim: 3, adoptStoredDim: true });
  assert.deepEqual(ids('valid'), ['malformed']);
  for (const backup of [before, after]) {
    await db.restoreFromFile(backup);
    await db.open({ embeddingDim: 3, adoptStoredDim: true });
    assert.equal(db.getDb()!.pragma('user_version', { simple: true }), 27);
    assert.deepEqual(ids('valid'), ['malformed']);
    noOrphans();
  }
});

test('reset creates fresh indexes and legacy import is immediately discoverable', async () => {
  await db.reset();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'moods.json'), JSON.stringify({ tracks: {
    legacy: { title: 'Legacy', moods: ['legacy-mood'], energy: 'low' },
  } }));
  await db.open({ embeddingDim: 3 });
  assert.deepEqual(ids('legacy-mood'), ['legacy']);
  assert.deepEqual(db.songsByEnergy('low').map(r => r.id), ['legacy']);
  noOrphans();
});

test('production lookup statements select only their contracts and use indexes', () => {
  const d = db.getDb()!;
  const prepare = d.prepare.bind(d);
  const statements: string[] = [];
  // Record real SQL without replacing execution or returning mocked records.
  d.prepare = (sql: string) => { statements.push(sql); return prepare(sql); };
  try {
    db.songsByMood('legacy-mood');
    db.songsByEnergy('low');
  } finally { d.prepare = prepare; }
  assert.equal(statements.length, 2, 'one bounded read per pool, no hydration');
  for (const sql of statements) {
    assert.doesNotMatch(sql, /SELECT\s+\*|json_each|beats_json|bars_json|key_ranges_json|audio_mood_scores_json|outro_json/i);
    const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all('low') as Array<{ detail: string }>).map(r => r.detail).join('\n');
    assert.doesNotMatch(plan, /SCAN t\b/);
    assert.match(plan, /SEARCH/);
  }
  assert.doesNotMatch(statements[0], /structure_json|vocal_ranges_json|pace_json/);
  assert.match(statements[1], /structure_json/);
  assert.match(statements[1], /vocal_ranges_json/);
  assert.match(statements[1], /pace_json/);
});

test('concurrent upgrading connections build exactly one complete index', async () => {
  const { spawn } = await import('node:child_process');
  downgrade();
  db.close();
  const moduleUrl = new URL('../src/music/library-db.ts', import.meta.url).href;
  const code = `const db=await import(${JSON.stringify(moduleUrl)}); await db.open({embeddingDim:3});
    if(db.songsByMood('legacy-mood').length!==1) throw new Error('incomplete pool'); db.close();`;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: process.env });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', status => status === 0 ? resolve(output) : reject(new Error(output)));
  });
  const output = (await Promise.all([run(), run()])).join('');
  assert.equal(output.split('mood/energy indexes built').length - 1, 1);
  await db.open({ embeddingDim: 3 });
  assert.deepEqual(ids('legacy-mood'), ['legacy']);
  noOrphans();
});

test('energy projection preserves unmeasured and defensively parsed acoustic states', () => {
  seed('unmeasured', ['parser']);
  let energy = library.songsByEnergy('low').find(r => r.id === 'unmeasured');
  assert.equal(energy.structure, null);
  assert.equal(energy.vocalRanges, null);
  assert.equal(energy.paceMean, null);
  db.getDb()!.prepare(`UPDATE tracks SET structure_json='broken',
    vocal_ranges_json='broken', pace_json='broken' WHERE id='unmeasured'`).run();
  energy = library.songsByEnergy('low').find(r => r.id === 'unmeasured');
  assert.equal(energy.structure, null);
  assert.deepEqual(energy.vocalRanges, []);
  assert.equal(energy.paceMean, null);
  assert.equal(db.getTrack('unmeasured')!.structure, null);
  assert.deepEqual(db.getTrack('unmeasured')!.vocalRanges, []);
});
