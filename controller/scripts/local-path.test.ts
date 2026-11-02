// subsonic.getLocalPath(): the file on the MUSIC_LIBRARY_PATH mount for a song's
// `path`, against real files, or null so the stream plays instead (#1405).
// Navidrome sends a relative path built from the tags, or with Report Real Path
// on an absolute one, whose root need not match the mount.
//
// The worst outcome here is another song's file airing under this song's title
// and id, which `develop` can't do: it streams. So a path outside the mount only
// ever plays when the file proves it is the track, and these tests ask for the
// right file or a stream, never just for a file.
//
// Run: npm test -- local-path

import assert from 'node:assert/strict';
import fs, { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, beforeEach, type TestContext } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { audioBytes, flac, id3v1, id3v2, mp4, ogg, textFrame, type Comments, type Id3Encoding } from './test-utils/tags.js';

const base = createTempDir(join(tmpdir(), 'subwave-local-path-'));
process.env.STATE_DIR = join(base, 'state');
mkdirSync(process.env.STATE_DIR, { recursive: true });
const { findLibraryFile, getLocalPath, getPlayableUri, localFileState } = await import('../src/music/subsonic.js');
const { _markLibraryMountProven } = await import('../src/music/library-mount.js');
const { headTitle, tailTitle } = await import('../src/music/tag-title.js');

const SONG = 'Artist/Album/01 - Song.flac';
const BYTES = 4096;
let run = 0;
let scratch = '';
let root = '';

// The path logic on its own: library-mount.test.ts pins the proof in front of it.
function mount(path: string) {
  process.env.MUSIC_LIBRARY_PATH = path;
  _markLibraryMountProven(path);
}

function file(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  return path;
}

// A stand-in audio file `bytes` long: an ID3v2.3 tag with the title, then filler.
function audio(path: string, title = 'Song', { bytes = BYTES } = {}) {
  const tag = id3v2([textFrame('TIT2', title, /^[\x20-\xff]*$/.test(title) ? 0 : 1)]);
  return put(path, Buffer.concat([tag, audioBytes(bytes - tag.length)]));
}

function put(path: string, bytes: Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

// A song as the server sends it. Spread over it to drop or change a field.
const song = (path: string, title = 'Song', size = BYTES) => ({ id: 'abc', path, title, size });

// What a call costs the disk, counted around that call alone: writing a test
// file opens one too.
function diskCost(t: TestContext) {
  const stat = t.mock.method(fs, 'statSync');
  const open = t.mock.method(fs, 'openSync');
  return (call: () => void) => {
    const [stats, opens] = [stat.mock.callCount(), open.mock.callCount()];
    call();
    return { stats: stat.mock.callCount() - stats, opens: open.mock.callCount() - opens };
  };
}

beforeEach(() => {
  scratch = join(base, `run-${(run += 1)}`);
  root = join(scratch, 'music');
  mkdirSync(root, { recursive: true });
  mount(root);
});

after(async () => {
  delete process.env.MUSIC_LIBRARY_PATH;
  await removeTempDir(base);
});

test('a tag-built path joins the mount exactly as it always did', () => {
  file(join(root, SONG));
  assert.equal(getLocalPath({ path: SONG }), `${root}/${SONG}`);

  mount(`${root}/`);
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

  mount(`${root}/`);
  assert.equal(getLocalPath({ path: abs }), abs, 'a trailing slash on the mount changes nothing');
});

test('a relative path, or a real path inside the mount, needs no proof, as the plain join never did', () => {
  file(join(root, SONG));
  assert.equal(getLocalPath({ path: SONG, size: 999, title: 'Another' }), `${root}/${SONG}`);
  assert.equal(getLocalPath({ path: join(root, SONG), size: 999, title: 'Another' }), join(root, SONG));
  assert.equal(getLocalPath({ path: SONG }), `${root}/${SONG}`, 'no size is no matter here');
  assert.equal(getLocalPath({ path: join(root, SONG) }), join(root, SONG));
});

test('a real path inside the mount that is not there is a miss, not a search', () => {
  file(join(root, 'Album/01 - Song.flac'));
  assert.equal(getLocalPath({ path: join(root, SONG) }), null);
});

test('a real path from a different root finds the file on the mount', () => {
  const file1 = audio(join(root, SONG));
  assert.equal(getLocalPath(song(`/srv/navidrome/library/${SONG}`)), file1);
});

test('the sibling of the mount is outside it, not inside', () => {
  // `${root}2` starts with `${root}`, so a bare prefix test would pass it through.
  const sibling = audio(join(`${root}2`, SONG));
  assert.equal(getLocalPath(song(sibling)), null);
  const onMount = audio(join(root, SONG));
  assert.equal(getLocalPath(song(sibling)), onMount, 'stripped like any other root');
});

test('the longest remainder wins among files that both prove themselves', () => {
  audio(join(root, SONG));
  const longer = audio(join(root, 'library', SONG));
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), longer);
});

test('nothing stripped is tried first, as the plain join always found it', () => {
  audio(join(root, SONG));
  const whole = audio(join(root, 'srv', SONG));
  assert.equal(getLocalPath(song(`/srv/${SONG}`)), whole);
});

test('stripping stops at three segments, so another record cannot match, even one that proves itself', () => {
  audio(join(root, '01 - Song.flac'));
  audio(join(root, 'Album/01 - Song.flac'));
  assert.equal(getLocalPath(song('/srv/library/Artist/Album/01 - Song.flac')), null, 'neither the file nor the album alone');
  assert.equal(getLocalPath(song('/01 - Song.flac')), null);
  assert.equal(getLocalPath(song('/Album/01 - Song.flac')), null);
  // The other library's flat `01.mp3` is not this one's, at the same size with the same title.
  audio(join(root, '01.mp3'));
  assert.equal(getLocalPath(song('/three/01.mp3')), null);

  const whole = audio(join(root, SONG));
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), whole, 'artist, album and file may');
});

test('the reviewer\'s wrong song stays a miss: same album name and file, another artist', () => {
  audio(join(root, 'Greatest Hits/01 - Intro.flac'));
  assert.equal(getLocalPath(song('/srv/library/Queen/Greatest Hits/01 - Intro.flac')), null);
  audio(join(root, 'Abba/Greatest Hits/01 - Intro.flac'));
  assert.equal(getLocalPath(song('/srv/library/Queen/Greatest Hits/01 - Intro.flac')), null, 'nor a third artist\'s copy');
});

test('another library\'s track at the same folder and file name is not this one', () => {
  // Stock Navidrome with libraries at /music and /library/two, and only the
  // first on the mount. Each of these aired the mount's file under the second
  // library's title and id.
  audio(join(root, 'Greatest Hits/02.mp3'), 'ONE-FlatGH-02', { bytes: 9293 });
  const va = audio(join(root, 'Various Artists/Greatest Hits/01.mp3'), 'ONE-VA-GH-01', { bytes: 9292 });
  assert.equal(getLocalPath(song('/library/two/Beta/Greatest Hits/02.mp3', 'TWO-Beta-GH-02', 9294)), null, 'another size');
  // The real pair: equal-length CBR audio and equal-length tags, the same 9292
  // bytes on a real server. The size can't tell them apart, and the title does.
  assert.equal(getLocalPath(song('/library/two/Various Artists/Greatest Hits/01.mp3', 'TWO-VA-GH-01', 9292)), null, 'same size');
  // A library's own track maps to itself. A two-part remainder stays under the floor.
  assert.equal(getLocalPath(song('/music/Various Artists/Greatest Hits/01.mp3', 'ONE-VA-GH-01', 9292)), va);
});

test('one library, a track missing from the mount, the same tail elsewhere: stream', () => {
  // Moved into Archive/ in Navidrome, the old copy still on the mount.
  audio(join(root, 'Queen/GH/01.mp3'), 'Bohemian', { bytes: 5000 });
  assert.equal(getLocalPath(song('/music/Archive/Queen/GH/01.mp3', 'Radio Ga Ga', 6000)), null);
  // A compilation folder under two genres, and the mount holding one of them.
  audio(join(root, 'Various Artists/Best Of/01.mp3'), 'Pop Thing', { bytes: 5000 });
  assert.equal(getLocalPath(song('/music/Rock/Various Artists/Best Of/01.mp3', 'Rock Thing', 6000)), null);
  // The mount is one genre folder of the library.
  audio(join(root, 'VA/Best Of/01.mp3'), 'Rock Thing', { bytes: 5000 });
  assert.equal(getLocalPath(song('/music/Jazz/VA/Best Of/01.mp3', 'Jazz Thing', 6000)), null);
});

test('a folder on the mount named like Navidrome\'s root does not take the track, and locks nothing', () => {
  // The whole path lands on someone else's file. The right one is a step down.
  audio(join(root, 'music/Artist/Album/01.mp3'), 'Stray', { bytes: 5000 });
  const right = audio(join(root, 'Artist/Album/01.mp3'), 'Real', { bytes: 6000 });
  assert.equal(getLocalPath(song('/music/Artist/Album/01.mp3', 'Real', 6000)), right);
  // Nothing was learned from that: the next tracks and the other libraries
  // each stand on their own, whatever came before them.
  const other = audio(join(root, 'Other/Album/02.mp3'), 'Next', { bytes: 7000 });
  assert.equal(getLocalPath(song('/library/two/Other/Album/02.mp3', 'Next', 7000)), other);
  assert.equal(getLocalPath(song('/three/Other/Album/02.mp3', 'Next', 7000)), other);
  assert.equal(getLocalPath(song('/music/Artist/Album/01.mp3', 'Real', 6000)), right);
});

test('the proof sits under the mixer gate: the cue probe\'s reader gets it too', () => {
  const right = audio(join(root, SONG));
  // No proof from the mixer for this mount, so nothing is handed to Liquidsoap.
  const unproven = join(scratch, 'unproven');
  const here = audio(join(unproven, SONG));
  process.env.MUSIC_LIBRARY_PATH = unproven;
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), null);
  // ffprobe runs in this container, so it may read the file, but only the right one.
  assert.equal(findLibraryFile(song(`/srv/library/${SONG}`)), here);
  assert.equal(findLibraryFile(song(`/srv/library/${SONG}`, 'Another Song')), null);
  assert.equal(findLibraryFile(song(`/srv/library/${SONG}`, 'Song', BYTES + 1)), null);
  mount(root);
  assert.equal(findLibraryFile(song(`/srv/library/${SONG}`)), right);
});

test('a mount the mixer has not proved costs the push path no stat at all', (t) => {
  const unproven = join(scratch, 'unproven');
  audio(join(unproven, SONG));
  process.env.MUSIC_LIBRARY_PATH = unproven;
  const cost = diskCost(t);
  assert.deepEqual(cost(() => assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), null)), { stats: 0, opens: 0 });
});

test('a track mapped onto the mount reaches the mixer as the local file', () => {
  const onMount = audio(join(root, SONG));
  assert.equal(getPlayableUri(song(`/srv/library/${SONG}`)), onMount);
});

test('no proof is a stream, whichever value is missing, and costs no stat', (t) => {
  const onMount = audio(join(root, SONG));
  const abs = `/srv/library/${SONG}`;
  const cost = diskCost(t);
  for (const shape of [
    { path: abs },
    { path: abs, title: 'Song' },
    { path: abs, size: BYTES },
    { path: abs, title: 'Song', size: null },
    { path: abs, title: 'Song', size: 0 },
    { path: abs, title: 'Song', size: -1 },
    { path: abs, title: 'Song', size: NaN },
    { path: abs, title: 'Song', size: 'many' },
    { path: abs, title: 'Song', size: 1.5 },
    { path: abs, title: '', size: BYTES },
    { path: abs, title: '   ', size: BYTES },
    { path: abs, title: null, size: BYTES },
  ]) {
    assert.deepEqual(cost(() => assert.equal(getLocalPath(shape), null, JSON.stringify(shape))), { stats: 0, opens: 0 });
    assert.match(String(getPlayableUri({ id: 'abc', ...shape })), /^subhttp:.*\/rest\/stream/);
  }
  assert.equal(getLocalPath(song(abs)), onMount, 'the same file, with the proof');
});

test('a size sent as a string still proves: JSON from a server is what it is', () => {
  const onMount = audio(join(root, SONG));
  assert.equal(getLocalPath({ path: `/srv/${SONG}`, title: 'Song', size: String(BYTES) }), onMount);
});

test('a directory at the guess is not the file', () => {
  mkdirSync(join(root, SONG), { recursive: true });
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`, 'Song', fs.statSync(join(root, SONG)).size)), null);
});

test('a directory at a direct path is not proved, even at the track\'s size', () => {
  mkdirSync(join(root, SONG), { recursive: true });
  assert.equal(localFileState(song(SONG, 'Song', fs.statSync(join(root, SONG)).size)), 'unproved');
});

test('an unreadable file is no proof, and never throws on the push path', (t) => {
  audio(join(root, SONG));
  t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), null);
});

test('a stat that fails is no proof, and never throws on the push path', (t) => {
  audio(join(root, SONG));
  t.mock.method(fs, 'statSync', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), null);
});

// ---- The title field ----------------------------------------------------------
//
// The proof reads the title field of the file's tags as a whole value. The same
// words in another field, or in the audio, are not the title: a byte search
// found `Go` in another song's MP3 frames and `Greatest Hits` in its album, and
// aired it. Each layout below is written as its spec has it (test-utils/tags.ts).

const MAPPED = `/srv/library/${SONG}`;
const OTHER = 'Up';

// What a stand-in file holds: its title field, another field, words in the audio.
interface Fields { title?: string; album?: string; words?: string }

// The other field goes first, so a reader that took any text frame would take it.
const id3Layout = (version: 2 | 3 | 4, encoding: Id3Encoding, bigEndianBom = false) => (f: Fields) => Buffer.concat([
  id3v2([
    ...(f.album !== undefined ? [textFrame(version === 2 ? 'TAL' : 'TALB', f.album, encoding, { bigEndianBom })] : []),
    ...(f.title !== undefined ? [textFrame(version === 2 ? 'TT2' : 'TIT2', f.title, encoding, { bigEndianBom })] : []),
  ], { version }),
  audioBytes(4096, f.words),
]);
const comments = (f: Fields): Comments => [
  ...(f.album !== undefined ? [['ALBUM', f.album] as [string, string]] : []),
  ...(f.title !== undefined ? [['TITLE', f.title] as [string, string]] : []),
];

const WIDE = 'Café カフェ';
// A byte outside ASCII, so Latin-1 read as anything else is caught.
const LATIN = 'Café';
const LAYOUTS: { name: string; title: string; build: (f: Fields) => Buffer }[] = [
  { name: 'ID3v2.2, Latin-1', title: LATIN, build: id3Layout(2, 0) },
  { name: 'ID3v2.2, UTF-16', title: WIDE, build: id3Layout(2, 1) },
  { name: 'ID3v2.3, Latin-1', title: LATIN, build: id3Layout(3, 0) },
  { name: 'ID3v2.3, UTF-16 with a little-endian BOM', title: WIDE, build: id3Layout(3, 1) },
  { name: 'ID3v2.3, UTF-16 with a big-endian BOM', title: WIDE, build: id3Layout(3, 1, true) },
  { name: 'ID3v2.4, Latin-1', title: LATIN, build: id3Layout(4, 0) },
  { name: 'ID3v2.4, UTF-16 with a BOM', title: WIDE, build: id3Layout(4, 1) },
  { name: 'ID3v2.4, UTF-16BE', title: WIDE, build: id3Layout(4, 2) },
  { name: 'ID3v2.4, UTF-8', title: WIDE, build: id3Layout(4, 3) },
  { name: 'ID3v1', title: LATIN, build: f => Buffer.concat([audioBytes(4096, f.words), id3v1({ title: f.title, album: f.album })]) },
  { name: 'FLAC', title: WIDE, build: f => flac(comments(f), { words: f.words }) },
  { name: 'FLAC behind an ID3v2 tag', title: 'Go', build: f => flac(comments(f), { words: f.words, id3: id3v2([textFrame('TPE1', 'Someone')]) }) },
  { name: 'Ogg Vorbis', title: WIDE, build: f => ogg('vorbis', comments(f), { words: f.words }) },
  { name: 'Ogg Opus', title: WIDE, build: f => ogg('opus', comments(f), { words: f.words }) },
  { name: 'Ogg FLAC', title: 'Go', build: f => ogg('flac', comments(f), { words: f.words }) },
  { name: 'M4A, fast start', title: WIDE, build: f => mp4({ title: f.title, album: f.album }, { layout: 'fast', words: f.words }) },
  { name: 'M4A, moov at the end', title: 'Go', build: f => mp4({ title: f.title, album: f.album }, { layout: 'late', words: f.words }) },
  { name: 'M4A, UTF-16 text', title: WIDE, build: f => mp4({ title: f.title, album: f.album, utf16: true }, { words: f.words }) },
];

// A stand-in at the guess, asked for under `title` at the file's own size.
function asked(bytes: Buffer, title: string) {
  const onMount = put(join(root, SONG), bytes);
  return { onMount, found: getLocalPath(song(MAPPED, title, bytes.length)) };
}

for (const { name, title, build } of LAYOUTS) {
  test(`${name}: a right file proves itself by its title field`, () => {
    const { onMount, found } = asked(build({ title }), title);
    assert.equal(found, onMount);
  });

  test(`${name}: the title only in another field, or only in the audio, proves nothing`, () => {
    assert.equal(asked(build({ title: OTHER, album: title }), title).found, null, 'another field');
    assert.equal(asked(build({ title: OTHER, words: title }), title).found, null, 'the audio');
  });
}

test('the title field is compared whole, as written: case counts', () => {
  const tags = id3Layout(3, 0)({ title: 'Go Go' });
  assert.equal(asked(tags, 'Go').found, null, 'a longer title in the field');
  assert.equal(asked(tags, 'Go Go Go').found, null, 'a shorter one');
  // The server read its title from this field, so the right file matches as written.
  assert.equal(asked(tags, 'go go').found, null, 'another case');
  const { onMount, found } = asked(tags, 'Go Go');
  assert.equal(found, onMount);
});

test('both sides are NFC, trimmed, with trailing NULs dropped', () => {
  const nfd = 'Café';
  for (const [label, field, title] of [
    ['NFD in the tags, as macOS writes it, NFC from the server', nfd, 'Café'],
    ['NFC in the tags, NFD from the server', 'Café', nfd],
    ['spaces around either', '  Song ', ' Song  '],
  ]) {
    const { onMount, found } = asked(id3Layout(4, 3)({ title: field }), title);
    assert.equal(found, onMount, label);
  }
  const terminated = Buffer.concat([id3v2([textFrame('TIT2', 'Song', 1, { terminator: true })]), audioBytes(4096)]);
  assert.equal(asked(terminated, 'Song').found, join(root, SONG), 'a NUL-terminated frame');
  const padded = Buffer.concat([audioBytes(4096), id3v1({ title: 'Song' })]);
  assert.equal(asked(padded, 'Song').found, join(root, SONG), 'ID3v1\'s NUL padding');
});

test('one title per file, as Navidrome reads it: ID3v1 speaks only when ID3v2 holds none', () => {
  const both = Buffer.concat([id3v2([textFrame('TIT2', 'Up')]), audioBytes(4096), id3v1({ title: 'Go' })]);
  assert.equal(asked(both, 'Go').found, null, 'a stale ID3v1 under an ID3v2 title');
  assert.equal(asked(both, 'Up').found, join(root, SONG));
  const v1only = Buffer.concat([id3v2([textFrame('TALB', 'Album')]), audioBytes(4096), id3v1({ title: 'Go' })]);
  assert.equal(asked(v1only, 'Go').found, join(root, SONG), 'an ID3v2 tag that holds no title');
  // A FLAC's comments over the ID3v2 tag some writers put in front of it.
  const fronted = flac([['TITLE', 'Go']], { id3: id3v2([textFrame('TIT2', 'Up')]) });
  assert.equal(asked(fronted, 'Up').found, null);
  assert.equal(asked(fronted, 'Go').found, join(root, SONG));
});

test('ID3v2 is read past unsynchronisation, an extended header, a grouping byte and a data length; a compressed frame is not', () => {
  for (const [label, tag] of [
    ['2.2, the whole tag unsynchronised', id3v2([textFrame('TT2', WIDE, 1)], { version: 2, unsync: true })],
    ['2.3, the whole tag unsynchronised', id3v2([textFrame('TIT2', WIDE, 1)], { version: 3, unsync: true })],
    ['2.4, the frame unsynchronised', id3v2([textFrame('TIT2', WIDE, 1, { flags: { unsync: true } })], { version: 4 })],
    ['2.3 with an extended header', id3v2([textFrame('TIT2', WIDE, 1)], { version: 3, extended: true })],
    ['2.4 with an extended header and a footer', id3v2([textFrame('TIT2', WIDE, 3)], { version: 4, extended: true, footer: true })],
    ['2.3 with a grouping byte', id3v2([textFrame('TIT2', WIDE, 1, { flags: { grouping: true } })], { version: 3 })],
    ['2.4 with a grouping byte and a data length', id3v2([textFrame('TIT2', WIDE, 3, { flags: { grouping: true, dataLength: true } })], { version: 4 })],
  ] as const) {
    const { onMount, found } = asked(Buffer.concat([tag, audioBytes(4096)]), WIDE);
    assert.equal(found, onMount, label);
  }
  for (const [label, tag] of [
    ['2.3, compressed', id3v2([textFrame('TIT2', WIDE, 1, { flags: { compressed: true } })], { version: 3 })],
    ['2.4, compressed', id3v2([textFrame('TIT2', WIDE, 3, { flags: { compressed: true } })], { version: 4 })],
  ] as const) {
    assert.equal(asked(Buffer.concat([tag, audioBytes(4096)]), WIDE).found, null, label);
  }
});

test('an Ogg comment header that spans pages is read whole', () => {
  const long: Comments = [['DESCRIPTION', 'x'.repeat(3000)], ['TITLE', 'Song']];
  for (const kind of ['vorbis', 'opus', 'flac'] as const) {
    const { onMount, found } = asked(ogg(kind, long, { segments: 4 }), 'Song');
    assert.equal(found, onMount, kind);
  }
});

test('a title past the first and last 64 KiB is not read, and that track streams', () => {
  const big = 70 * 1024;
  for (const [label, bytes, plays] of [
    ['ID3v2, cover art ahead of the title', Buffer.concat([id3v2([{ id: 'APIC', data: Buffer.alloc(big, 0x89) }, textFrame('TIT2', 'Song')]), audioBytes(big)]), false],
    ['FLAC, a PICTURE block ahead of the comments', flac([['TITLE', 'Song']], { picture: big, audio: big }), false],
    ['M4A, a late moov whose cover follows the title', mp4({ title: 'Song' }, { layout: 'late', cover: big, audio: big }), false],
    ['M4A, fast start with sample tables past the window', mp4({ title: 'Song' }, { layout: 'fast', tables: big, audio: big }), false],
    // Found by its type, the `ilst` needs no walk down from the file's first atom.
    ['M4A, a late moov that starts before the last 64 KiB', mp4({ title: 'Song' }, { layout: 'late', tables: big, audio: big }), true],
  ] as const) {
    const { onMount, found } = asked(bytes, 'Song');
    assert.equal(found, plays ? onMount : null, label);
  }
});

test('a file whose tags hold no title field is no proof, whatever its bytes hold', () => {
  for (const [label, bytes] of [
    ['an ID3v2 tag without a title frame', Buffer.concat([id3v2([textFrame('TALB', 'Song'), textFrame('TPE1', 'Song')]), audioBytes(4096, 'Song')])],
    ['no tags at all', audioBytes(8192, 'Song')],
    ['an APE tag, which this does not read', Buffer.concat([audioBytes(4096), Buffer.from('APETAGEX\0\0\0\0Title\0Song', 'latin1')])],
    ['FLAC with no TITLE comment', flac([['ALBUM', 'Song']])],
    ['M4A with no ©nam', mp4({ album: 'Song' })],
  ] as const) {
    assert.equal(asked(bytes, 'Song').found, null, label);
  }
});

test('garbage, cut-off tags and lying sizes read as no title, and never throw', () => {
  let seed = 7;
  const rand = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000) * n);
  const shapes = [
    id3Layout(2, 1)({ title: 'Song' }), id3Layout(3, 1)({ title: 'Song' }), id3Layout(4, 2)({ title: 'Song' }),
    flac([['TITLE', 'Song']]), ogg('opus', [['TITLE', 'Song']], { segments: 3 }), mp4({ title: 'Song' }), mp4({ title: 'Song' }, { layout: 'late' }),
    Buffer.concat([audioBytes(500), id3v1({ title: 'Song' })]),
  ];
  for (const shape of shapes) {
    for (let i = 0; i < 150; i++) {
      const bytes = Buffer.from(shape.subarray(0, 1 + rand(shape.length)));
      for (let k = 0; k < 6; k++) bytes[rand(bytes.length)] = rand(256);
      assert.doesNotThrow(() => headTitle(bytes));
      assert.doesNotThrow(() => tailTitle(bytes));
    }
  }
  assert.equal(headTitle(Buffer.from('ID3\x04\x00\x00\x7f\x7f\x7f\x7fTIT2\x7f\x7f\x7f\x7f\0\0\0Song', 'latin1')), null, 'a frame longer than the tag');
  assert.equal(tailTitle(Buffer.from('\0\0\0\x08ilst\0\0\0\0\xa9nam', 'latin1')), null, 'a zero-sized atom');
});

test('a mapped miss costs a stat a guess, and a read only for the file that matched', (t) => {
  // Three guesses on a mount that holds none of it. What a bulk playlist build pays.
  const abs = '/srv/library/Artist/Album/01 - Song.flac';
  const cost = diskCost(t);
  assert.deepEqual(cost(() => assert.equal(getLocalPath(song(abs)), null)), { stats: 3, opens: 0 });

  // A wrong size is settled by the stat, so the file is never opened.
  audio(join(root, SONG), 'Song', { bytes: BYTES + 1 });
  assert.deepEqual(cost(() => assert.equal(getLocalPath(song(abs)), null)), { stats: 3, opens: 0 });

  // The right size is opened once, and the walk stops there.
  const onMount = audio(join(root, SONG));
  assert.deepEqual(cost(() => assert.equal(getLocalPath(song(abs)), onMount)), { stats: 3, opens: 1 });
});

test('stateless: what one call found changes nothing for the next', () => {
  // A prefix learned from any of these would turn the next track away.
  const one = audio(join(root, 'A/B/01.mp3'), 'One');
  const two = audio(join(root, 'C/D/02.mp3'), 'Two');
  const asked: [string, string, string | null][] = [
    ['/music/A/B/01.mp3', 'One', one],
    ['/library/two/C/D/02.mp3', 'Two', two],
    ['/three/E/F/03.mp3', 'Three', null],
    ['/music/A/B/01.mp3', 'One', one],
    ['/three/C/D/02.mp3', 'Two', two],
  ];
  for (const order of [asked, [...asked].reverse()]) {
    for (const [path, title, expected] of order) assert.equal(getLocalPath(song(path, title)), expected, path);
  }
});

test('a `..` anywhere is refused, even when the file is there and proves itself', () => {
  const secret = audio(join(scratch, 'secret/passwd.flac'));
  const inside = audio(join(root, SONG));
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
    assert.equal(getLocalPath(song(path)), null, path);
  }
  assert.ok(inside);
});

test('a miss returns null, and the stream plays instead', () => {
  assert.equal(getLocalPath({ path: SONG }), null);
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), null);
  assert.match(String(getPlayableUri(song(`/srv/library/${SONG}`))), /^subhttp:.*\/rest\/stream/);
});

test('no mount or no path is null', () => {
  file(join(root, SONG));
  assert.equal(getLocalPath({}), null);
  assert.equal(getLocalPath({ path: '' }), null);
  delete process.env.MUSIC_LIBRARY_PATH;
  assert.equal(getLocalPath({ path: SONG }), null);
});
