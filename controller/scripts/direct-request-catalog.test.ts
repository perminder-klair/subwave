import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-direct-catalog-'));
process.env.NAVIDROME_URL = 'http://catalog-fixture.invalid';
const catalog = await import('../src/music/subsonic.js');
const { resolveRequestGenre } = await import('../src/music/request-match.js');

for (const name of ['Beyoncé']) {
  test(`exact artist lookup preserves ${name}`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (input: any) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('query'), name);
      calls++;
      return Response.json({ 'subsonic-response': { status: 'ok', searchResult3: { artist: [{ id: 'artist', name }] } } });
    });
    assert.equal((await catalog.resolveArtist(name))?.name, name);
    assert.equal(calls, 1, 'exact index search runs before fuzzy relaxation');
  });
}

test('genre refinement uses complete words and never broadens an explicit genre', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ 'subsonic-response': { status: 'ok', genres: {
    genre: [{ value: 'Trap' }, { value: 'Rap Rock' }, { value: 'Rock' }, { value: 'Hip-Hop' }, { value: 'Electronica' }],
  } } }));
  assert.equal(await resolveRequestGenre(catalog, 'rap'), 'Rap Rock');
  assert.equal(await resolveRequestGenre(catalog, 'hip hop'), 'Hip-Hop');
  assert.equal(await resolveRequestGenre(catalog, 'hiphop'), 'Hip-Hop');
  assert.equal(await resolveRequestGenre(catalog, 'punk rock'), null);
  assert.equal(await resolveRequestGenre(catalog, 'ROCK'), 'Rock');
});


test('shared genre resolution preserves Electronic/Electronica for non-request callers', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ 'subsonic-response': { status: 'ok', genres: {
    genre: [{ value: 'Electronica' }],
  } } }));
  assert.equal(await catalog.resolveGenreName('Electronic'), 'Electronica');
  assert.equal(await resolveRequestGenre(catalog, 'Electronic'), null);
});
