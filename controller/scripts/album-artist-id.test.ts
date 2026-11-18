// The library walks store each track's first album artist id (album_artist_id,
// #2333), so a prepared artist episode reads the same set from the mirror as
// from the artist's albums (music/artist-credit.ts).
//
// Pinned here:
//   - the column and its index are added on open;
//   - the id is the song's first album artist, else the album record's artist
//     (artist-credit.firstAlbumArtistId), the rule the albums path judges by;
//   - both library walks store it: the tagger's walkNavidrome and the
//     analyzer's own walk, each run for real against a fake Navidrome;
//   - a writer without it never clears it;
//   - ID adoption leaves an adopted row with what its own walk reported.
// Run: `npm test -- album-artist-id`.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import Database from 'better-sqlite3';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// A fake Navidrome with one album, filed under its own artist id.
let songs: Array<Record<string, unknown>> = [];
const navidrome = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const endpoint = url.pathname.split('/').at(-1);
  const body: Record<string, unknown> = { status: 'ok' };
  if (endpoint === 'getAlbumList2') {
    body.albumList2 = { album: Number(url.searchParams.get('offset') ?? 0) ? [] : [{ id: 'album', name: 'Album', artist: 'Leader', artistId: 'leader' }] };
  }
  if (endpoint === 'getAlbum') body.album = { id: 'album', name: 'Album', artist: 'Leader', artistId: 'leader', song: songs };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ 'subsonic-response': body }));
});
await new Promise<void>((resolve) => navidrome.listen(0, '127.0.0.1', resolve));
process.env.NAVIDROME_URL = `http://127.0.0.1:${(navidrome.address() as AddressInfo).port}`;
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

const dir = createTempDir(join(tmpdir(), 'subwave-album-artist-id-'));
process.env.STATE_DIR = dir;
const db = await import('../src/music/library-db.js');
const { walkNavidrome } = await import('../src/music/tag-library/flags.js');
const { firstAlbumArtistId, songCredit, creditsArtist } = await import('../src/music/artist-credit.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
after(async () => {
  db.close();
  navidrome.closeAllConnections();
  await new Promise((resolve) => navidrome.close(resolve));
  await removeTempDir(dir);
});

const stored = (id: string) => (db.getDb()!.prepare('SELECT album_artist_id AS id FROM tracks WHERE id = ?').get(id) as { id: string | null } | undefined)?.id;

const hasIndex = () => !!db.getDb()!.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_tracks_album_artist_id'`).get();

test('the column and its index exist after open, and the mirror read uses both id indexes', () => {
  const cols = (db.getDb()!.pragma('table_info(tracks)') as Array<{ name: string; type: string }>).filter(c => c.name === 'album_artist_id');
  assert.deepEqual(cols.map(c => c.type), ['TEXT']);
  assert.ok(hasIndex());
  const plan = (db.getDb()!.prepare('EXPLAIN QUERY PLAN SELECT id FROM tracks WHERE artist_id = ? OR album_artist_id = ?').all('a', 'a') as Array<{ detail: string }>)
    .map(r => r.detail).join(' | ');
  assert.match(plan, /idx_tracks_artist_id/);
  assert.match(plan, /idx_tracks_album_artist_id/);
});

test('the index is a read accelerator: a missing one is rebuilt by the next open, a locked build never fails it', (t) => {
  db.getDb()!.exec('DROP INDEX idx_tracks_album_artist_id');
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const rival = new Database(join(dir, 'library.db'));
  db.getDb()!.pragma('busy_timeout = 50');
  try {
    rival.exec('BEGIN IMMEDIATE');
    assert.doesNotThrow(() => db.ensureStatsIndexes());
    assert.equal(hasIndex(), false);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    if (rival.inTransaction) rival.exec('ROLLBACK');
    rival.close();
    db.getDb()!.pragma('busy_timeout = 5000');
  }
  // What open() runs last (lifecycle.ts): the repair.
  db.ensureStatsIndexes();
  assert.equal(hasIndex(), true);
});

test('the id is the first album artist, else the album record\'s, and the credit rule reads it', () => {
  assert.equal(firstAlbumArtistId({ albumArtists: [{ id: 'tony' }, { id: 'bill' }] }, { artistId: 'other' }), 'tony');
  assert.equal(firstAlbumArtistId({}, { artistId: 'leader' }), 'leader');
  assert.equal(firstAlbumArtistId({ albumArtists: [] }, null), null);
  // A group credit on the artist's own record, a first credit on someone
  // else's, and a second album artist (not the artist's).
  assert.equal(creditsArtist(songCredit({ artistId: 'trio', albumArtists: [{ id: 'bill' }] }), 'bill'), true);
  assert.equal(creditsArtist(songCredit({ artistId: 'bill', albumArtists: [{ id: 'konitz' }] }), 'bill'), true);
  // Albums path only: the mirror stores no first-track-artist id, and stock
  // Navidrome 0.55+ never sends a combined artistId beside an artists list.
  assert.equal(creditsArtist(songCredit({ artistId: 'combined', artists: [{ id: 'bill' }, { id: 'tony' }] }), 'bill'), true);
  assert.equal(creditsArtist(songCredit({ artistId: 'tony', albumArtists: [{ id: 'tony' }, { id: 'bill' }] }), 'bill'), false);
});

test('walkNavidrome stores it; a writer without it keeps it', async () => {
  songs = [
    { id: 'listed', title: 'Listed', artist: 'Trio', artistId: 'trio', album: 'Album', duration: 200, albumArtists: [{ id: 'bill', name: 'Bill' }] },
    { id: 'unlisted', title: 'Unlisted', artist: 'Leader', artistId: 'leader', album: 'Album', duration: 200 },
  ];
  await walkNavidrome();
  assert.equal(stored('listed'), 'bill');
  assert.equal(stored('unlisted'), 'leader', 'no albumArtists: the album record\'s artist');
  db.upsertTrackMeta('listed', { title: 'Edited' });
  assert.equal(stored('listed'), 'bill');
});

test('the analyzer walk stores it', async () => {
  songs = [{ id: 'analyzer-walk', title: 'Song', artist: 'Trio', artistId: 'trio', album: 'Album', duration: 200, albumArtists: [{ id: 'bill' }] }];
  const cliDir = createTempDir(join(tmpdir(), 'subwave-album-artist-id-cli-'));
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
    const library = new Database(join(cliDir, 'library.db'), { readonly: true });
    try {
      assert.deepEqual(library.prepare('SELECT album_artist_id FROM tracks WHERE id = ?').get('analyzer-walk'), { album_artist_id: 'bill' });
    } finally {
      library.close();
    }
  } finally {
    await removeTempDir(cliDir);
  }
});

test('an adopted row keeps what its own walk reported', () => {
  // Golden id pairs from scripts/id-adoption.test.ts.
  const [OLD_MOVED, NEW_MOVED] = ['e3b7fc2ae9447bbec37a13bf916e3cf6', '6VHl3uR4kss6sUPKA8Cwnk'];
  db.upsertTrackMeta(OLD_MOVED, { title: 'Old', albumArtistId: 'old-leader' });
  db.upsertTrackMeta(NEW_MOVED, { title: 'New', albumArtistId: 'new-leader' });
  assert.equal(db.adoptRotatedIds(new Set([NEW_MOVED])).adopted, 1);
  assert.equal(stored(NEW_MOVED), 'new-leader');
});
