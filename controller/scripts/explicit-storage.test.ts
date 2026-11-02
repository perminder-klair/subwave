// tracks.explicit_status: what a library walk stores of OpenSubsonic's
// `explicitStatus`, and who may change it.
//
// Driven through the real walk against a stubbed Navidrome and a real SQLite
// file, because the write rule is not a COALESCE like its neighbours: a writer
// with no opinion must not blank a walked value, but a walk that sees the tag
// gone must clear it. A pure test of the normaliser passes while that is broken.
// Run: `npm test -- explicit-storage`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-explicit-storage-'));
process.env.STATE_DIR = dir;
process.env.NAVIDROME_URL = 'http://explicit-walk.invalid';
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { walkNavidrome } = await import('../src/music/tag-library/flags.js');
await library.load();

const realFetch = globalThis.fetch;
let album: Array<Record<string, unknown>> = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'explicit-walk.invalid', 'no live service calls');
  const endpoint = url.pathname.split('/').at(-1);
  const data = endpoint === 'getAlbumList2'
    ? { albumList2: { album: url.searchParams.get('offset') === '0' ? [{ id: 'alb', name: 'Album', artist: 'Act' }] : [] } }
    : endpoint === 'getAlbum' ? { album: { id: 'alb', name: 'Album', artist: 'Act', song: album } } : {};
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', openSubsonic: true, ...data } });
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  library.shutdown();
  await removeTempDir(dir);
});

const song = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, artist: 'Act', album: 'Album', duration: 200, ...extra });
const stored = (id: string) => (db.getDb()!
  .prepare('SELECT explicit_status FROM tracks WHERE id = ?').get(id) as { explicit_status: string | null }).explicit_status;

test('a walk stores the two real values and nothing else', async () => {
  album = [
    song('e', { explicitStatus: 'explicit' }),
    song('c', { explicitStatus: 'clean' }),
    song('blank', { explicitStatus: '' }),
    song('junk', { explicitStatus: 'Explicit' }),
    song('number', { explicitStatus: 1 }),
    song('absent'),
  ];
  await walkNavidrome();
  assert.equal(stored('e'), 'explicit');
  assert.equal(stored('c'), 'clean');
  for (const id of ['blank', 'junk', 'number', 'absent']) assert.equal(stored(id), null, id);
});

test('a writer with no opinion leaves a walked value alone', () => {
  db.upsertTrackMeta('e', { title: 'renamed by hand' });
  library.set('e', { title: 'renamed again', artist: 'Act' });
  assert.equal(stored('e'), 'explicit');
  assert.equal(db.getTrack('e')?.title, 'renamed again');
});

test('a walk that sees the tag gone clears it, whichever way the server says so', async () => {
  album = [song('e', { explicitStatus: '' }), song('c')];
  await walkNavidrome();
  assert.equal(stored('e'), null, "the spec's empty string");
  assert.equal(stored('c'), null, 'a server that omits the field');
});

test('a walk can change a tag', async () => {
  album = [song('e', { explicitStatus: 'clean' })];
  await walkNavidrome();
  assert.equal(stored('e'), 'clean');
});

test('every read a filter uses carries the status, so none needs a per-track lookup', async () => {
  album = [song('tagged', { explicitStatus: 'explicit' })];
  await walkNavidrome();
  db.upsertTrackTags('tagged', { moods: ['night'], energy: 'low', source: 'llm' });
  assert.equal(library.get('tagged').explicitStatus, 'explicit');
  assert.equal(db.getTrack('tagged')?.explicitStatus, 'explicit');
  assert.equal(library.candidateFilterTracks().find(t => t.id === 'tagged')?.explicitStatus, 'explicit');
  assert.equal(db.songsByMood('night').find(t => t.id === 'tagged')?.explicitStatus, 'explicit');
  assert.equal(library.songsByEnergy('low').find(t => t.id === 'tagged')?.explicitStatus, 'explicit');
});

test('the column arrives by migration on an existing library, unset until a walk', async () => {
  const d = db.getDb()!;
  db.upsertTrackMeta('old', { title: 'old', artist: 'Act' });
  d.exec('ALTER TABLE tracks DROP COLUMN explicit_status; PRAGMA user_version = 31;');
  library.shutdown();
  await library.load();
  assert.equal(db.getDb()!.pragma('user_version', { simple: true }), 33);
  assert.equal(stored('old'), null);
  assert.equal(db.getTrack('old')?.title, 'old');
});

test('a wound-back user_version does not trip over the column it still has', async () => {
  db.getDb()!.exec('PRAGMA user_version = 31;');
  library.shutdown();
  await library.load();
  assert.equal(db.getDb()!.pragma('user_version', { simple: true }), 33);
});

test('the walk owns it, so an id rotation leaves the new row its own answer', () => {
  const plan = db.columnPlan();
  assert.ok(plan.walkOwned.includes('explicit_status'));
  assert.deepEqual(plan.unclassified, []);
});
