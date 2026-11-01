// subsonic.getLocalPath(): the file on the MUSIC_LIBRARY_PATH mount for a song's
// `path`, against real files, or null so the stream plays instead (#1405).
// Navidrome sends a relative path built from the tags, or with Report Real Path
// on an absolute one, whose root need not match the mount.
//
// Run: npm test -- local-path

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const base = createTempDir(join(tmpdir(), 'subwave-local-path-'));
process.env.STATE_DIR = join(base, 'state');
mkdirSync(process.env.STATE_DIR, { recursive: true });
const { getLocalPath, getPlayableUri } = await import('../src/music/subsonic.js');

const SONG = 'Artist/Album/01 - Song.flac';
let run = 0;
let scratch = '';
let root = '';

function file(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  return path;
}

beforeEach(() => {
  scratch = join(base, `run-${(run += 1)}`);
  root = join(scratch, 'music');
  mkdirSync(root, { recursive: true });
  process.env.MUSIC_LIBRARY_PATH = root;
});

after(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  await removeTempDir(base);
});

test('a tag-built path joins the mount exactly as it always did', () => {
  file(join(root, SONG));
  assert.equal(getLocalPath({ path: SONG }), `${root}/${SONG}`);

  process.env.MUSIC_LIBRARY_PATH = `${root}/`;
  assert.equal(getLocalPath({ path: SONG }), `${root}//${SONG}`, 'the string is built as before');
});

test('dots in a tag-built name are not traversal', () => {
  const dotted = 'Artist/Vol.. 2/01 - Song...flac';
  file(join(root, dotted));
  assert.equal(getLocalPath({ path: dotted }), `${root}/${dotted}`);
});

test('a real path inside the mount is used as it is', () => {
  const abs = file(join(root, SONG));
  assert.equal(getLocalPath({ path: abs }), abs);

  process.env.MUSIC_LIBRARY_PATH = `${root}/`;
  assert.equal(getLocalPath({ path: abs }), abs, 'a trailing slash on the mount changes nothing');
});

test('a real path inside the mount that is not there is a miss, not a search', () => {
  file(join(root, 'Album/01 - Song.flac'));
  assert.equal(getLocalPath({ path: join(root, SONG) }), null);
});

test('a real path from a different root finds the file on the mount', () => {
  const file1 = file(join(root, SONG));
  assert.equal(getLocalPath({ path: `/srv/navidrome/library/${SONG}` }), file1);
});

test('the sibling of the mount is outside it, not inside', () => {
  // `${root}2` starts with `${root}`, so a bare prefix test would pass it through.
  const sibling = file(join(`${root}2`, SONG));
  assert.equal(getLocalPath({ path: sibling }), null);
  const onMount = file(join(root, SONG));
  assert.equal(getLocalPath({ path: sibling }), onMount, 'stripped like any other root');
});

test('the longest remainder wins', () => {
  file(join(root, SONG));
  const longer = file(join(root, 'library', SONG));
  assert.equal(getLocalPath({ path: `/srv/library/${SONG}` }), longer);
});

test('nothing stripped is tried first, as the plain join always found it', () => {
  file(join(root, SONG));
  const whole = file(join(root, 'srv', SONG));
  assert.equal(getLocalPath({ path: `/srv/${SONG}` }), whole);
});

test('stripping stops at three segments, so another record cannot match', () => {
  file(join(root, '01 - Song.flac'));
  file(join(root, 'Album/01 - Song.flac'));
  assert.equal(getLocalPath({ path: '/srv/library/Artist/Album/01 - Song.flac' }), null, 'neither the file nor the album alone');
  assert.equal(getLocalPath({ path: '/01 - Song.flac' }), null);
  assert.equal(getLocalPath({ path: '/Album/01 - Song.flac' }), null);

  const whole = file(join(root, SONG));
  assert.equal(getLocalPath({ path: `/srv/library/${SONG}` }), whole, 'artist, album and file may');
});

test('the reviewer\'s wrong song stays a miss: same album name and file, another artist', () => {
  file(join(root, 'Greatest Hits/01 - Intro.flac'));
  assert.equal(getLocalPath({ path: '/srv/library/Queen/Greatest Hits/01 - Intro.flac' }), null);
  file(join(root, 'Abba/Greatest Hits/01 - Intro.flac'));
  assert.equal(getLocalPath({ path: '/srv/library/Queen/Greatest Hits/01 - Intro.flac' }), null, 'nor a third artist\'s copy');
});

test('a `..` anywhere is refused, even when the file is there', () => {
  const secret = file(join(scratch, 'secret/passwd.flac'));
  const inside = file(join(root, SONG));
  for (const path of [
    '../secret/passwd.flac',
    'Artist/../../secret/passwd.flac',
    `${root}/../secret/passwd.flac`,
    `/srv/../${scratch.slice(1)}/secret/passwd.flac`,
    `/srv/library/../../${secret.slice(1)}`,
    // Stays under the mount, and still is not a path Navidrome would send.
    `Artist/../${SONG}`,
    `${root}/Artist/../${SONG}`,
    `/srv/../${SONG}`,
  ]) {
    assert.equal(getLocalPath({ path }), null, path);
  }
  assert.ok(inside);
});

test('a miss returns null, and the stream plays instead', () => {
  assert.equal(getLocalPath({ path: SONG }), null);
  assert.equal(getLocalPath({ path: `/srv/library/${SONG}` }), null);
  assert.match(String(getPlayableUri({ id: 'abc', path: `/srv/library/${SONG}` })), /^subhttp:.*\/rest\/stream/);
});

test('no mount or no path is null', () => {
  file(join(root, SONG));
  assert.equal(getLocalPath({}), null);
  assert.equal(getLocalPath({ path: '' }), null);
  delete process.env.MUSIC_LIBRARY_PATH;
  assert.equal(getLocalPath({ path: SONG }), null);
});
