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
import { apeTag, atom, audioBytes, dataAtom, flac, freeform, id3v1, id3v2, mp4, NAM, ogg, textFrame, txxxFrame, u32be, wideAtom, type Comments, type Id3Encoding, type Id3Frame } from './test-utils/tags.js';

const base = createTempDir(join(tmpdir(), 'subwave-local-path-'));
process.env.STATE_DIR = join(base, 'state');
mkdirSync(process.env.STATE_DIR, { recursive: true });
const { findLibraryFile, getAnnotatedUri, getLocalPath, getPlayableUri, localFileState } = await import('../src/music/subsonic.js');
const { _markLibraryMountProven } = await import('../src/music/library-mount.js');
const { MAX_REPORTED_TITLE_BYTES, MAX_TAG_BYTES, _mp4Steps, cutTag, fileTitle, normalizeTitle } = await import('../src/music/tag-title.js');

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
// the reader knows it reads a field another way from Navidrome, the track streams.
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

// ---- The subtitle Navidrome appends ------------------------------------------------
//
// Navidrome's Subsonic API reports `Title (Subtitle)` when a file has a subtitle
// tag (`TIT3`, a `SUBTITLE` comment, an iTunes `SUBTITLE` item), so a file whose
// title field alone matches is another recording to Navidrome: "Intro" asked for,
// "Intro (Remastered 2011)" on the mount. The right file matches the whole form.

test('a subtitle is appended as Navidrome appends it, in each tag kind', () => {
  const v24 = (frames: Id3Frame[]) => Buffer.concat([id3v2(frames, { version: 4 }), audioBytes(4096)]);
  for (const [label, bytes, ext] of [
    ['ID3v2.4 TIT3', v24([textFrame('TIT2', 'Intro', 3), textFrame('TIT3', 'Remastered 2011', 3)]), 'mp3'],
    ['ID3v2.3 TIT3 ahead of TIT2', Buffer.concat([id3v2([textFrame('TIT3', 'Remastered 2011'), textFrame('TIT2', 'Intro')]), audioBytes(4096)]), 'mp3'],
    ['ID3v2.2 TT3', Buffer.concat([id3v2([textFrame('TT2', 'Intro'), textFrame('TT3', 'Remastered 2011')], { version: 2 }), audioBytes(4096)]), 'mp3'],
    ['a TXXX described SUBTITLE', v24([textFrame('TIT2', 'Intro', 3), txxxFrame('Subtitle', 'Remastered 2011', 3)]), 'mp3'],
    ['FLAC SUBTITLE=', flac([['TITLE', 'Intro'], ['SUBTITLE', 'Remastered 2011']]), 'flac'],
    ['FLAC subtitle=, in lower case', flac([['TITLE', 'Intro'], ['subtitle', 'Remastered 2011']]), 'flac'],
    ['Ogg Opus SUBTITLE=', ogg('opus', [['TITLE', 'Intro'], ['SUBTITLE', 'Remastered 2011']]), 'opus'],
    ['M4A ----:com.apple.iTunes:SUBTITLE', mp4({ title: 'Intro', subtitle: 'Remastered 2011' }), 'm4a'],
    ['M4A, the mean in lower case', mp4({ title: 'Intro' }, { items: [freeform('SUBTITLE', ['Remastered 2011'], 'com.apple.itunes')] }), 'm4a'],
  ] as const) {
    assert.equal(asked(bytes, 'Intro (Remastered 2011)', ext).found, join(root, `Artist/Album/01 - Song.${ext}`), label);
    assert.equal(asked(bytes, 'Intro', ext).found, null, `${label}: not the title alone`);
  }
});

test('the subtitle\'s form: trimmed, bracketed unless it brings its own pair, the first value that isn\'t empty', () => {
  const tagged = (...frames: Id3Frame[]) => Buffer.concat([id3v2([textFrame('TIT2', 'Go', 3), ...frames], { version: 4 }), audioBytes(4096)]);
  for (const [label, bytes, title] of [
    ['its own brackets', tagged(textFrame('TIT3', '[Live]', 3)), 'Go [Live]'],
    ['its own parentheses, padded', tagged(textFrame('TIT3', '  (Live) ', 3)), 'Go (Live)'],
    ['an unclosed parenthesis', tagged(textFrame('TIT3', '(Live', 3)), 'Go ((Live)'],
    ['a mismatched pair', tagged(textFrame('TIT3', '(Live]', 3)), 'Go ((Live])'],
    ['only spaces', tagged(textFrame('TIT3', '   ', 3)), 'Go ()'],
    ['an empty first value', tagged(textFrame('TIT3', '\0Live', 3)), 'Go (Live)'],
    ['TIT3, then a TXXX SUBTITLE: frame order', tagged(textFrame('TIT3', 'Live', 3), txxxFrame('SUBTITLE', 'Demo', 3)), 'Go (Live)'],
    ['a TXXX SUBTITLE, then TIT3: frame order', tagged(txxxFrame('SUBTITLE', 'Demo', 3), textFrame('TIT3', 'Live', 3)), 'Go (Demo)'],
    ['an empty TIT3 is none', tagged(textFrame('TIT3', '', 3)), 'Go'],
  ] as const) {
    assert.equal(asked(bytes, title).found, join(root, MP3), label);
  }
  // Two iTunes subtitle items under keys Navidrome lowers alike: it keeps one at random.
  const two = mp4({ title: 'Go' }, { items: [freeform('SUBTITLE', ['Live']), freeform('Subtitle', ['Live'])] });
  assert.equal(asked(two, 'Go (Live)', 'm4a').found, null, 'two iTunes subtitle items');
  // A TXXX described as another of Navidrome's title keys would reorder them.
  assert.equal(asked(tagged(txxxFrame('TIT3', 'Live', 3)), 'Go').found, null, 'a TXXX described TIT3');
});

test('a right file with a subtitle reads as unread, not a miss, where the server reports the title alone', () => {
  // Navidrome with Subsonic.AppendSubtitle off, or another server.
  const bytes = Buffer.concat([id3v2([textFrame('TIT2', 'Intro', 3), textFrame('TIT3', 'Live', 3)], { version: 4 }), audioBytes(4096)]);
  put(join(root, MP3), bytes);
  assert.equal(localFileState(song(`/srv/library/${MP3}`, 'Intro', bytes.length)), 'unread');
  assert.equal(localFileState(song(`/srv/library/${MP3}`, 'Intro (Live)', bytes.length)), 'proved');
  assert.equal(localFileState(song(`/srv/library/${MP3}`, 'Outro', bytes.length)), 'none', 'another title is a miss');
});

test('Vorbis comment keys are matched as TagLib upper-cases them, and Navidrome\'s other title keys count', () => {
  const FLAC_SONG = 'Artist/Album/01 - Song.flac';
  const cases: [string, Comments, string][] = [
    ['title=', [['title', 'Go']], 'Go'],
    ['Title=', [['Title', 'Go']], 'Go'],
    ['title= then TITLE=: one key, in field order', [['title', 'Go'], ['TITLE', 'Up']], 'Go'],
    ['TITLE= empty, then TITLE=Go: the empty value is dropped', [['TITLE', ''], ['TITLE', 'Go']], 'Go'],
    ['TIT2= ahead of TITLE= in Navidrome\'s order', [['TITLE', 'Up'], ['TIT2', 'Go']], 'Go'],
    ['a NUL ends the value', [['TITLE', 'Go\0Up']], 'Go'],
  ];
  for (const [label, fields, title] of cases) {
    assert.equal(asked(flac(fields), title, 'flac').found, join(root, FLAC_SONG), label);
  }
  assert.equal(asked(flac([['title', 'Go'], ['TITLE', 'Up']]), 'Up', 'flac').found, null, 'the second value is not the title');
});

test('MP4 is read only at moov/udta/meta/ilst, as TagLib reads it: a stale ilst in a free atom is never the title', () => {
  const M4A = 'Artist/Album/01 - Song.m4a';
  for (const layout of ['late', 'fast'] as const) {
    const stale = mp4({ title: 'Up' }, { layout, stale: 'Go' });
    assert.equal(asked(stale, 'Go', 'm4a').found, null, `${layout}: the stale title`);
    assert.equal(asked(stale, 'Up', 'm4a').found, join(root, M4A), `${layout}: the live one, which Navidrome reports`);
    // The real ilst has no ©nam: Navidrome titles the file from its name.
    assert.equal(asked(mp4({ album: 'Album' }, { layout, stale: 'Go' }), 'Go', 'm4a').found, null, `${layout}: no live title`);
  }
  // A ©nam anywhere else: under a trak's udta, ahead of the moov's, or a top-level udta.
  const trakUdta = mp4({ album: 'Album' }, { trakItems: [atom(NAM, dataAtom(Buffer.from('Go'), 1))] });
  assert.equal(asked(trakUdta, 'Go', 'm4a').found, null, 'under trak/udta');
  const topUdta = Buffer.concat([mp4({ album: 'Album' }), atom('udta', atom('meta', Buffer.alloc(4), atom('ilst', atom(NAM, dataAtom(Buffer.from('Go'), 1)))))]);
  assert.equal(asked(topUdta, 'Go', 'm4a').found, null, 'a top-level udta');
  // A meta written without version and flags (QuickTime's) is read as TagLib reads it.
  assert.equal(asked(mp4({ title: 'Go' }, { fullMeta: false }), 'Go', 'm4a').found, join(root, M4A), 'meta without version and flags');
});

test('MP4 values are UTF-8 data atoms of version 0 only, and the first ©nam item counts', () => {
  const M4A = 'Artist/Album/01 - Song.m4a';
  const nam = (...data: Buffer[]) => atom(NAM, ...data);
  const utf16 = (v: string) => dataAtom(Buffer.from(v, 'utf16le').swap16(), 2);
  const utf8 = (v: string) => dataAtom(Buffer.from(v, 'utf8'), 1);
  const version1 = (v: string) => dataAtom(Buffer.from(v, 'utf8'), 0x01000001);
  for (const [label, items, title, plays] of [
    ['UTF-16 (type 2) only', [nam(utf16('Go'))], 'Go', false],
    ['type 2 "Go", then UTF-8 "Up"', [nam(utf16('Go'), utf8('Up'))], 'Up', true],
    ['type 2 "Go", then UTF-8 "Up": not "Go"', [nam(utf16('Go'), utf8('Up'))], 'Go', false],
    ['version 1', [nam(version1('Go'))], 'Go', false],
    ['an empty value, then "Go": Navidrome drops the empty one', [nam(utf8(''), utf8('Go'))], 'Go', true],
    ['two ©nam items: the first', [nam(utf8('Up')), nam(utf8('Go'))], 'Up', true],
    ['two ©nam items: not the second', [nam(utf8('Up')), nam(utf8('Go'))], 'Go', false],
    ['a ©nam with no UTF-8 value, then one with: the second', [nam(utf16('Up')), nam(utf8('Go'))], 'Go', true],
  ] as const) {
    assert.equal(asked(mp4({}, { items: [...items] }), title, 'm4a').found, plays ? join(root, M4A) : null, label);
  }
});

test('MP4 items TagLib reads its own way are unsure: Navidrome reports another title for each', () => {
  // Each mount file below reads as the asked title to a reader that skips the rule,
  // and stock Navidrome 0.64.2 reports another: an atom named after one of its title
  // or subtitle keys is that key; TagLib reads a 64-bit item's size as its data; a
  // data atom under 16 bytes runs its value on into the next atom (`data`); and a
  // length of 2^31 or more is negative to it, which ends the item.
  const go = dataAtom(Buffer.from('Go'), 1);
  const up = atom(NAM, dataAtom(Buffer.from('Up'), 1));
  const named = (name: string, value: string) => atom(Buffer.from(name, 'latin1'), dataAtom(Buffer.from(value), 1));
  // A data atom whose size field says `length`, whatever follows it.
  const data = (length: number, value: string) => Buffer.concat([u32be(length), Buffer.from('data'), u32be(1), u32be(0), Buffer.from(value)]);
  // A data atom of 12 to 15 bytes, all of it there.
  const short = (length: number) => Buffer.concat([u32be(length), Buffer.from('data'), u32be(1), Buffer.alloc(length - 12)]);
  const subtitle = (...data: Buffer[]) => atom('----', atom('mean', u32be(0), Buffer.from('com.apple.iTunes')), atom('name', u32be(0), Buffer.from('SUBTITLE')), ...data);
  for (const [label, items, title] of [
    // Navidrome: `Up`, `Up`, `Go (Live)`, `Up`.
    ['an atom named TIT2', [atom(NAM, go), named('TIT2', 'Up')], 'Go'],
    ['an atom named tit2', [atom(NAM, go), named('tit2', 'Up')], 'Go'],
    ['an atom named TIT3', [atom(NAM, go), named('TIT3', 'Live')], 'Go'],
    ['an iTunes freeform TIT2', [atom(NAM, go), freeform('TIT2', ['Up'])], 'Go'],
    // Navidrome: the file's name, `Up`, and `Go` with the subtitle item dropped.
    ['a ©nam with a 64-bit size', [wideAtom(atom(NAM, go))], 'Go'],
    ['a ©nam with a 64-bit size, then ©nam "Up"', [wideAtom(atom(NAM, go)), up], 'Go'],
    ['an iTunes SUBTITLE with a 64-bit size', [atom(NAM, go), wideAtom(freeform('SUBTITLE', ['Live']))], 'Go (Live)'],
    // Navidrome: `data`, `Up`, the file's name, `Go (data)`.
    ['a 12-byte data atom, then "Go"', [atom(NAM, short(12), go)], 'Go'],
    ['a data atom of 2^31 bytes or more, then ©nam "Up"', [atom(NAM, data(0xfffffff0, 'Go')), up], 'Go'],
    ['a data atom of type 21, then one cut off, then ©nam "Go"', [atom(NAM, dataAtom(Buffer.from('X'), 21), Buffer.from('\0\0\0\x0cdata\x01', 'latin1')), atom(NAM, go)], 'Go'],
    ['an iTunes SUBTITLE with a 12-byte data atom', [atom(NAM, go), subtitle(short(12), dataAtom(Buffer.from('Live'), 1))], 'Go (Live)'],
  ] as const) {
    assert.equal(asked(mp4({}, { items: [...items] }), title, 'm4a').found, null, label);
  }
  // Broader than TagLib, and no tagger writes them: Navidrome reports `Go` for each
  // of these, and they stream. Two `TITLE` keys, or a key Navidrome ranks behind
  // `title`, happen to resolve to `©nam` here; this doesn't lean on how.
  for (const [label, items] of [
    ['an atom named ©NAM', [atom(NAM, go), named('\xa9NAM', 'Up')]],
    ['an atom named INAM ahead of ©nam', [named('INAM', 'Up'), atom(NAM, go)]],
    ['an iTunes freeform TITLE', [atom(NAM, go), freeform('TITLE', ['Up'])]],
    ['a freeform tit2 under another mean', [atom(NAM, go), freeform('tit2', ['Up'], 'org.example')]],
    ['a ©nam, then one with a 64-bit size', [atom(NAM, go), wideAtom(up)]],
    ['a 15-byte data atom, then "Go"', [atom(NAM, short(15), go)]],
    ['a data atom running past its item', [atom(NAM, data(40, 'Go'))]],
    ['a data atom, then an 8-byte atom in the item', [atom(NAM, go, atom('free'))]],
  ] as const) {
    assert.equal(asked(mp4({}, { items: [...items] }), 'Go', 'm4a').found, null, label);
  }
});

test('MP4 items after one whose data lies past the windows are still checked by name', () => {
  // A 70 KB freeform item leaves the head window; the atom named TIT2 after it is
  // in the tail window, and Navidrome would title the file `Up`.
  const big = freeform('iTunNORM', ['x'.repeat(70 * 1024)]);
  const bytes = mp4({ title: 'Go' }, { items: [big, atom(Buffer.from('TIT2'), dataAtom(Buffer.from('Up'), 1))], audio: 4096 });
  assert.equal(asked(bytes, 'Go', 'm4a').found, null);
});

test('MP4 atoms TagLib reads as its spec has them: a 64-bit size and a size of 0 on the path', () => {
  const M4A = 'Artist/Album/01 - Song.m4a';
  const late = mp4({ title: 'Go' }, { layout: 'late' });
  const moov = late.lastIndexOf('moov') - 4;
  // A 64-bit moov, as a writer may make any atom.
  assert.equal(asked(Buffer.concat([late.subarray(0, moov), wideAtom(late.subarray(moov))]), 'Go', 'm4a').found, join(root, M4A), 'a 64-bit moov');
  // A size of 0: the moov runs to the end of the file.
  const open = Buffer.from(late);
  open.writeUInt32BE(0, moov);
  assert.equal(asked(open, 'Go', 'm4a').found, join(root, M4A), 'a moov of size 0 at the end');
});

test('an MP4 Navidrome wouldn\'t index streams: an atom TagLib rejects ahead of the ilst', () => {
  const M4A = 'Artist/Album/01 - Song.m4a';
  const broken = Buffer.from([0, 0, 0, 4, 0x66, 0x72, 0x65, 0x65]); // `free` claiming 4 bytes
  assert.equal(asked(mp4({ title: 'Go' }, { moovBefore: [broken] }), 'Go', 'm4a').found, null, 'inside moov, ahead of udta');
  assert.equal(asked(mp4({ title: 'Go' }, { items: [broken] }), 'Go', 'm4a').found, null, 'inside the ilst');
  // Past the ilst the walk stops, so a broken atom there isn't seen: the file
  // plays, though Navidrome doesn't index it (a stated residual).
  assert.equal(asked(mp4({ title: 'Go' }, { moovExtra: [broken] }), 'Go', 'm4a').found, join(root, M4A), 'inside moov, after udta');
  const before = mp4({ title: 'Go' }, { layout: 'late' });
  const mdat = before.indexOf('mdat') - 4;
  const bad = Buffer.concat([before.subarray(0, mdat), broken, before.subarray(mdat)]);
  assert.equal(asked(bad, 'Go', 'm4a').found, null, 'ahead of moov');
  // Behind a sound moov, TagLib takes it for trailing garbage.
  assert.equal(asked(Buffer.concat([mp4({ title: 'Go' }), broken]), 'Go', 'm4a').found, join(root, M4A), 'after it');
});

test('the extension picks the reader, as Navidrome\'s does', () => {
  const tagged = Buffer.concat([id3v2([textFrame('TIT2', 'Go')]), audioBytes(4096)]);
  for (const ext of ['wav', 'aiff', 'wv', 'wma', 'ape', 'flac', 'm4a', 'ogg']) {
    assert.equal(asked(tagged, 'Go', ext).found, null, `ID3v2 bytes named .${ext}`);
  }
  assert.equal(asked(tagged, 'Go', 'MP3').found, join(root, 'Artist/Album/01 - Song.MP3'), 'case does not matter');
});

test('ID3v2 is read past unsynchronisation, a 2.4 extended header and a footer', () => {
  for (const [label, tag] of [
    ['2.2, the whole tag unsynchronised', id3v2([textFrame('TT2', WIDE, 1)], { version: 2, unsync: true })],
    ['2.3, the whole tag unsynchronised', id3v2([textFrame('TIT2', WIDE, 1)], { version: 3, unsync: true })],
    ['2.4, the frame unsynchronised', id3v2([textFrame('TIT2', WIDE, 1, { flags: { unsync: true } })], { version: 4 })],
    ['2.4 with an extended header and a footer', id3v2([textFrame('TIT2', WIDE, 3)], { version: 4, extended: true, footer: true })],
  ] as const) {
    const { onMount, found } = asked(Buffer.concat([tag, audioBytes(4096)]), WIDE);
    assert.equal(found, onMount, label);
  }
});

test('ID3v2 that TagLib reads its own way streams: Navidrome reports another title for each', () => {
  // On stock Navidrome 0.64.2: a 2.3 extended header leaves TagLib no frames (the
  // file's name, or its ID3v1 title); a grouping byte is read as the text encoding
  // (`\x03Go`); a data length cuts the text (`GoUp` with 3 reads `Go`); and a major
  // version past 4 is read anyway, where an ID3v1 title behind it is not.
  for (const [label, tag] of [
    ['2.3 with an extended header', id3v2([textFrame('TIT2', WIDE, 1)], { version: 3, extended: true })],
    ['2.3 with a grouping byte', id3v2([textFrame('TIT2', WIDE, 1, { flags: { grouping: true } })], { version: 3 })],
    ['2.4 with a grouping byte', id3v2([textFrame('TIT2', WIDE, 3, { flags: { grouping: true } })], { version: 4 })],
    ['2.4 with a data length', id3v2([textFrame('TIT2', WIDE, 3, { flags: { dataLength: true } })], { version: 4 })],
    ['2.4 unsynchronised with a data length', id3v2([textFrame('TIT2', WIDE, 1, { flags: { unsync: true, dataLength: true } })], { version: 4 })],
    ['2.4 with a grouping byte and a data length', id3v2([textFrame('TIT2', WIDE, 3, { flags: { grouping: true, dataLength: true } })], { version: 4 })],
    ['2.3, compressed', id3v2([textFrame('TIT2', WIDE, 1, { flags: { compressed: true } })], { version: 3 })],
    ['2.4, compressed', id3v2([textFrame('TIT2', WIDE, 3, { flags: { compressed: true } })], { version: 4 })],
  ] as const) {
    assert.equal(asked(Buffer.concat([tag, audioBytes(4096)]), WIDE).found, null, label);
  }
  // A subtitle frame read differently is as unsure as a title frame.
  const groupedSubtitle = id3v2([textFrame('TIT2', 'Go', 3), textFrame('TIT3', 'Live', 3, { flags: { grouping: true } })], { version: 4 });
  assert.equal(asked(Buffer.concat([groupedSubtitle, audioBytes(4096)]), 'Go').found, null, 'a grouped TIT3');
  for (const major of [1, 5, 6]) {
    const odd = Buffer.concat([id3v2([textFrame('TIT2', 'Up')], { version: 4, major }), audioBytes(4096), id3v1({ title: 'Go' })]);
    assert.equal(asked(odd, 'Go').found, null, `major version ${major}, ID3v1 "Go" behind it`);
    assert.equal(asked(odd, 'Up').found, null, `major version ${major}, its own title`);
  }
});

test('TagLib stops reading frames while fewer than 10 bytes of the tag are left, after a footer\'s 10 come off', () => {
  // On stock Navidrome 0.64.2 each of the first two is titled from its file name.
  const footer = (frames: Id3Frame[]) => {
    const tag = id3v2(frames, { version: 4, footer: true });
    return Buffer.concat([tag, audioBytes(4096)]);
  };
  for (const [label, bytes, plays] of [
    ['2.2, no padding, TT2 in the last 9 bytes', Buffer.concat([id3v2([textFrame('TP1', 'Someone'), textFrame('TT2', 'Go')], { version: 2, padding: 0 }), audioBytes(4096)]), false],
    ['2.4 with a footer, TIT2 the last frame', footer([textFrame('TPE1', 'Someone', 3), textFrame('TIT2', 'Go', 3)]), false],
    // Under 10 bytes in all, the unsigned length wraps and every frame is read.
    ['2.2, no padding, only TT2', Buffer.concat([id3v2([textFrame('TT2', 'Go')], { version: 2, padding: 0 }), audioBytes(4096)]), true],
    ['2.4 with a footer, TIT2 then TPE1', footer([textFrame('TIT2', 'Go', 3), textFrame('TPE1', 'Someone', 3)]), true],
  ] as const) {
    assert.equal(asked(bytes, 'Go').found, plays ? join(root, MP3) : null, label);
  }
});

test('an ID3v1 title is stripped as TagLib strips it, so one of spaces is no title', () => {
  const spaces = Buffer.concat([audioBytes(4096), id3v1({ title: ' '.repeat(30) })]);
  put(join(root, MP3), spaces);
  assert.equal(localFileState(song(`/srv/library/${MP3}`, '01 - Song', spaces.length)), 'unread', 'Navidrome titles it from its name');
});

test('ID3v2 values are TagLib\'s: empty ones skipped, a UTF-16 value without a byte order mark taking the first one\'s', () => {
  const tag = (data: Buffer, version: 3 | 4 = 4) => Buffer.concat([id3v2([{ id: 'TIT2', data }], { version }), audioBytes(4096)]);
  const bom = (v: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(v, 'utf16le')]);
  for (const [label, bytes, title] of [
    ['Latin-1, an empty first value', tag(Buffer.from('\0\0Go', 'latin1')), 'Go'],
    ['UTF-8, two empty values first', tag(Buffer.from('\x03\0\0Go\0Up', 'latin1')), 'Go'],
    ['UTF-16, an empty first value', tag(Buffer.concat([Buffer.from([1]), Buffer.alloc(2), bom('Go')])), 'Go'],
    ['UTF-16, a first value of only a byte order mark', tag(Buffer.concat([Buffer.from([1]), bom(''), Buffer.alloc(2), bom('Go')])), 'Go'],
    ['UTF-16, the second value without a mark', tag(Buffer.concat([Buffer.from([1]), bom(''), Buffer.alloc(2), Buffer.from('Go', 'utf16le')])), 'Go'],
    ['two TIT2 frames, the first empty', Buffer.concat([id3v2([textFrame('TIT2', ''), textFrame('TIT2', 'Go')], { version: 4 }), audioBytes(4096)]), 'Go'],
  ] as const) {
    const { onMount, found } = asked(bytes, title);
    assert.equal(found, onMount, label);
  }
  // iTunes once wrote 2.2 ids into 2.3 tags, ending in a NUL or a space; TagLib
  // reads them as 2.2's.
  for (const id of ['TT2\0', 'TT2 ']) {
    const itunes = Buffer.concat([id3v2([{ id, data: Buffer.from('\0Go', 'latin1') }]), audioBytes(4096)]);
    assert.equal(asked(itunes, 'Go').found, join(root, MP3), `a 2.2 id in a 2.3 tag, ${JSON.stringify(id)}`);
  }
});

test('a title or subtitle value that isn\'t text is unsure, even after a valid one: Navidrome replaces it', () => {
  // Stock Navidrome 0.64.2 reports bytes that aren't UTF-8 as U+FFFD (`G\ufffdo`,
  // `Go (\ufffd)`, `Go (Live at the Caf\ufffd)`), and a lone surrogate as something
  // else again (a high one takes the next unit as its pair: `\u{11847}o`), where
  // dropping the bad value would read `Go`. After a valid value it reports the valid
  // one, but this doesn't lean on the order: any bad value read under a title or
  // subtitle key streams.
  const v24 = (...frames: Id3Frame[]) => Buffer.concat([id3v2(frames, { version: 4 }), audioBytes(4096)]);
  const raw = (id: string, bytes: string) => ({ id, data: Buffer.from(bytes, 'latin1') });
  const latin = (s: string) => Buffer.from(s, 'latin1');
  const surrogate = Buffer.concat([Buffer.from([1, 0xff, 0xfe, 0x3d, 0xd8]), Buffer.from('Go', 'utf16le')]);
  const item = (...data: Buffer[]) => atom(NAM, ...data);
  for (const [label, bytes, ext] of [
    ['ID3v2, the only value', v24(raw('TIT2', '\x03G\xffo')), 'mp3'],
    ['ID3v2, a bad value then "Go" in one frame', v24(raw('TIT2', '\x03G\xffo\0Go')), 'mp3'],
    ['ID3v2, a second TIT2 frame', v24(textFrame('TIT2', 'Go', 3), raw('TIT2', '\x03G\xffo')), 'mp3'],
    ['ID3v2, TIT3 "\\xff" beside TIT2 "Go"', v24(textFrame('TIT2', 'Go', 3), raw('TIT3', '\x03\xff')), 'mp3'],
    ['ID3v2, a TXXX SUBTITLE of Latin-1 marked UTF-8', v24(textFrame('TIT2', 'Go', 3), raw('TXXX', '\x03SUBTITLE\0Caf\xe9')), 'mp3'],
    ['ID3v2.3, TIT3 of Latin-1 marked UTF-8', Buffer.concat([id3v2([textFrame('TIT2', 'Go'), raw('TIT3', '\x03Live at the Caf\xe9')]), audioBytes(4096)]), 'mp3'],
    ['ID3v2, a lone UTF-16 surrogate', v24({ id: 'TIT2', data: surrogate }), 'mp3'],
    ['FLAC, TITLE=G\\xffo then TITLE=Go', flac([['TITLE', latin('G\xffo')], ['TITLE', 'Go']]), 'flac'],
    ['FLAC, TITLE=Go then TITLE=G\\xffo', flac([['TITLE', 'Go'], ['TITLE', latin('G\xffo')]]), 'flac'],
    ['FLAC, SUBTITLE in Latin-1', flac([['TITLE', 'Go'], ['SUBTITLE', latin('Live at the Caf\xe9')]]), 'flac'],
    ['Ogg Opus, SUBTITLE in Latin-1', ogg('opus', [['TITLE', 'Go'], ['SUBTITLE', latin('Caf\xe9')]]), 'opus'],
    ['M4A, \u00a9nam data "\\xff" then "Go"', mp4({}, { items: [item(dataAtom(latin('\xff'), 1), dataAtom(latin('Go'), 1))] }), 'm4a'],
    ['M4A, an iTunes SUBTITLE in Latin-1', mp4({ title: 'Go' }, { items: [freeform('SUBTITLE', [latin('Caf\xe9')])] }), 'm4a'],
  ] as const) {
    assert.equal(asked(bytes, 'Go', ext).found, null, label);
  }
  // A right file with a Latin-1 subtitle streams too, and the Doctor says why: its
  // tags hold no title the check can be sure of, not another title.
  const FLAC_SONG = 'Artist/Album/01 - Song.flac';
  const right = flac([['TITLE', 'Go'], ['SUBTITLE', latin('Live at the Caf\xe9')]]);
  put(join(root, FLAC_SONG), right);
  assert.equal(localFileState(song(`/srv/library/${FLAC_SONG}`, 'Go (Live at the Caf\ufffd)', right.length)), 'unread');
  const paired = v24({ id: 'TIT2', data: surrogate });
  put(join(root, MP3), paired);
  assert.equal(localFileState(song(`/srv/library/${MP3}`, '\u{11847}o', paired.length)), 'unread', 'a lone surrogate, as Navidrome reports it');
  // Past a frame's first value that isn't empty nothing is decoded: Navidrome
  // reports that first value.
  assert.equal(asked(v24(raw('TIT2', '\x03Go\0G\xffo')), 'Go').found, join(root, MP3), 'a bad second value in one frame');
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
    // Read by atom path, the walk needs the moov's own header in a window.
    ['M4A, a late moov that starts before the last 64 KiB', mp4({ title: 'Song' }, { layout: 'late', tables: big, audio: big }), 'm4a', false],
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
  assert.deepEqual(fileTitle('m4a', zero, tail(zero)), { kind: 'unsure' }, 'no moov: Navidrome doesn\'t index it');
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

// Combining marks in descending class order, the order NFC has the most work to sort.
const MARKS = Array.from({ length: 4096 }, (_, i) => ['\u0345', '\u0315', '\u0300', '\u0316', '\u0334'][i % 5]).join('');

const HOSTILE: { name: string; ext: string; title?: string; bytes: () => Buffer }[] = [
  { name: 'ID3v2.3 TIT2, 65,000 spaces then x', ext: 'mp3', bytes: () => Buffer.concat([id3v2([textFrame('TIT2', runThenX(65000))], { padding: 0 }), audioBytes(200_000)]) },
  { name: 'ID3v2.3 TIT2, 65,000 NULs then x', ext: 'mp3', bytes: () => Buffer.concat([id3v2([textFrame('TIT2', runThenX(65000, '\0'))], { padding: 0 }), audioBytes(200_000)]) },
  { name: 'FLAC TITLE=, 65,000 spaces then x', ext: 'flac', bytes: () => flac([['TITLE', runThenX(65000)]], { audio: 200_000 }) },
  { name: 'MP4 ©nam, 65,000 spaces then x', ext: 'm4a', bytes: () => mp4({ title: runThenX(65000) }, { tables: 100, audio: 200_000 }) },
  { name: 'MP4, an ilst in every 12-byte child', ext: 'm4a', bytes: bombM4a },
  // NFC reorders a run of combining marks in quadratic time; the cut bounds the run.
  { name: 'ID3v2.4 TIT2, 4,096 combining marks', ext: 'mp3', title: `a${MARKS.slice(0, 511)}`, bytes: () => Buffer.concat([id3v2([textFrame('TIT2', `a${MARKS}`, 3)], { version: 4, padding: 0 }), audioBytes(200_000)]) },
  { name: 'ID3v2.4, 2 × 4,096 combining marks in TIT2 and TIT3', ext: 'mp3', title: `a${MARKS.slice(0, 511)} (${MARKS.slice(0, 512)})`, bytes: () => Buffer.concat([id3v2([textFrame('TIT2', `a${MARKS}`, 3), textFrame('TIT3', MARKS, 3)], { version: 4, padding: 0 }), audioBytes(200_000)]) },
  { name: 'MP4, 7,000 empty containers ahead of the udta', ext: 'm4a', bytes: () => mp4({ title: 'Song' }, { moovBefore: Array.from({ length: 7000 }, () => atom('trak')), audio: 200_000 }) },
  // Only a frame's first value is decoded, however many it splits into.
  { name: 'ID3v2.4 TIT2 and TIT3 of 15,000 NUL-split values each', ext: 'mp3', title: 'a (a)', bytes: () => Buffer.concat([id3v2([textFrame('TIT2', 'a\0'.repeat(15000)), textFrame('TIT3', 'a\0'.repeat(15000))], { version: 4, padding: 0 }), audioBytes(200_000)]) },
  { name: 'ID3v2.4, 2,500 TXXX SUBTITLE frames, then TIT2', ext: 'mp3', title: 'Go (b)', bytes: () => Buffer.concat([id3v2([...Array.from({ length: 2500 }, () => txxxFrame('SUBTITLE', 'b\0'.repeat(6), 3)), textFrame('TIT2', 'Go', 3)], { version: 4, padding: 0 }), audioBytes(200_000)]) },
  { name: 'ID3v2.4, 4,000 TXXX frames of other descriptions', ext: 'mp3', title: 'Go', bytes: () => Buffer.concat([id3v2([...Array.from({ length: 4000 }, () => txxxFrame('xxx', 'v', 3)), textFrame('TIT2', 'Go', 3)], { version: 4, padding: 0 }), audioBytes(200_000)]) },
];

for (const { name, ext, title = 'Song', bytes } of HOSTILE) {
  test(`hostile: ${name} costs a proof well under ${PROOF_BUDGET_MS} ms, on every path`, () => {
    const rel = `Hostile/Album/01 - Song.${ext}`;
    const data = bytes();
    put(join(root, rel), data);
    const track = song(`/srv/library/${rel}`, title, data.length);
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

test('a field is cut at 1,024 bytes, never half a character, as Navidrome cuts it', () => {
  assert.equal(cutTag('x'.repeat(MAX_TAG_BYTES)), 'x'.repeat(MAX_TAG_BYTES));
  assert.equal(cutTag('x'.repeat(MAX_TAG_BYTES + 1)), 'x'.repeat(MAX_TAG_BYTES));
  assert.equal(cutTag(`x${'é'.repeat(600)}`), `x${'é'.repeat(511)}`, 'a two-byte character the cut would halve is dropped');
  assert.equal(cutTag(`xy${'😀'.repeat(300)}`), `xy${'😀'.repeat(255)}`, 'and a four-byte one');
  const tagged = (title: string) => Buffer.concat([id3v2([textFrame('TIT2', title, 3)], { version: 4, padding: 0 }), audioBytes(4096)]);
  for (const [label, field, title, plays] of [
    ['longer than the cut, asked for as Navidrome reports it', 'x'.repeat(1030), 'x'.repeat(MAX_TAG_BYTES), true],
    ['longer than the cut, asked for whole', 'x'.repeat(1030), 'x'.repeat(1030), false],
    ['padded far past the cut with spaces', `Song${' '.repeat(5000)}`, 'Song', true],
    ['spaces ahead of the title, past the cut', `${' '.repeat(1100)}Song`, 'Song', false],
  ] as const) {
    assert.equal(asked(tagged(field), title).found, plays ? join(root, MP3) : null, label);
  }
});

test('a server title longer than Navidrome can report is no proof, and costs no stat', (t) => {
  audio(join(root, SONG));
  const cost = diskCost(t);
  const long = song(`/srv/library/${SONG}`, 'Song'.padEnd(MAX_REPORTED_TITLE_BYTES + 1, ' '));
  assert.deepEqual(cost(() => assert.equal(getLocalPath(long), null)), { stats: 0, opens: 0 });
  const wide = song(`/srv/library/${SONG}`, `Song${'é'.repeat(1024)}`);
  assert.deepEqual(cost(() => assert.equal(getLocalPath(wide), null)), { stats: 0, opens: 0 }, 'counted in bytes');
  assert.equal(getLocalPath(song(`/srv/library/${SONG}`, 'Song'.padEnd(MAX_REPORTED_TITLE_BYTES, ' '))), join(root, SONG), 'at the bound it proves');
});

test('the MP4 walk reads each header once: at most one step per 8 bytes', () => {
  // A moov of 8-byte empty containers ahead of its udta, the most atoms a window
  // can hold, each parsed whole as TagLib parses it.
  const wide = atom('moov', ...Array.from({ length: 8000 }, () => atom('trak')), atom('udta'));
  const bytes = Buffer.concat([atom('ftyp', Buffer.from('M4A ')), wide]);
  const steps = _mp4Steps(bytes);
  assert.ok(steps <= bytes.length / 8, `${steps} steps for ${bytes.length} bytes`);
  assert.ok(_mp4Steps(mp4({ title: 'Song', album: 'Album', artist: 'Artist' })) <= 18, 'a real file');
  // Nested past TagLib's depth, which stops descending there: unsure.
  let deep = atom('ilst');
  for (let i = 0; i < 70; i++) deep = atom('udta', deep);
  assert.deepEqual(fileTitle('m4a', Buffer.concat([atom('ftyp', Buffer.from('M4A ')), atom('moov', deep)]), () => Buffer.alloc(0)), { kind: 'unsure' });
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
  // Navidrome cuts the title it reports at 1,024 bytes.
  tracks.push(song('/srv/library/Coast/Hostile/01 - Ws.mp3', `Hostile${' '.repeat(1017)}`, ws.length));
  const bomb = bombM4a();
  put(join(root, 'Coast/Hostile/02 - Ilst.m4a'), bomb);
  tracks.push(song('/srv/library/Coast/Hostile/02 - Ilst.m4a', 'Ilst Bomb', bomb.length));
  let lines: string[] = [];
  const ms = elapsed(() => { lines = tracks.map(s => getAnnotatedUri(s, {})); });
  assert.ok(ms < 1000, `${ms.toFixed(1)} ms for 40 tracks`);
  // Both hostile files hold the title Navidrome reports, so they play too.
  assert.equal(lines.filter(l => !l.includes('subhttp:')).length, 40, 'every right file plays from disk');
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
