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
// library.db is only as new as its last walk, so a heart on a song added since
// reads as gone from the table while the song is still on the server. A heart
// moves only when Navidrome itself answers "not found" for the old id; a found
// song, an error or a timeout leaves it where it is.
//
// Run: npm test -- heart-follow
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-heart-follow-'));
process.env.STATE_DIR = stateDir;
process.env.NAVIDROME_URL = 'http://navidrome.heart-follow.invalid';
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';

// The Navidrome stand-in: how getSong answers for each id. Unlisted ids are
// "not found" (Subsonic error 70), the answer for a song that left the server.
const navidrome = new Map<string, 'present' | 'broken'>();
const getSongAsked: string[] = [];
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (!url.href.startsWith(process.env.NAVIDROME_URL!)) return realFetch(input, init);
  if (!url.pathname.startsWith('/rest/getSong')) {
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1' } });
  }
  const id = url.searchParams.get('id') ?? '';
  getSongAsked.push(id);
  const answer = navidrome.get(id);
  if (answer === 'broken') return new Response('upstream down', { status: 502 });
  if (answer === 'present') {
    return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', song: { id, title: 'still here' } } });
  }
  return Response.json({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 70, message: 'Song not found' } } });
});

const { planHeartMoves, oldIdVerdict, DURATION_TOLERANCE_SEC } = await import('../src/music/heart-follow-policy.js');

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

test('only a definite "not found" from Navidrome lets a heart move', () => {
  assert.equal(oldIdVerdict({ error: Object.assign(new Error('Subsonic error: Song not found'), { subsonicCode: 70 }) }), 'gone');
  assert.equal(oldIdVerdict({ song: { id: 'x' } }), 'present');
  assert.equal(oldIdVerdict({ song: null }), 'unknown', 'an empty answer is not proof');
  assert.equal(oldIdVerdict({ error: new Error('Subsonic getSong timed out after 30000ms') }), 'unknown');
  assert.equal(oldIdVerdict({ error: Object.assign(new Error('Subsonic getSong failed: 502'), { httpStatus: 502 }) }), 'unknown');
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
    // A deluxe edition added to Navidrome after the last walk, hearted from a
    // search row: not in library.db yet, but still on the server. The standard
    // edition's copy is the one same-length match the table holds.
    { songId: 'deluxe-3', track: { id: 'deluxe-3', title: 'Ivy', artist: 'Frank Ocean', album: 'Blonde (Deluxe)', duration: 249 }, airingKey: 'deluxe-3|operator', listenerKey: 'operator', likedAt: NOW, via: 'operator' },
  ],
}));

const db = await import('../src/music/library-db.js');
const likes = await import('../src/broadcast/likes.js');
const { followMovedHearts } = await import('../src/music/heart-follow.js');
const { recordWalk, lastWalk } = await import('../src/music/library-walk.js');
const library = await import('../src/music/library.js');
navidrome.set('deluxe-3', 'present');
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
  const said: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => { said.push(args.join(' ')); });
  try {
    for (const state of [null, 'running', 'stopped', 'failed'] as const) {
      if (state) recordWalk('tag', state);
      assert.deepEqual(await followMovedHearts(), { stale: 0, moved: 0, skipped: 'walk-unsettled' }, String(state));
    }
  } finally {
    log.mock.restore();
  }
  assert.match(said[0], /no completed library walk recorded yet/, 'no stamp is not a walk that failed');
  assert.match(said[1], /did not finish cleanly/);
  assert.equal(likes.likedSongs().filter((s) => s.songId === 'gone-1').length, 1, 'the heart stayed');
  recordWalk('tag', 'ok');
});

test('a pending id rotation holds the pass: the journal decides those ids, not a name match', async () => {
  const manifest = join(stateDir, 'id-rotation.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, at: NOW, trackMap: {} }));
  try {
    assert.deepEqual(await followMovedHearts(), { stale: 0, moved: 0, skipped: 'rotation-pending' });
  } finally {
    rmSync(manifest, { force: true });
  }
  assert.equal(likes.likedSongs().filter((s) => s.songId === 'gone-1').length, 1, 'the heart stayed');
});

test('Navidrome not answering holds every planned move, and the pass tries again', async () => {
  db.upsertTrackMeta('kept', { title: 'Arte', artist: 'Monolake', album: 'Hongkong', duration: 300 });
  db.upsertTrackMeta('other', { title: 'Dance', artist: 'DIM KELLY', album: 'LP', duration: 200 });
  db.upsertTrackMeta('std-3', { title: 'Ivy', artist: 'Frank Ocean', album: 'Blonde', duration: 249 });
  navidrome.set('gone-1', 'broken');
  getSongAsked.length = 0;
  assert.deepEqual(await followMovedHearts(), { stale: 3, moved: 0, held: 2 });
  assert.deepEqual(getSongAsked, ['gone-1'], 'the first failure stops the lookups');
  assert.equal(likes.likedSongs().filter((s) => s.songId === 'gone-1').length, 1, 'the heart stayed');
  assert.equal(existsSync(join(stateDir, 'heart-follow.json')), false, 'an inconclusive pass bookmarks nothing');
  navidrome.delete('gone-1');
});

test('a heart on a song still on the server stays, though one copy of it is in the table (the deluxe edition)', async () => {
  // Same walk as the held pass above: nothing was bookmarked, so it runs again.
  getSongAsked.length = 0;
  assert.deepEqual(await followMovedHearts(), { stale: 3, moved: 1, held: 1 });
  assert.deepEqual(getSongAsked.sort(), ['deluxe-3', 'gone-1'], 'one lookup per planned move, none for a heart with no match');
  const songs = new Map(likes.likedSongs().map((s) => [s.songId, s]));
  assert.equal(songs.has('deluxe-3'), true, 'the deluxe heart stayed on its own id');
  assert.equal(songs.has('std-3'), false, 'the standard edition was not hearted');
});

test('the heart that moved: one operator heart on the new id, the listener like with it, and on disk', async () => {
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

test('a pass runs once per walk: the same walk is skipped, a new one looks again', async () => {
  assert.deepEqual(await followMovedHearts(), { stale: 0, moved: 0, skipped: 'walk-seen' });
  recordWalk('tag', 'ok', new Date(Date.now() + 60_000));
  getSongAsked.length = 0;
  assert.deepEqual(await followMovedHearts(), { stale: 2, moved: 0, held: 1 }, 'gone-2 has no match; deluxe-3 is still on the server');
  assert.deepEqual(getSongAsked, ['deluxe-3']);
  assert.deepEqual(await followMovedHearts(), { stale: 0, moved: 0, skipped: 'walk-seen' });
});

test('a library reset forgets the walk: hearts wait for the next clean one', async () => {
  assert.equal(lastWalk()?.state, 'ok');
  await library.reset();
  assert.equal(lastWalk(), null);
});
