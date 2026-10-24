// The genre guard's label source: the library mirror first, then only an
// unambiguous list on the track itself.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(path.join(tmpdir(), 'subwave-genre-facts-'));
const library = await import('../src/music/library.js');
const { genreKeysFor } = await import('../src/music/genre-facts.js');

const keysOf = (track: Parameters<typeof genreKeysFor>[0]) => [...genreKeysFor(track).keys()];

before(async () => {
  await library.load();
  library.set('mirrored', { id: 'mirrored', title: 'Mirrored', artist: 'A', genres: ['Dub', 'Roots Reggae'] });
});

after(() => library.shutdown());

test('the mirror row wins over the discovery projection', () => {
  // The projection's comma-joined field says otherwise; the mirror holds the real list.
  assert.deepEqual(keysOf({ id: 'mirrored', genre: 'Soul, Funk' }), ['dub', 'family:reggae', 'rootsreggae']);
});

test('off the mirror, a genres array or a single label is read as given', () => {
  assert.deepEqual(keysOf({ id: 'raw', genres: [{ name: 'Hip-Hop' }, { name: 'Rap' }] } as never), ['hiphop', 'family:hip hop', 'rap']);
  assert.deepEqual(keysOf({ id: 'slim', genre: 'Soul' }), ['soul']);
});

test('off the mirror, a comma-joined projection is unknown, never split', () => {
  assert.deepEqual(keysOf({ id: 'slim', genre: 'Reggae, Dub' }), []);
  assert.deepEqual(keysOf({ id: 'slim', genre: 'Folk, World, & Country' }), [], 'a label holding a comma is not three labels');
});

test('no track, no keys', () => {
  assert.deepEqual(keysOf(null), []);
  assert.deepEqual(keysOf({ id: 'nothing' }), []);
});
