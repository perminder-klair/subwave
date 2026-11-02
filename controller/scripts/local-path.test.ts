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
import { apeTag, audioBytes, flac, id3v1, id3v2, mp4, ogg, textFrame, type Comments, type Id3Encoding, type Id3Frame } from './test-utils/tags.js';

const base = createTempDir(join(tmpdir(), 'subwave-local-path-'));
process.env.STATE_DIR = join(base, 'state');
mkdirSync(process.env.STATE_DIR, { recursive: true });
const { findLibraryFile, getAnnotatedUri, getLocalPath, getPlayableUri, localFileState } = await import('../src/music/subsonic.js');
const { _markLibraryMountProven } = await import('../src/music/library-mount.js');
const { MAX_TITLE_CHARS, _ilstScan, fileTitle, normalizeTitle, titleVerdict } = await import('../src/music/tag-title.js');

const SONG = 'Artist/Album/01 - Song.mp3';
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
  const dotted = 'Artist/Vol.. 2/01 - Song...mp3';
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
  file(join(root, 'Album/01 - Song.mp3'));
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
  audio(join(root, '01 - Song.mp3'));
  audio(join(root, 'Album/01 - Song.mp3'));
  assert.equal(getLocalPath(song('/srv/library/Artist/Album/01 - Song.mp3')), null, 'neither the file nor the album alone');
  assert.equal(getLocalPath(song('/01 - Song.mp3')), null);
  assert.equal(getLocalPath(song('/Album/01 - Song.mp3')), null);
  // The other library's flat `01.mp3` is not this one's, at the same size with the same title.
  audio(join(root, '01.mp3'));
  assert.equal(getLocalPath(song('/three/01.mp3')), null);

  const whole = audio(join(root, SONG));
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`)), whole, 'artist, album and file may');
});

test('the reviewer\'s wrong song stays a miss: same album name and file, another artist', () => {
  audio(join(root, 'Greatest Hits/01 - Intro.mp3'));
  assert.equal(getLocalPath(song('/srv/library/Queen/Greatest Hits/01 - Intro.mp3')), null);
  audio(join(root, 'Abba/Greatest Hits/01 - Intro.mp3'));
  assert.equal(getLocalPath(song('/srv/library/Queen/Greatest Hits/01 - Intro.mp3')), null, 'nor a third artist\'s copy');
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
// The proof reads the title field of the file's tags as a whole value, with the
// reader picked by the file's extension, as Navidrome picks it. The same words in
// another field, or in the audio, are not the title: a byte search found `Go` in
// another song's MP3 frames and `Greatest Hits` in its album, and aired it. Where
// the reader can't be sure it reads the field Navidrome reads, the track streams.
// Each layout below is written as its spec has it (test-utils/tags.ts).

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
const LAYOUTS: { name: string; ext: string; title: string; build: (f: Fields) => Buffer }[] = [
  { name: 'ID3v2.2, Latin-1', ext: 'mp3', title: LATIN, build: id3Layout(2, 0) },
  { name: 'ID3v2.2, UTF-16', ext: 'mp3', title: WIDE, build: id3Layout(2, 1) },
  { name: 'ID3v2.3, Latin-1', ext: 'mp3', title: LATIN, build: id3Layout(3, 0) },
  { name: 'ID3v2.3, UTF-16 with a little-endian BOM', ext: 'mp3', title: WIDE, build: id3Layout(3, 1) },
  { name: 'ID3v2.3, UTF-16 with a big-endian BOM', ext: 'mp3', title: WIDE, build: id3Layout(3, 1, true) },
  { name: 'ID3v2.4, Latin-1', ext: 'mp3', title: LATIN, build: id3Layout(4, 0) },
  { name: 'ID3v2.4, UTF-16 with a BOM', ext: 'mp3', title: WIDE, build: id3Layout(4, 1) },
  { name: 'ID3v2.4, UTF-16BE', ext: 'mp3', title: WIDE, build: id3Layout(4, 2) },
  { name: 'ID3v2.4, UTF-8', ext: 'mp3', title: WIDE, build: id3Layout(4, 3) },
  { name: 'ID3v1', ext: 'mp3', title: LATIN, build: f => Buffer.concat([audioBytes(4096, f.words), id3v1({ title: f.title, album: f.album })]) },
  { name: 'FLAC', ext: 'flac', title: WIDE, build: f => flac(comments(f), { words: f.words }) },
  { name: 'FLAC behind an ID3v2 tag', ext: 'flac', title: 'Go', build: f => flac(comments(f), { words: f.words, id3: id3v2([textFrame('TPE1', 'Someone')]) }) },
  { name: 'Ogg Vorbis', ext: 'ogg', title: WIDE, build: f => ogg('vorbis', comments(f), { words: f.words }) },
  { name: 'Ogg Opus', ext: 'opus', title: WIDE, build: f => ogg('opus', comments(f), { words: f.words }) },
  { name: 'Ogg FLAC', ext: 'oga', title: 'Go', build: f => ogg('flac', comments(f), { words: f.words }) },
  { name: 'M4A, fast start', ext: 'm4a', title: WIDE, build: f => mp4({ title: f.title, album: f.album }, { layout: 'fast', words: f.words }) },
  { name: 'M4A, moov at the end', ext: 'm4a', title: 'Go', build: f => mp4({ title: f.title, album: f.album }, { layout: 'late', words: f.words }) },
  { name: 'M4A, UTF-16 text', ext: 'm4a', title: WIDE, build: f => mp4({ title: f.title, album: f.album, utf16: true }, { words: f.words }) },
];

// A stand-in at the guess, named with `ext`, asked for under `title` at its own size.
function asked(bytes: Buffer, title: string, ext = 'mp3') {
  const rel = `Artist/Album/01 - Song.${ext}`;
  const onMount = put(join(root, rel), bytes);
  return { onMount, found: getLocalPath(song(`/srv/library/${rel}`, title, bytes.length)) };
}

for (const { name, ext, title, build } of LAYOUTS) {
  test(`${name}: a right file proves itself by its title field`, () => {
    const { onMount, found } = asked(build({ title }), title, ext);
    assert.equal(found, onMount);
  });

  test(`${name}: the title only in another field, or only in the audio, proves nothing`, () => {
    assert.equal(asked(build({ title: OTHER, album: title }), title, ext).found, null, 'another field');
    assert.equal(asked(build({ title: OTHER, words: title }), title, ext).found, null, 'the audio');
  });
}

test('the title field is compared whole, as written: case counts', () => {
  const tags = id3Layout(3, 0)({ title: 'Go Go' });
  assert.equal(asked(tags, 'Go').found, null, 'a longer title in the field');
  assert.equal(asked(tags, 'Go Go Go').found, null, 'a shorter one');
  // Navidrome read its title from this field, so the right file matches as written.
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
  assert.equal(asked(terminated, 'Song').found, join(root, 'Artist/Album/01 - Song.mp3'), 'a NUL-terminated frame');
  const padded = Buffer.concat([audioBytes(4096), id3v1({ title: 'Song' })]);
  assert.equal(asked(padded, 'Song').found, join(root, 'Artist/Album/01 - Song.mp3'), 'ID3v1\'s NUL padding');
});

// ---- Only where Navidrome reads the same field ----------------------------------
//
// Navidrome's TagLib takes a whole tag, not a field: an ID3v2 tag that is there
// silences ID3v1 and APE even with no title in it, and a FLAC's comments silence
// its ID3v2. Where the reader would read a field Navidrome doesn't, it streams.

const MP3 = 'Artist/Album/01 - Song.mp3';

test('an MP3\'s ID3v2 tag ends the search: ID3v1 behind it is never read, even when the tag holds no title', () => {
  const cases: [string, Id3Frame[]][] = [
    ['a title frame for another song', [textFrame('TIT2', 'Up')]],
    ['only an artist', [textFrame('TPE1', 'Someone')]],
    ['only a TXXX', [{ id: 'TXXX', data: Buffer.from('\0REPLAYGAIN_TRACK_GAIN\0-6 dB', 'latin1') }]],
    ['an empty title', [textFrame('TIT2', '')]],
  ];
  for (const [label, frames] of cases) {
    const bytes = Buffer.concat([id3v2(frames), audioBytes(4096), id3v1({ title: 'Go' })]);
    assert.equal(asked(bytes, 'Go').found, null, label);
  }
  const v1only = Buffer.concat([audioBytes(4096), id3v1({ title: 'Go' })]);
  assert.equal(asked(v1only, 'Go').found, join(root, MP3), 'ID3v1 with no ID3v2 in front');
});

test('an MP3 with an APEv2 tag and no ID3v2 is unsure, even when its ID3v1 agrees', () => {
  for (const [label, bytes] of [
    ['APEv2 "Up", a stale ID3v1 "Go"', Buffer.concat([audioBytes(4096), apeTag({ Title: 'Up' }), id3v1({ title: 'Go' })])],
    ['APEv2 and ID3v1, both "Go"', Buffer.concat([audioBytes(4096), apeTag({ Title: 'Go' }), id3v1({ title: 'Go' })])],
    ['APEv2 alone', Buffer.concat([audioBytes(4096), apeTag({ Title: 'Go' })])],
  ] as const) {
    assert.equal(asked(bytes, 'Go').found, null, label);
  }
  // Behind an ID3v2 tag APE changes nothing: Navidrome reads the ID3v2 title.
  const behind = Buffer.concat([id3v2([textFrame('TIT2', 'Go')]), audioBytes(4096), apeTag({ Title: 'Up' }), id3v1({ title: 'Up' })]);
  assert.equal(asked(behind, 'Go').found, join(root, MP3));
});

test('a FLAC with a comment block ignores the ID3v2 tag in front of it, even when the block holds no TITLE', () => {
  const FLAC_SONG = 'Artist/Album/01 - Song.flac';
  const noTitle = flac([['ARTIST', 'Someone']], { id3: id3v2([textFrame('TIT2', 'Go')]) });
  assert.equal(asked(noTitle, 'Go', 'flac').found, null, 'comments without TITLE, an ID3v2 "Go" in front');
  const both = flac([['TITLE', 'Go']], { id3: id3v2([textFrame('TIT2', 'Up')]) });
  assert.equal(asked(both, 'Up', 'flac').found, null);
  assert.equal(asked(both, 'Go', 'flac').found, join(root, FLAC_SONG));
  // With no comment block the ID3v2 tag might be Navidrome's title or not: unsure.
  const bare = flac([], { noComments: true, id3: id3v2([textFrame('TIT2', 'Go')]) });
  assert.equal(asked(bare, 'Go', 'flac').found, null, 'no comment block, an ID3v2 "Go" in front');
});

test('an ID3v2 tag in front of an MP4 is unsure: Navidrome doesn\'t index the file', () => {
  const bytes = Buffer.concat([id3v2([textFrame('TIT2', 'Go')]), mp4({ title: 'Go' })]);
  assert.equal(asked(bytes, 'Go', 'm4a').found, null);
  assert.equal(asked(mp4({ title: 'Go' }), 'Go', 'm4a').found, join(root, 'Artist/Album/01 - Song.m4a'), 'the same M4A without it');
});

test('a UTF-16 title with no byte order mark is unsure: Navidrome reads no title from it', () => {
  const bytes = Buffer.concat([id3v2([{ id: 'TIT2', data: Buffer.concat([Buffer.from([1]), Buffer.from('NoBom', 'utf16le')]) }]), audioBytes(4096)]);
  assert.equal(asked(bytes, 'NoBom').found, null);
});

test('a NUL-separated ID3v2 title is its first value, as Navidrome reports it', () => {
  const cases: [string, Buffer][] = [
    ['2.4 UTF-8, two values', id3v2([textFrame('TIT2', 'Part One\0Part Two', 3)], { version: 4 })],
    ['2.4 UTF-16, two values', id3v2([textFrame('TIT2', 'Part One\0Part Two', 1)], { version: 4 })],
    ['2.3 Latin-1, a value then junk', id3v2([textFrame('TIT2', 'Part One\0\0\0junk', 0)], { version: 3 })],
  ];
  for (const [label, tag] of cases) {
    const bytes = Buffer.concat([tag, audioBytes(4096)]);
    assert.equal(asked(bytes, 'Part One').found, join(root, MP3), label);
    assert.equal(asked(bytes, 'Part Two').found, null, `${label}: the second value is not the title`);
  }
});

test('MP4 titles that disagree are unsure: a stale ilst left in a free atom by retagging in place', () => {
  const M4A = 'Artist/Album/01 - Song.m4a';
  for (const layout of ['late', 'fast'] as const) {
    const stale = mp4({ title: 'Up' }, { layout, stale: 'Go' });
    assert.equal(asked(stale, 'Go', 'm4a').found, null, `${layout}: the stale title`);
    assert.equal(asked(stale, 'Up', 'm4a').found, null, `${layout}: nor the live one, which can't be told from it here`);
    const agree = mp4({ title: 'Go' }, { layout, stale: 'Go' });
    assert.equal(asked(agree, 'Go', 'm4a').found, join(root, M4A), `${layout}: two that agree`);
  }
});

test('the extension picks the reader, as Navidrome\'s does', () => {
  const tagged = Buffer.concat([id3v2([textFrame('TIT2', 'Go')]), audioBytes(4096)]);
  for (const ext of ['wav', 'aiff', 'wv', 'wma', 'ape', 'flac', 'm4a', 'ogg']) {
    assert.equal(asked(tagged, 'Go', ext).found, null, `ID3v2 bytes named .${ext}`);
  }
  assert.equal(asked(tagged, 'Go', 'MP3').found, join(root, 'Artist/Album/01 - Song.MP3'), 'case does not matter');
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
  for (const [kind, ext] of [['vorbis', 'ogg'], ['opus', 'opus'], ['flac', 'oga']] as const) {
    const { onMount, found } = asked(ogg(kind, long, { segments: 4 }), 'Song', ext);
    assert.equal(found, onMount, kind);
  }
});

test('a title past the first and last 64 KiB is not read, and that track streams', () => {
  const big = 70 * 1024;
  for (const [label, bytes, ext, plays] of [
    ['ID3v2, cover art ahead of the title', Buffer.concat([id3v2([{ id: 'APIC', data: Buffer.alloc(big, 0x89) }, textFrame('TIT2', 'Song')]), audioBytes(big)]), 'mp3', false],
    ['FLAC, a PICTURE block ahead of the comments', flac([['TITLE', 'Song']], { picture: big, audio: big }), 'flac', false],
    ['Ogg, a picture comment ahead of TITLE', ogg('vorbis', [['METADATA_BLOCK_PICTURE', 'A'.repeat(big)], ['TITLE', 'Song']], { audio: big }), 'ogg', false],
    ['M4A, a late moov whose cover follows the title', mp4({ title: 'Song' }, { layout: 'late', cover: big, audio: big }), 'm4a', false],
    ['M4A, fast start with sample tables past the window', mp4({ title: 'Song' }, { layout: 'fast', tables: big, audio: big }), 'm4a', false],
    // Found by its type, the `ilst` needs no walk down from the file's first atom.
    ['M4A, a late moov that starts before the last 64 KiB', mp4({ title: 'Song' }, { layout: 'late', tables: big, audio: big }), 'm4a', true],
  ] as const) {
    const { onMount, found } = asked(bytes, 'Song', ext);
    assert.equal(found, plays ? onMount : null, label);
  }
});

test('a file whose tags hold no title field is no proof, whatever its bytes hold', () => {
  for (const [label, bytes, ext] of [
    ['an ID3v2 tag without a title frame', Buffer.concat([id3v2([textFrame('TALB', 'Song'), textFrame('TPE1', 'Song')]), audioBytes(4096, 'Song')]), 'mp3'],
    ['no tags at all', audioBytes(8192, 'Song'), 'mp3'],
    ['FLAC with no TITLE comment', flac([['ALBUM', 'Song']]), 'flac'],
    ['M4A with no ©nam', mp4({ album: 'Song' }), 'm4a'],
  ] as const) {
    assert.equal(asked(bytes, 'Song', ext).found, null, label);
  }
});

test('garbage, cut-off tags and lying sizes read as no title, and never throw', () => {
  let seed = 7;
  const rand = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000) * n);
  const shapes: [string, Buffer][] = [
    ['mp3', id3Layout(2, 1)({ title: 'Song' })], ['mp3', id3Layout(3, 1)({ title: 'Song' })], ['mp3', id3Layout(4, 2)({ title: 'Song' })],
    ['flac', flac([['TITLE', 'Song']])], ['opus', ogg('opus', [['TITLE', 'Song']], { segments: 3 })],
    ['m4a', mp4({ title: 'Song' })], ['m4a', mp4({ title: 'Song' }, { layout: 'late' })],
    ['mp3', Buffer.concat([audioBytes(500), apeTag({ Title: 'Song' }), id3v1({ title: 'Song' })])],
  ];
  for (const [ext, shape] of shapes) {
    for (let i = 0; i < 150; i++) {
      const bytes = Buffer.from(shape.subarray(0, 1 + rand(shape.length)));
      for (let k = 0; k < 6; k++) bytes[rand(bytes.length)] = rand(256);
      assert.doesNotThrow(() => fileTitle(ext, bytes, () => bytes));
    }
  }
  const tail = (bytes: Buffer) => () => bytes;
  const lying = Buffer.from('ID3\x04\x00\x00\x7f\x7f\x7f\x7fTIT2\x7f\x7f\x7f\x7f\0\0\0Song', 'latin1');
  assert.deepEqual(fileTitle('mp3', lying, tail(lying)), { kind: 'none' }, 'a frame longer than the tag');
  const zero = Buffer.from('\0\0\0\x1cftypM4A \0\0\0\0\0\0\0\x08ilst\0\0\0\0\xa9nam', 'latin1');
  assert.deepEqual(fileTitle('m4a', zero, tail(zero)), { kind: 'none' }, 'a zero-sized atom');
});

// ---- No input costs more than linear time --------------------------------------
//
// A proof runs synchronously on the push path, in the coast build and in the
// Doctor. Before this was linear, each of these fields held the controller for
// about 2.5 s a proof (a backtracking trim), and the ilst walk 1.8 s. The budgets
// are far above what the linear reader takes, so a loaded machine still passes.

const PROOF_BUDGET_MS = 150;
const elapsed = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t; };
const runThenX = (n: number, c = ' ') => c.repeat(n) + 'x';

// `ilst` atoms in every 12-byte child, each claiming the rest of the file: a
// search that walks each match to its claimed end takes N²/2 steps.
function ilstBomb(bytes = 60_000) {
  const child = Buffer.concat([Buffer.from([0, 0, 0, 12, 0x7f, 0xff, 0xff, 0xff]), Buffer.from('ilst')]);
  const n = Math.floor(bytes / 12);
  return Buffer.concat([Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.from('ilst'), ...Array.from({ length: n }, () => child)]);
}

// A late-moov M4A with the bomb in a `free` atom ahead of its moov, as a real file
// carries it (Navidrome indexes it).
const bombM4a = () => {
  const real = mp4({ title: 'Ilst Bomb' }, { layout: 'late', tables: 100, audio: 200_000 });
  const moov = real.lastIndexOf('moov') - 4;
  const bomb = ilstBomb();
  const free = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('free'), bomb]);
  free.writeUInt32BE(free.length, 0);
  return Buffer.concat([real.subarray(0, moov), free, real.subarray(moov)]);
};

const HOSTILE: { name: string; ext: string; bytes: () => Buffer }[] = [
  { name: 'ID3v2.3 TIT2, 65,000 spaces then x', ext: 'mp3', bytes: () => Buffer.concat([id3v2([textFrame('TIT2', runThenX(65000))], { padding: 0 }), audioBytes(200_000)]) },
  { name: 'ID3v2.3 TIT2, 65,000 NULs then x', ext: 'mp3', bytes: () => Buffer.concat([id3v2([textFrame('TIT2', runThenX(65000, '\0'))], { padding: 0 }), audioBytes(200_000)]) },
  { name: 'FLAC TITLE=, 65,000 spaces then x', ext: 'flac', bytes: () => flac([['TITLE', runThenX(65000)]], { audio: 200_000 }) },
  { name: 'MP4 ©nam, 65,000 spaces then x', ext: 'm4a', bytes: () => mp4({ title: runThenX(65000) }, { tables: 100, audio: 200_000 }) },
  { name: 'MP4, an ilst in every 12-byte child', ext: 'm4a', bytes: bombM4a },
];

for (const { name, ext, bytes } of HOSTILE) {
  test(`hostile: ${name} costs a proof well under ${PROOF_BUDGET_MS} ms, on every path`, () => {
    const rel = `Hostile/Album/01 - Song.${ext}`;
    const data = bytes();
    put(join(root, rel), data);
    const track = song(`/srv/library/${rel}`, 'Song', data.length);
    for (const [path, call] of [['findLibraryFile', findLibraryFile], ['getLocalPath', getLocalPath], ['the Doctor', localFileState]] as const) {
      const ms = elapsed(() => call(track));
      assert.ok(ms < PROOF_BUDGET_MS, `${path}: ${ms.toFixed(1)} ms`);
    }
  });
}

test('the trim is linear, whatever run it meets', () => {
  for (const c of [' ', '\0', '\t', '　', ' ']) {
    const ms = elapsed(() => normalizeTitle(runThenX(65000, c)));
    assert.ok(ms < PROOF_BUDGET_MS, `${JSON.stringify(c)}: ${ms.toFixed(1)} ms`);
  }
  assert.equal(normalizeTitle('  Song \0\0 \0'), 'Song');
  assert.equal(normalizeTitle(`a${' '.repeat(10)}b`), `a${' '.repeat(10)}b`, 'a run inside the title stays');
  assert.equal(normalizeTitle('Café '), 'Café');
});

test('a field longer than any title a server reports is another song, and is not normalised', () => {
  const at = (n: number) => ({ kind: 'title' as const, value: 'Song'.padEnd(n, ' ') });
  assert.equal(titleVerdict(at(MAX_TITLE_CHARS), 'Song'), 'same', 'at the bound, trailing spaces trim as ever');
  assert.equal(titleVerdict(at(MAX_TITLE_CHARS + 1), 'Song'), 'other', 'past it');
  const tag = Buffer.concat([id3v2([textFrame('TIT2', 'Song'.padEnd(MAX_TITLE_CHARS + 1, ' '))]), audioBytes(4096)]);
  assert.equal(asked(tag, 'Song').found, null, 'through a file');
});

test('a server title longer than that is no proof, and costs no stat', (t) => {
  audio(join(root, SONG));
  const cost = diskCost(t);
  const long = song(`/srv/library/${SONG}`, 'Song'.padEnd(MAX_TITLE_CHARS + 1, ' '));
  assert.deepEqual(cost(() => assert.equal(getLocalPath(long), null)), { stats: 0, opens: 0 });
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`, 'Song'.padEnd(MAX_TITLE_CHARS, ' '))), join(root, SONG), 'at the bound it proves');
});

test('the ilst search walks each atom once: at most one step per 8 bytes of window', () => {
  const bomb = ilstBomb(64 * 1024 - 8);
  const scan = _ilstScan(bomb);
  assert.ok(scan.steps <= bomb.length / 8, `${scan.steps} steps for ${bomb.length} bytes`);
  assert.deepEqual(scan.names, []);
  const real = _ilstScan(mp4({ title: 'Song', album: 'Album', artist: 'Artist' }));
  assert.deepEqual(real.names, ['Song']);
  assert.ok(real.steps <= 4, `${real.steps} steps for a real ilst`);
});

test('a coast of 40 tracks with two hostile files builds in well under a second', () => {
  const tracks: ReturnType<typeof song>[] = [];
  for (let i = 0; i < 38; i++) {
    const rel = `Coast/Album ${i}/01 - Track.mp3`;
    audio(join(root, rel), `Track ${i}`);
    tracks.push(song(`/srv/library/${rel}`, `Track ${i}`));
  }
  const ws = Buffer.concat([id3v2([textFrame('TIT2', `Hostile${runThenX(65000)}`)], { padding: 0 }), audioBytes(200_000)]);
  put(join(root, 'Coast/Hostile/01 - Ws.mp3'), ws);
  // Navidrome cuts the title it reports at 1,024 characters.
  tracks.push(song('/srv/library/Coast/Hostile/01 - Ws.mp3', `Hostile${' '.repeat(1017)}`, ws.length));
  const bomb = bombM4a();
  put(join(root, 'Coast/Hostile/02 - Ilst.m4a'), bomb);
  tracks.push(song('/srv/library/Coast/Hostile/02 - Ilst.m4a', 'Ilst Bomb', bomb.length));
  let lines: string[] = [];
  const ms = elapsed(() => { lines = tracks.map(s => getAnnotatedUri(s, {})); });
  assert.ok(ms < 1000, `${ms.toFixed(1)} ms for 40 tracks`);
  assert.equal(lines.filter(l => !l.includes('subhttp:')).length, 38, 'the 38 right files still play from disk');
});

test('a mapped miss costs a stat a guess, and a read only for the file that matched', (t) => {
  // Three guesses on a mount that holds none of it. What a bulk playlist build pays.
  const abs = '/srv/library/Artist/Album/01 - Song.mp3';
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
  const secret = audio(join(scratch, 'secret/passwd.mp3'));
  const inside = audio(join(root, SONG));
  for (const path of [
    '../secret/passwd.mp3',
    'Artist/../../secret/passwd.mp3',
    `${root}/../secret/passwd.mp3`,
    `/srv/../${scratch.slice(1)}/secret/passwd.mp3`,
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
