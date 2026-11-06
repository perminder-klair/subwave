import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';
import { dropLanguageStatsIndex } from './test-utils/legacy-schema.js';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-task-3-schema-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { requireDb } = await import('../src/music/library-db/handle.js');

function columns(): string[] {
  return (requireDb().prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(row => row.name);
}

function hasIndex(name: string): boolean {
  return !!requireDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

function writeLanguageRows(): void {
  const raw = requireDb();
  raw.prepare(`UPDATE tracks SET language_primary = ?, languages = ? WHERE id = ?`).run('Spanish', '["Spanish","English"]', 'spanish');
  raw.prepare(`UPDATE tracks SET language_primary = ?, languages = ? WHERE id = ?`).run(null, '["Hindi"]', 'hindi');
}

test.after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

test('fresh library schema creates language query columns and serves both query shapes', async () => {
  await db.open({ embeddingDim: 4 });
  db.upsertTrackMeta('spanish', { title: 'Uno', artist: 'A', album: 'X' });
  db.upsertTrackMeta('hindi', { title: 'Do', artist: 'B', album: 'Y' });
  writeLanguageRows();

  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.deepEqual(db.songsByLanguage('Hindi').map(row => row.id), ['hindi']);
  assert.deepEqual(db.languagesByIds(['spanish', 'hindi']).get('spanish'), {
    language: 'Spanish', languages: ['Spanish', 'English'],
  });
});

test('upgrading a version-29 library adds language columns without losing rows', async () => {
  db.close();
  const raw = requireDb;
  // The fresh test has the current schema; make this file represent the last
  // pre-language release, retaining the rows and their ordinary metadata.
  const connection = (await import('better-sqlite3')).default;
  const Database = connection as any;
  const file = join(stateDir, 'library.db');
  const old = new Database(file);
  dropLanguageStatsIndex(old);
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages;');
  old.pragma('user_version = 29');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.equal((raw().pragma('user_version', { simple: true }) as number), 37);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.equal(hasIndex('idx_tracks_language_stats'), true);
  assert.equal(db.getTrack('spanish')?.title, 'Uno');
});

test('a version-35 library from develop gets the language columns in version 37', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  dropLanguageStatsIndex(old);
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages;');
  old.pragma('user_version = 35');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.equal((requireDb().pragma('user_version', { simple: true }) as number), 37);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
});

test('a version-36 library from develop gets the language columns in version 37', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  // Develop's own 36 (#2240) is the Sound: column, which this library has.
  dropLanguageStatsIndex(old);
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages;');
  old.prepare('UPDATE tracks SET text_vector_sound = ? WHERE id = ?').run('calm|piano', 'spanish');
  old.pragma('user_version = 36');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.equal((requireDb().pragma('user_version', { simple: true }) as number), 37);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.equal((requireDb().prepare('SELECT text_vector_sound FROM tracks WHERE id = ?').get('spanish') as { text_vector_sound: string }).text_vector_sound, 'calm|piano');
});

test('a version-30 language library repairs later tables and retains its language tags', async () => {
  writeLanguageRows();
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  old.exec('DROP TABLE lyrics_external; DROP TABLE lyric_offsets;');
  old.pragma('user_version = 30');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.equal((requireDb().pragma('user_version', { simple: true }) as number), 37);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.ok(requireDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lyrics_external'").get());
  assert.ok(requireDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lyric_offsets'").get());
  assert.deepEqual(db.languagesByIds(['spanish']).get('spanish'), {
    language: 'Spanish', languages: ['Spanish', 'English'],
  });
});

test('concurrent opens serialize the step at 37: language and the columns an earlier build missed', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  // Develop's own steps up to 36 are develop's; the step at 37 is this branch's.
  // A database an earlier build of it left at 36 has no #2214 or #2240 columns.
  dropLanguageStatsIndex(old);
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages; ALTER TABLE tracks DROP COLUMN audio_descriptors; ALTER TABLE tracks DROP COLUMN audio_descriptor_scores_json; ALTER TABLE tracks DROP COLUMN text_vector_sound; ALTER TABLE audio_embedding_meta DROP COLUMN descriptor_vocab_hash;');
  old.pragma('user_version = 36');
  old.close();

  const { spawn } = await import('node:child_process');
  const moduleUrl = new URL('../src/music/library-db.js', import.meta.url).href;
  const handleUrl = new URL('../src/music/library-db/handle.js', import.meta.url).href;
  const code = `const db=await import(${JSON.stringify(moduleUrl)}); await db.open({embeddingDim:4});
    const {requireDb}=await import(${JSON.stringify(handleUrl)});
    const columns=new Set(requireDb().prepare('PRAGMA table_info(tracks)').all().map(row=>row.name));
    if(!columns.has('language_primary')||!columns.has('languages')||!columns.has('explicit_status')||!columns.has('lastfm_track_tags_at')||!columns.has('audio_descriptors')||!columns.has('audio_descriptor_scores_json')||!columns.has('text_vector_sound')) throw new Error('migrated track columns missing');
    const audioMeta=new Set(requireDb().prepare('PRAGMA table_info(audio_embedding_meta)').all().map(row=>row.name));
    if(!audioMeta.has('descriptor_vocab_hash')) throw new Error('descriptor hash column missing');
    if(requireDb().pragma('user_version',{simple:true})!==37) throw new Error('schema version is not 37');
    db.close();`;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: process.env });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', status => status === 0 ? resolve(output) : reject(new Error(output)));
  });

  await Promise.all(Array.from({ length: 12 }, run));
  await db.open({ embeddingDim: 4 });
  assert.equal((requireDb().pragma('user_version', { simple: true }) as number), 37);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
});

test('a version-35 develop library gains the request language columns', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  dropLanguageStatsIndex(old);
  old.exec(`
    ALTER TABLE tracks DROP COLUMN language_primary;
    ALTER TABLE tracks DROP COLUMN languages;
    ALTER TABLE tracks DROP COLUMN audio_descriptors;
    ALTER TABLE tracks DROP COLUMN audio_descriptor_scores_json;
    ALTER TABLE audio_embedding_meta DROP COLUMN descriptor_vocab_hash;
    ALTER TABLE tracks ADD COLUMN audio_descriptors TEXT;
    ALTER TABLE tracks ADD COLUMN audio_descriptor_scores_json TEXT;
    ALTER TABLE audio_embedding_meta ADD COLUMN descriptor_vocab_hash TEXT;
  `);
  old.prepare('UPDATE tracks SET audio_descriptors = ?, audio_descriptor_scores_json = ? WHERE id = ?')
    .run('["piano"]', '{"piano":0.9}', 'spanish');
  old.pragma('user_version = 35');
  old.close();

  await db.open({ embeddingDim: 4 });
  const have = new Set(columns());
  assert.ok(have.has('language_primary'));
  assert.ok(have.has('languages'));
  assert.ok(have.has('audio_descriptors'));
  assert.ok(have.has('audio_descriptor_scores_json'));
  assert.ok((requireDb().prepare('PRAGMA table_info(audio_embedding_meta)').all() as Array<{ name: string }>)
    .some(row => row.name === 'descriptor_vocab_hash'));
  assert.deepEqual(requireDb().prepare('SELECT audio_descriptors, audio_descriptor_scores_json FROM tracks WHERE id = ?')
    .get('spanish'), { audio_descriptors: '["piano"]', audio_descriptor_scores_json: '{"piano":0.9}' });
  assert.equal(requireDb().pragma('user_version', { simple: true }), 37);
});

test('a version-35 request library gains the descriptor columns', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  old.prepare('UPDATE tracks SET language_primary = ?, languages = ? WHERE id = ?')
    .run('Hindi', '["Hindi"]', 'spanish');
  dropLanguageStatsIndex(old);
  old.exec(`
    ALTER TABLE tracks DROP COLUMN audio_descriptors;
    ALTER TABLE tracks DROP COLUMN audio_descriptor_scores_json;
    ALTER TABLE audio_embedding_meta DROP COLUMN descriptor_vocab_hash;
  `);
  old.pragma('user_version = 35');
  old.close();

  await db.open({ embeddingDim: 4 });
  const have = new Set(columns());
  assert.ok(have.has('language_primary'));
  assert.ok(have.has('languages'));
  assert.ok(have.has('audio_descriptors'));
  assert.ok(have.has('audio_descriptor_scores_json'));
  assert.ok((requireDb().prepare('PRAGMA table_info(audio_embedding_meta)').all() as Array<{ name: string }>)
    .some(row => row.name === 'descriptor_vocab_hash'));
  assert.deepEqual(requireDb().prepare('SELECT language_primary, languages FROM tracks WHERE id = ?').get('spanish'),
    { language_primary: 'Hindi', languages: '["Hindi"]' });
  assert.equal(requireDb().pragma('user_version', { simple: true }), 37);
});

test('a version-36 request library gains the Sound: column', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  // An earlier build of this branch numbered its own step 36, so a library it
  // left there has language but not develop's #2240 column, and develop's 36
  // never runs on it.
  old.prepare('UPDATE tracks SET language_primary = ?, languages = ? WHERE id = ?')
    .run('Hindi', '["Hindi"]', 'spanish');
  old.exec('ALTER TABLE tracks DROP COLUMN text_vector_sound;');
  old.pragma('user_version = 36');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.ok(columns().includes('text_vector_sound'));
  assert.deepEqual(requireDb().prepare('SELECT language_primary, languages FROM tracks WHERE id = ?').get('spanish'),
    { language_primary: 'Hindi', languages: '["Hindi"]' });
  assert.equal(requireDb().pragma('user_version', { simple: true }), 37);
});
