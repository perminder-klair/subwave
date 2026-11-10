// A blocked track stays blocked when its file comes back under a new id.
//
// Music servers derive a track id from the file path, so a blocked file that is
// moved, renamed or re-encoded returns under a new id and the id tier misses it:
// on one station a blocked remix was back in the pool after its folder moved.
// A track entry now also matches on its full (title, artist, album) snapshot,
// through the same name fold as the album tier. Title alone, or title and
// artist on another release, never matches.
//
// Run: npm test -- blocklist-follows-file
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-blocklist-follows-file-'));
process.env.STATE_DIR = stateDir;

const blocklist = await import('../src/music/blocklist.js');
await blocklist.load();
after(async () => { await removeTempDir(stateDir); });

const ENTRY = {
  type: 'track' as const,
  id: 'old-id',
  name: 'For The Love Of Money (Toshiyuki Goto Remix)',
  artist: 'Disco Dub Band',
  album: 'For The Love Of Money EP',
};
await blocklist.add(ENTRY);

test('the same recording under a new id is still blocked, as a track', () => {
  const moved = { id: 'new-id', title: ENTRY.name, artist: ENTRY.artist, album: ENTRY.album };
  const hit = blocklist.hitOf(moved);
  assert.deepEqual(hit, { kind: 'entry', type: 'track', id: 'old-id', name: ENTRY.name });
});

test('the name tier folds case, spacing and apostrophes like the album tier', () => {
  assert.equal(blocklist.isBlocked({
    id: 'x', title: 'for the love of money  (toshiyuki goto remix)', artist: 'DISCO DUB BAND', album: 'For The Love Of Money EP',
  }), true);
});

test('title alone, or title and artist on another release, stays playable', () => {
  assert.equal(blocklist.isBlocked({ id: 'a', title: ENTRY.name }), false);
  assert.equal(blocklist.isBlocked({ id: 'b', title: ENTRY.name, artist: ENTRY.artist }), false);
  assert.equal(blocklist.isBlocked({ id: 'c', title: ENTRY.name, artist: ENTRY.artist, album: 'Disco Dub Band Remixed' }), false);
  assert.equal(blocklist.isBlocked({ id: 'd', title: ENTRY.name, artist: 'Someone Else', album: ENTRY.album }), false);
});

test('an entry without all three snapshot fields never name-matches', async () => {
  await blocklist.add({ type: 'track', id: 'bare', name: 'Song X', artist: 'Y' });
  assert.equal(blocklist.isBlocked({ id: 'other', title: 'Song X', artist: 'Y', album: 'Anything' }), false);
  assert.equal(blocklist.isBlocked({ id: 'bare' }), true, 'the id tier is unchanged');
});

test('unblocking the entry frees the moved copy too', async () => {
  await blocklist.remove('track', 'old-id');
  assert.equal(blocklist.isBlocked({ id: 'new-id', title: ENTRY.name, artist: ENTRY.artist, album: ENTRY.album }), false);
});
