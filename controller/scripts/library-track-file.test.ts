// GET /library/track/:id/file (routes/library/browse.ts): the file behind a
// Library row, read when the operator opens its track editor. Two copies of
// one song (a compilation and the original EP) read the same in every list;
// their paths tell them apart. Admin-only, 404 for an id the mirror lacks.
//
// Run: `npm test -- library-track-file`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-track-file-'));
process.env.STATE_DIR = stateDir;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'admin-pass';

const express = (await import('express')).default;
const db = await import('../src/music/library-db.js');
const { router } = await import('../src/routes/library/browse.js');

await db.open({ embeddingDim: 8 });
const song = { title: 'Same Song', artist: 'Same Artist', album: 'Same Album', duration: 241 };
db.upsertTrackMeta('ep-copy', {
  ...song, filePath: 'Same Artist/Same Album (EP)/01 Same Song.flac',
  fileSuffix: 'FLAC', fileSize: 31_457_280, bitRate: 1041,
});
db.upsertTrackMeta('comp-copy', {
  ...song, filePath: 'Compilations/Best Of/07 Same Song.mp3', fileSuffix: 'mp3', bitRate: 320,
});
db.upsertTrackMeta('no-file', { ...song });

const app = express();
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
type TrackFile = { filePath: string | null; fileSuffix: string | null; fileSize: number | null };
const ADMIN = { Authorization: `Basic ${Buffer.from('admin:admin-pass').toString('base64')}` };

after(async () => {
  server.close();
  db.close();
  await removeTempDir(stateDir);
});

test('answers the file behind each copy of a duplicated song', async () => {
  const ep = await fetch(`${base}/library/track/ep-copy/file`, { headers: ADMIN });
  assert.equal(ep.status, 200);
  assert.deepEqual(await ep.json(), {
    id: 'ep-copy', filePath: 'Same Artist/Same Album (EP)/01 Same Song.flac',
    fileSuffix: 'flac', fileSize: 31_457_280, bitRate: 1041, durationSec: 241,
  });
  const comp = await (await fetch(`${base}/library/track/comp-copy/file`, { headers: ADMIN })).json() as TrackFile;
  assert.equal(comp.filePath, 'Compilations/Best Of/07 Same Song.mp3');
  assert.equal(comp.fileSize, null);
});

test('a row no walk reported a file for answers nulls, not an error', async () => {
  const r = await fetch(`${base}/library/track/no-file/file`, { headers: ADMIN });
  assert.equal(r.status, 200);
  const f = await r.json() as TrackFile;
  assert.equal(f.filePath, null);
  assert.equal(f.fileSuffix, null);
});

test('404 for an id the library does not hold; 401 without admin auth', async () => {
  assert.equal((await fetch(`${base}/library/track/nope/file`, { headers: ADMIN })).status, 404);
  assert.equal((await fetch(`${base}/library/track/ep-copy/file`)).status, 401);
});
