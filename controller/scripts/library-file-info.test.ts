// The library walk keeps each track's file facts as Navidrome reports them
// (path, format, size, bitrate) so the library status exports can list files
// without a Navidrome call per track.
//
// Pinned here:
//   - the columns are added on open, and opening again changes nothing;
//   - a second process racing that first open can't fail it, the ALTERs run
//     under the write lock, and any other failure throws out of open();
//   - the walk's Subsonic child maps to the four fields (walkFileInfo), under the
//     one cleaning rule upsertTrackMeta also applies (cleanFileInfo);
//   - the analyzer's own walk stores them, run for real against a fake Navidrome;
//   - a writer without file facts (a manual edit, say) never clears the stored
//     ones, and a later walk updates them.
// Run: `npm test -- library-file-info`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// A fake Navidrome with one album, for the real analyzer walk.
let songs: Array<Record<string, unknown>> = [];
const navidrome = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const endpoint = url.pathname.split('/').at(-1);
  const body: Record<string, unknown> = { status: 'ok' };
  if (endpoint === 'getAlbumList2') {
    body.albumList2 = { album: Number(url.searchParams.get('offset') ?? 0) ? [] : [{ id: 'album', name: 'Album', artist: 'Artist' }] };
  }
  if (endpoint === 'getAlbum') body.album = { id: 'album', name: 'Album', artist: 'Artist', song: songs };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ 'subsonic-response': body }));
});
await new Promise<void>((resolve) => navidrome.listen(0, '127.0.0.1', resolve));
process.env.NAVIDROME_URL = `http://127.0.0.1:${(navidrome.address() as AddressInfo).port}`;
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const dir = createTempDir(join(tmpdir(), 'subwave-file-info-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
const { walkFileInfo } = await import('../src/music/tag-library/flags.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
after(async () => {
  db.close();
  navidrome.closeAllConnections();
  await new Promise((resolve) => navidrome.close(resolve));
  await removeTempDir(dir);
});

const cols = () => (db.getDb()!.pragma('table_info(tracks)') as Array<{ name: string; type: string }>)
  .filter((c) => ['file_path', 'file_suffix', 'file_size', 'bit_rate'].includes(c.name))
  .map((c) => `${c.name} ${c.type}`);
const FACTS = 'SELECT file_path, file_suffix, file_size, bit_rate FROM tracks WHERE id = ?';
const row = (id: string) => db.getDb()!.prepare(FACTS).get(id);

const FILE_COLUMNS: Array<[string, string]> = [
  ['file_path', 'TEXT'], ['file_suffix', 'TEXT'], ['file_size', 'INTEGER'], ['bit_rate', 'INTEGER'],
];
const addColumns = (d: Database.Database) => {
  for (const [name, type] of FILE_COLUMNS) d.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`);
};

// Back to the shape an upgrade finds, closed, so the next open has to add them.
function dropColumns() {
  for (const [name] of FILE_COLUMNS) db.getDb()!.exec(`ALTER TABLE tracks DROP COLUMN ${name}`);
  db.close();
}

// Opens the library with a real second connection acting at a chosen moment:
// `moves[n]` runs right after the opener's nth table_info(tracks) read. The first
// read decides whether to take the lock, the second is the re-read under it.
async function openWithRival(moves: Array<(opener: Database.Database, rival: Database.Database) => void>) {
  const realPragma = Database.prototype.pragma;
  let rival: Database.Database | null = null;
  let reads = 0;
  Database.prototype.pragma = function pragma(this: Database.Database, sql: string, options?: Database.PragmaOptions) {
    const result = realPragma.call(this, sql, options);
    if (this !== rival && sql === 'table_info(tracks)') {
      rival ??= new Database(this.name, { timeout: 0 });
      moves[reads++]?.(this, rival);
    }
    return result;
  };
  try {
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
  } finally {
    Database.prototype.pragma = realPragma;
    (rival as Database.Database | null)?.close();
  }
  return reads;
}

test('the file columns exist after open, and a second open is a no-op', async () => {
  assert.deepEqual(cols(), ['file_path TEXT', 'file_suffix TEXT', 'file_size INTEGER', 'bit_rate INTEGER']);
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.deepEqual(cols(), ['file_path TEXT', 'file_suffix TEXT', 'file_size INTEGER', 'bit_rate INTEGER']);
});

test('a rival that adds the columns between the read and the ALTER cannot fail open()', async () => {
  dropColumns();
  await openWithRival([(_, rival) => addColumns(rival)]);
  assert.deepEqual(cols(), ['file_path TEXT', 'file_suffix TEXT', 'file_size INTEGER', 'bit_rate INTEGER']);
});

test('the ALTERs run under the write lock', async () => {
  dropColumns();
  const reads = await openWithRival([
    () => {},
    // The re-read: a rival must not be able to write until the columns are in.
    (_, rival) => assert.throws(() => rival.exec('BEGIN IMMEDIATE'), { code: 'SQLITE_BUSY' }),
  ]);
  assert.equal(reads, 2);
  assert.deepEqual(cols(), ['file_path TEXT', 'file_suffix TEXT', 'file_size INTEGER', 'bit_rate INTEGER']);
});

test('any other failure throws out of open(), and the next open adds the columns', async () => {
  dropColumns();
  await assert.rejects(openWithRival([(opener, rival) => {
    opener.pragma('busy_timeout = 20'); // the default would hold this test for 5 s
    rival.exec('BEGIN IMMEDIATE');
  }]), { code: 'SQLITE_BUSY' });
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.deepEqual(cols(), ['file_path TEXT', 'file_suffix TEXT', 'file_size INTEGER', 'bit_rate INTEGER']);
});

test('a later open takes no write lock', async () => {
  db.close();
  await openWithRival([(_, rival) => rival.exec('BEGIN IMMEDIATE')]);
  assert.deepEqual(cols(), ['file_path TEXT', 'file_suffix TEXT', 'file_size INTEGER', 'bit_rate INTEGER']);
});

test('a walked child maps to the four file fields', () => {
  assert.deepEqual(
    walkFileInfo({ path: '/music/A/B/01 - X.flac', suffix: 'flac', size: 41_600_000, bitRate: 662 }),
    { filePath: '/music/A/B/01 - X.flac', fileSuffix: 'flac', fileSize: 41_600_000, bitRate: 662 },
  );
  assert.deepEqual(walkFileInfo({ path: '', suffix: ' ', size: 0, bitRate: 'n/a' }),
    { filePath: null, fileSuffix: null, fileSize: null, bitRate: null });
  assert.deepEqual(walkFileInfo(undefined),
    { filePath: null, fileSuffix: null, fileSize: null, bitRate: null });
});

test('the walk stores them, other writers keep them, the next walk updates them', () => {
  const walked = { path: '/music/Artist/Album/03 - Song.MP3', suffix: 'MP3', size: 7_878_806, bitRate: 192 };
  db.upsertTrackMeta('w1', { title: 'Song', artist: 'Artist', album: 'Album', duration: 200, ...walkFileInfo(walked) });
  assert.deepEqual(row('w1'),
    { file_path: '/music/Artist/Album/03 - Song.MP3', file_suffix: 'mp3', file_size: 7_878_806, bit_rate: 192 });
  // A manual edit has no file facts.
  db.upsertTrackMeta('w1', { title: 'Song (edit)' });
  assert.equal((row('w1') as { file_path: string }).file_path, '/music/Artist/Album/03 - Song.MP3');
  // The file was replaced by a FLAC: the next walk wins.
  db.upsertTrackMeta('w1', walkFileInfo({ path: '/music/Artist/Album/03 - Song.flac', suffix: 'flac', size: 30_000_000, bitRate: 900 }));
  assert.deepEqual(row('w1'),
    { file_path: '/music/Artist/Album/03 - Song.flac', file_suffix: 'flac', file_size: 30_000_000, bit_rate: 900 });
});

test('the mapping and the upsert apply one rule', () => {
  const walked = walkFileInfo({ path: '/music/x.FLAC', suffix: 'FLAC', size: 1234.6, bitRate: '320' });
  assert.deepEqual(walked, { filePath: '/music/x.FLAC', fileSuffix: 'flac', fileSize: 1235, bitRate: 320 });
  assert.deepEqual(db.cleanFileInfo(walked), walked, 'a clean value stays as it is');
  db.upsertTrackMeta('rule', walked);
  assert.deepEqual(row('rule'),
    { file_path: '/music/x.FLAC', file_suffix: 'flac', file_size: 1235, bit_rate: 320 });
});

test('a value that rounds to 0 is not reported, so it never overwrites a stored one', () => {
  const stored = { file_path: '/music/y.mp3', file_suffix: 'mp3', file_size: 1000, bit_rate: 662 };
  db.upsertTrackMeta('zero', walkFileInfo({ path: '/music/y.mp3', suffix: 'mp3', size: 1000, bitRate: 662 }));
  assert.deepEqual(walkFileInfo({ size: 0.4, bitRate: 0.4 }),
    { filePath: null, fileSuffix: null, fileSize: null, bitRate: null });
  db.upsertTrackMeta('zero', walkFileInfo({ size: 0.4, bitRate: 0.4 }));
  assert.deepEqual(row('zero'), stored);
  // A caller that skips walkFileInfo gets the same rule.
  db.upsertTrackMeta('zero', { filePath: '   ', fileSuffix: ' ', fileSize: 0.4, bitRate: 0.4 });
  assert.deepEqual(row('zero'), stored);
});

test('the analyzer walk stores what Navidrome reports', async () => {
  songs = [{ id: 'analyzer-walk', title: 'Song', artist: 'Artist', album: 'Album', duration: 200,
    path: '/music/Artist/Album/02.FLAC', suffix: 'FLAC', size: 30_000_000, bitRate: 900 }];
  const cliDir = createTempDir(join(tmpdir(), 'subwave-file-info-cli-'));
  try {
    // Its own state dir: this walk prunes whatever Navidrome did not report.
    const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/music/analyze-library.ts', '--walk'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, STATE_DIR: cliDir, ANALYZE_URL: 'http://127.0.0.1:1', ANALYZE_PYTHON: '' },
      });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.stderr.on('data', (chunk) => { text += chunk; });
      child.on('error', reject);
      child.on('close', (exit) => resolve({ code: exit, output: text }));
    });
    assert.equal(code, 0, output);
    const stored = new Database(join(cliDir, 'library.db'), { readonly: true });
    try {
      assert.deepEqual(stored.prepare(FACTS).get('analyzer-walk'),
        { file_path: '/music/Artist/Album/02.FLAC', file_suffix: 'flac', file_size: 30_000_000, bit_rate: 900 });
    } finally {
      stored.close();
    }
  } finally {
    await removeTempDir(cliDir);
  }
});
