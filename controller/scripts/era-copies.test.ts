// Era review: a recording's copies (the album's folder and a playlist folder)
// fold under one entry, and the album names its main folder.
//
// Run: npm test -- era-copies

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-era-copies-'));
process.env.STATE_DIR = dir;

const db = await import('../src/music/library-db.js');
const era = await import('../src/music/era-review.js');
const copies = await import('../src/music/era-copies.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
after(async () => { db.close(); await removeTempDir(dir); });
const d = () => db.getDb()!;

const ALBUM = '/music/D/Discothèque/David Bowie/Heroes (1977)';
const row = (id: string, title: string, durationSec: number | null, filePath: string | null) =>
  ({ id, title, artist: 'David Bowie', durationSec, filePath });

test('the main folder is the one holding most files; a tie goes to sort order, not row order', () => {
  const rows = [row('a', 'x', 1, `${ALBUM}/01.flac`), row('b', 'y', 1, `${ALBUM}/02.flac`), row('c', 'z', 1, '/music/D/PLAYLISTS/Rock/03.flac')];
  assert.equal(copies.mainFolderOf(rows), ALBUM);
  assert.equal(copies.mainFolderOf([rows[2], rows[0]]), ALBUM < '/music/D/PLAYLISTS/Rock' ? ALBUM : '/music/D/PLAYLISTS/Rock');
  assert.equal(copies.mainFolderOf([rows[0], rows[2]]), copies.mainFolderOf([rows[2], rows[0]]));
  assert.equal(copies.mainFolderOf([row('n', 'x', 1, null)]), null);
});

test('a playlist copy folds under the album copy; an edit and an extended mix stay apart', () => {
  const rows = [
    row('pl', 'Heroes', 371, '/music/D/PLAYLISTS/Rock/David Bowie - Heroes.flac'),
    row('al', '"Heroes"', 371, `${ALBUM}/03 - Heroes.flac`),
    row('al2', 'Heroes', 371, `${ALBUM}/03 - Heroes.flac.copy`),
    row('ed', 'Acid Dreams', 220, `${ALBUM}/06 - Acid Dreams.flac`),
    row('ext', 'Acid Dreams', 434, `${ALBUM}/16 - Acid Dreams.flac`),
    row('nolen', 'Acid Dreams', null, `${ALBUM}/26 - Acid Dreams.flac`),
  ];
  const g = copies.groupCopies(rows);
  const byPrimary = Object.fromEntries(g.map(x => [x.primary.id, x.copies.map(c => c.id)]));
  assert.deepEqual(byPrimary.al2, ['pl'], 'same title, artist and length: one recording, main-folder file shown');
  assert.deepEqual(byPrimary.al, [], '"Heroes" with quotes is another title');
  assert.deepEqual(byPrimary.ed, []);
  assert.deepEqual(byPrimary.ext, [], 'different length: not a copy');
  assert.deepEqual(byPrimary.nolen, [], 'unknown length never folds');
  assert.deepEqual(g.map(x => x.primary.id), ['al', 'al2', 'ed', 'ext', 'nolen'], 'main folder first, by file name');
});

test('the Era listing and track list fold copies and name the main folder', () => {
  const album = 'Heroes';
  const ov = era.loadEraOverrides(d());
  const f = era.eraWalkFields({ album, albumArtist: 'David Bowie', albumEraUntrusted: true, albumEraReason: 'title-compilation' }, ov);
  const put = (id: string, title: string, dur: number, filePath: string) =>
    db.upsertTrackMeta(id, { title, artist: 'David Bowie', album, year: 1977, duration: dur, filePath, ...f });
  put('h1', 'Beauty And The Beast', 216, `${ALBUM}/01 - Beauty And The Beast.flac`);
  put('h3', 'Heroes', 371, `${ALBUM}/03 - Heroes.flac`);
  put('h3pl', 'Heroes', 371, '/music/D/PLAYLISTS/Rock/David Bowie - Heroes.flac');
  put('h9', 'Neuköln', 271, '/music/D/PLAYLISTS/Rock/David Bowie - Neuköln.flac');
  const key = era.albumEraKey('David Bowie', album);
  const a = era.listEraAlbums(d()).find(x => x.albumKey === key)!;
  assert.equal(a.tracks, 4, 'every file still counts');
  assert.equal(a.copies, 1);
  assert.equal(a.mainFolder, ALBUM);
  const tracks = era.listEraAlbumTracks(d(), key);
  assert.deepEqual(tracks.map(t => [t.id, t.fileName, t.folder, t.copies.map(c => c.id)]), [
    ['h1', '01 - Beauty And The Beast.flac', null, []],
    ['h3', '03 - Heroes.flac', null, ['h3pl']],
    ['h9', 'David Bowie - Neuköln.flac', '/music/D/PLAYLISTS/Rock', []],
  ]);
  assert.equal(tracks[1].copies[0].folder, '/music/D/PLAYLISTS/Rock');
  assert.equal(tracks[0].durationSec, 216);
});

test('the copy shown is the main-folder one even when a playlist path sorts first; case folds, artist and zero length do not', () => {
  const rows = [
    row('a1', 'Heroes', 371, `${ALBUM}/03 - Heroes.flac`),
    row('a2', 'Low', 200, `${ALBUM}/04 - Low.flac`),
    { ...row('pl', 'HEROES', 371, '/music/A-PLAYLISTS/Heroes.flac') },
    { ...row('other', 'Heroes', 371, '/music/A-PLAYLISTS/Heroes (cover).flac'), artist: 'Someone Else' },
    row('z1', 'Silence', 0, `${ALBUM}/90.flac`),
    row('z2', 'Silence', 0, `${ALBUM}/91.flac`),
  ];
  const g = copies.groupCopies(rows);
  const byPrimary = Object.fromEntries(g.map(x => [x.primary.id, x.copies.map(c => c.id)]));
  assert.deepEqual(byPrimary.a1, ['pl'], 'case-insensitive title; the album copy is the one shown');
  assert.ok('other' in byPrimary, 'another artist is another recording');
  assert.ok('z1' in byPrimary && 'z2' in byPrimary, 'a zero length never folds');
});
