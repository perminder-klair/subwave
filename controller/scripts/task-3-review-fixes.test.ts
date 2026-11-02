import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-task-3-schema-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { requireDb } = await import('../src/music/library-db/handle.js');

function columns(): string[] {
  return (requireDb().prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>).map(row => row.name);
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
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages;');
  old.pragma('user_version = 29');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.equal((raw().pragma('user_version', { simple: true }) as number), 36);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.equal(db.getTrack('spanish')?.title, 'Uno');
});

test('a version-35 library from develop gets the language columns in version 36', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages;');
  old.pragma('user_version = 35');
  old.close();

  await db.open({ embeddingDim: 4 });
  assert.equal((requireDb().pragma('user_version', { simple: true }) as number), 36);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
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
  assert.equal((requireDb().pragma('user_version', { simple: true }) as number), 36);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
  assert.ok(requireDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lyrics_external'").get());
  assert.ok(requireDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lyric_offsets'").get());
  assert.deepEqual(db.languagesByIds(['spanish']).get('spanish'), {
    language: 'Spanish', languages: ['Spanish', 'English'],
  });
});

test('concurrent opens of a develop library serialize the language step', async () => {
  db.close();
  const Database = (await import('better-sqlite3')).default as any;
  const old = new Database(join(stateDir, 'library.db'));
  // Develop's own steps up to 35 are develop's; the language step is this branch's.
  old.exec('ALTER TABLE tracks DROP COLUMN language_primary; ALTER TABLE tracks DROP COLUMN languages;');
  old.pragma('user_version = 35');
  old.close();

  const { spawn } = await import('node:child_process');
  const moduleUrl = new URL('../src/music/library-db.js', import.meta.url).href;
  const handleUrl = new URL('../src/music/library-db/handle.js', import.meta.url).href;
  const code = `const db=await import(${JSON.stringify(moduleUrl)}); await db.open({embeddingDim:4});
    const {requireDb}=await import(${JSON.stringify(handleUrl)});
    const columns=new Set(requireDb().prepare('PRAGMA table_info(tracks)').all().map(row=>row.name));
    if(!columns.has('language_primary')||!columns.has('languages')||!columns.has('explicit_status')||!columns.has('lastfm_track_tags_at')) throw new Error('migrated track columns missing');
    if(requireDb().pragma('user_version',{simple:true})!==36) throw new Error('schema version is not 36');
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
  assert.equal((requireDb().pragma('user_version', { simple: true }) as number), 36);
  assert.ok(columns().includes('language_primary'));
  assert.ok(columns().includes('languages'));
});
