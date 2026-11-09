// A heart follows its file (music/heart-follow.ts over heart-follow-policy.ts).
//
// Music servers derive a track id from the file path, so a re-import brings a
// hearted song back under a new id and the old row is pruned. On one station 20
// of 125 hearted songs pointed at ids the library no longer held: the Liked view
// showed them with no BPM or key, and the DJ's favourites lost them. A heart
// whose id has left the library now moves to the track holding the same song
// (title and artist through the blocklist's name fold, the same length within a
// few seconds, the same album when several copies remain), and stays put when
// that is not exactly one track.
//
// Run: npm test -- heart-follow
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-heart-follow-'));
process.env.STATE_DIR = stateDir;

const { planHeartMoves, DURATION_TOLERANCE_SEC } = await import('../src/music/heart-follow-policy.js');

const row = (id: string, title: string, artist: string, album: string | null, durationSec: number | null = 240) =>
  ({ id, title, artist, album, durationSec });
const heart = (songId: string, title: string, artist: string, album: string | null = 'LP', duration: number | null = 240) =>
  ({ songId, title, artist, album, durationSec: duration });

test('one track left with the same title and artist takes the heart', () => {
  const moves = planHeartMoves([heart('old', 'Jewelry', 'Blood Orange')], [
    row('new', 'Jewelry', 'Blood Orange', 'Another album'),
    row('x', 'Jewelry (Remix)', 'Blood Orange', 'LP'),
  ]);
  assert.deepEqual([...moves], [['old', 'new']]);
});

test('names fold case, spacing and apostrophes, as the blocklist does', () => {
  const moves = planHeartMoves([heart('old', 'Black Rice ', 'Gespona')], [row('new', 'black  rice', 'GESPONA', 'LP')]);
  assert.equal(moves.get('old'), 'new');
});

test('a track of another length is another recording', () => {
  assert.equal(planHeartMoves([heart('old', 'Song', 'Act', 'LP', 240)],
    [row('edit', 'Song', 'Act', 'LP', 240 + DURATION_TOLERANCE_SEC + 1)]).size, 0);
  assert.equal(planHeartMoves([heart('old', 'Song', 'Act', 'LP', 240)],
    [row('re-encode', 'Song', 'Act', 'LP', 240 + DURATION_TOLERANCE_SEC)]).get('old'), 're-encode');
});

test('an unknown length on either side does not rule a track out', () => {
  assert.equal(planHeartMoves([heart('old', 'Song', 'Act', 'LP', null)], [row('new', 'Song', 'Act', 'LP', 300)]).get('old'), 'new');
  assert.equal(planHeartMoves([heart('old', 'Song', 'Act', 'LP', 300)], [row('new', 'Song', 'Act', 'LP', null)]).get('old'), 'new');
});

test('several copies: the one on the same album, if exactly one is', () => {
  const lib = [row('a', 'Ghost Highway', 'Mazzy Star', 'So Tonight That I Might See'), row('b', 'Ghost Highway', 'Mazzy Star', 'Best Of')];
  assert.equal(planHeartMoves([heart('old', 'Ghost Highway', 'Mazzy Star', 'Best Of')], lib).get('old'), 'b');
  assert.equal(planHeartMoves([heart('old', 'Ghost Highway', 'Mazzy Star', 'Another')], lib).size, 0, 'no album match: stays');
  assert.equal(planHeartMoves([heart('old', 'Ghost Highway', 'Mazzy Star', null)], lib).size, 0, 'no album on the heart: stays');
  assert.equal(planHeartMoves([heart('old', 'Ghost Highway', 'Mazzy Star', null)],
    [...lib, row('c', 'Ghost Highway', 'Mazzy Star', null)]).size, 0, 'a missing album never matches a missing album');
  const twins = [row('a', 'Intro', 'Act', 'LP'), row('b', 'Intro', 'Act', 'LP')];
  assert.equal(planHeartMoves([heart('old', 'Intro', 'Act', 'LP')], twins).size, 0, 'two copies on the album: stays');
});

test('no match, or a snapshot without a title or an artist, stays put', () => {
  assert.equal(planHeartMoves([heart('old', 'Dance With Me', 'DIM KELLY')], [row('n', 'Dance', 'DIM KELLY', 'LP')]).size, 0);
  assert.equal(planHeartMoves([heart('old', '', 'Act')], [row('n', '', 'Act', 'LP')]).size, 0);
  assert.equal(planHeartMoves([{ songId: 'old', title: 'Song' }], [row('n', 'Song', '', 'LP')]).size, 0);
});

// The real chain: likes.json, the library, followMovedHearts.
const NOW = new Date().toISOString();
writeFileSync(join(stateDir, 'likes.json'), JSON.stringify({
  secret: 'test-secret',
  likes: [
    // An operator heart and a listener like on the pruned id of one song.
    { songId: 'gone-1', track: { id: 'gone-1', title: 'Jewelry', artist: 'Blood Orange', album: 'Negro Swan', duration: 200 }, airingKey: 'gone-1|operator', listenerKey: 'operator', likedAt: NOW, via: 'operator' },
    { songId: 'gone-1', track: { id: 'gone-1', title: 'Jewelry', artist: 'Blood Orange', album: 'Negro Swan', duration: 200 }, airingKey: 'gone-1|2026-11-01T10:00:00.000Z', listenerKey: 'aaaaaaaaaaaaaaaaaaaaaaaa', likedAt: NOW },
    // The operator hearted the new copy too, before the fix: one heart must remain.
    { songId: 'live-1', track: { id: 'live-1', title: 'Jewelry', artist: 'Blood Orange', album: 'Negro Swan', duration: 200 }, airingKey: 'live-1|operator', listenerKey: 'operator', likedAt: NOW, via: 'operator' },
    // A song that left the library for good.
    { songId: 'gone-2', track: { id: 'gone-2', title: 'Dance With Me', artist: 'DIM KELLY' }, airingKey: 'gone-2|operator', listenerKey: 'operator', likedAt: NOW, via: 'operator' },
    // A heart on a track still in the library is never touched.
    { songId: 'kept', track: { id: 'kept', title: 'Arte', artist: 'Monolake' }, airingKey: 'kept|operator', listenerKey: 'operator', likedAt: NOW, via: 'operator' },
  ],
}));

const db = await import('../src/music/library-db.js');
const likes = await import('../src/broadcast/likes.js');
const { followMovedHearts } = await import('../src/music/heart-follow.js');
const { recordWalk } = await import('../src/music/library-walk.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
// No Navidrome here: the star write-back is fire-and-forget, so keep it off.
const settings = await import('../src/settings.js');
await settings.load();
await settings.update({ likes: { starInNavidrome: false } });
after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

test('an empty library moves nothing: a first boot is not every song leaving', async () => {
  assert.deepEqual(await followMovedHearts(), { stale: 0, moved: 0 });
  assert.equal(likes.likedSongs().filter((s) => s.songId === 'gone-1').length, 1);
});

test('a part-walked library moves nothing: no walk on record, a run still going, or one stopped', async () => {
  db.upsertTrackMeta('live-1', { title: 'Jewelry', artist: 'Blood Orange', album: 'Negro Swan', duration: 201 });
  for (const state of [null, 'running', 'stopped', 'failed'] as const) {
    if (state) recordWalk('tag', state);
    assert.deepEqual(await followMovedHearts(), { stale: 0, moved: 0, skipped: 'walk-unsettled' }, String(state));
  }
  assert.equal(likes.likedSongs().filter((s) => s.songId === 'gone-1').length, 1, 'the heart stayed');
  recordWalk('tag', 'ok');
});

test('a heart on a pruned id moves to the same song, once, and stays on disk', async () => {
  db.upsertTrackMeta('live-1', { title: 'Jewelry', artist: 'Blood Orange', album: 'Negro Swan', duration: 201 });
  db.upsertTrackMeta('kept', { title: 'Arte', artist: 'Monolake', album: 'Hongkong', duration: 300 });
  db.upsertTrackMeta('other', { title: 'Dance', artist: 'DIM KELLY', album: 'LP', duration: 200 });

  assert.deepEqual(await followMovedHearts(), { stale: 2, moved: 1 });
  const songs = new Map(likes.likedSongs().map((s) => [s.songId, s]));
  assert.equal(songs.has('gone-1'), false);
  assert.equal(songs.get('live-1')?.count, 2, 'one operator heart plus the listener like');
  assert.equal(songs.get('live-1')?.operator, true);
  assert.equal(songs.has('gone-2'), true, 'no match: left as it was');
  assert.equal(songs.has('kept'), true);
  assert.equal(likes.index()['live-1']?.count, 2);

  const onDisk = JSON.parse(readFileSync(join(stateDir, 'likes.json'), 'utf8')) as { likes: Array<{ songId: string; airingKey: string; via?: string }> };
  assert.equal(onDisk.likes.filter((r) => r.songId === 'gone-1').length, 0);
  assert.equal(onDisk.likes.filter((r) => r.songId === 'live-1' && r.via === 'operator').length, 1);
  assert.ok(onDisk.likes.some((r) => r.airingKey === 'live-1|2026-11-01T10:00:00.000Z'), 'the airing key follows the id');

  const unliked = await likes.operatorUnlike('live-1');
  assert.deepEqual(unliked, { removed: true, count: 1 }, 'one unlike takes the one heart; the listener like stays');
});

test('a second pass has nothing new to do', async () => {
  assert.deepEqual(await followMovedHearts(), { stale: 1, moved: 0 });
});
