// The library walk keeps each track's file facts as Navidrome reports them
// (path, format, size, bitrate) so the library status exports can list files
// without a Navidrome call per track.
//
// Pinned here:
//   - the columns are added on open, and opening again changes nothing;
//   - the walk's Subsonic child maps to the four fields (walkFileInfo);
//   - a writer without file facts (manual edit, analyzer top-up) never clears
//     the stored ones, and a later walk updates them.
// Run: `npm test -- library-file-info`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-file-info-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
const { walkFileInfo } = await import('../src/music/tag-library/flags.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
after(async () => { db.close(); await removeTempDir(dir); });

const cols = () => (db.getDb()!.pragma('table_info(tracks)') as Array<{ name: string; type: string }>)
  .filter((c) => ['file_path', 'file_suffix', 'file_size', 'bit_rate'].includes(c.name))
  .map((c) => `${c.name} ${c.type}`);
const row = (id: string) => db.getDb()!
  .prepare('SELECT file_path, file_suffix, file_size, bit_rate FROM tracks WHERE id = ?').get(id);

test('the file columns exist after open, and a second open is a no-op', async () => {
  assert.deepEqual(cols(), ['file_path TEXT', 'file_suffix TEXT', 'file_size INTEGER', 'bit_rate INTEGER']);
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
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
  // A manual edit or the analyzer's metadata top-up has no file facts.
  db.upsertTrackMeta('w1', { title: 'Song (edit)' });
  assert.equal((row('w1') as { file_path: string }).file_path, '/music/Artist/Album/03 - Song.MP3');
  // The file was replaced by a FLAC: the next walk wins. A new size is a
  // replacement: the walk stores it with the clear at its end
  // (replaced-file.test.ts pins the hold in between).
  const flac = walkFileInfo({ path: '/music/Artist/Album/03 - Song.flac', suffix: 'flac', size: 30_000_000, bitRate: 900 });
  assert.equal(db.upsertTrackMeta('w1', flac), true);
  db.clearTrackAudio('w1', flac.fileSize);
  assert.deepEqual(row('w1'),
    { file_path: '/music/Artist/Album/03 - Song.flac', file_suffix: 'flac', file_size: 30_000_000, bit_rate: 900 });
});
