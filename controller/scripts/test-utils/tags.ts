// Tagged stand-in audio files for the local-path proof's tests, built byte for
// byte from each format's spec (ID3v2.2-2.4, ID3v1, FLAC, Ogg, MP4), so the
// reader in src/music/tag-title.ts is tested against the formats, not against
// itself. Audio is filler bytes; nothing here decodes as sound.

const latin1 = (s: string) => Buffer.from(s, 'latin1');
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u24be = (n: number) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const syncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

/** Filler that holds no tag, or the given words where audio would be. */
export function audioBytes(length: number, words = ''): Buffer {
  const body = Buffer.alloc(length, 0x55);
  if (words) Buffer.from(words, 'utf8').copy(body, Math.floor(length / 3));
  return body;
}

// ---- ID3v2 ------------------------------------------------------------------

export type Id3Encoding = 0 | 1 | 2 | 3;

/** ID3v2 text encodings: 0 Latin-1, 1 UTF-16 with a BOM, 2 UTF-16BE, 3 UTF-8. */
export function id3TextData(value: string, encoding: Id3Encoding, { bigEndianBom = false, terminator = false } = {}): Buffer {
  const le = Buffer.from(value, 'utf16le');
  const be = Buffer.from(le).swap16();
  const text = encoding === 0 ? latin1(value)
    : encoding === 1 ? Buffer.concat([Buffer.from(bigEndianBom ? [0xfe, 0xff] : [0xff, 0xfe]), bigEndianBom ? be : le])
      : encoding === 2 ? be
        : Buffer.from(value, 'utf8');
  const nul = terminator ? Buffer.alloc(encoding === 1 || encoding === 2 ? 2 : 1) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([encoding]), text, nul]);
}

/** ID3v2 unsynchronisation: a 0x00 after every 0xFF that a sync word could follow. */
export function unsync(bytes: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && (i + 1 === bytes.length || bytes[i + 1] >= 0xe0 || bytes[i + 1] === 0x00)) out.push(0x00);
  }
  return Buffer.from(out);
}

export interface Id3FrameFlags { grouping?: boolean; dataLength?: boolean; unsync?: boolean; compressed?: boolean }
export interface Id3Frame { id: string; data: Buffer; flags?: Id3FrameFlags }

/** A text frame (`TIT2`, `TALB`, `TT2`…) holding one value. */
export const textFrame = (id: string, value: string, encoding: Id3Encoding = 0,
  { flags, terminator = false, bigEndianBom = false }: { flags?: Id3FrameFlags; terminator?: boolean; bigEndianBom?: boolean } = {}): Id3Frame =>
  ({ id, data: id3TextData(value, encoding, { terminator, bigEndianBom }), flags });

// Frame flags in the spec's order: grouping byte, then the data length, and on
// 2.4 unsynchronisation over all of it. The spec makes the data length optional
// with unsynchronisation, so it is there only when asked for, or compressed.
function id3Frame(frame: Id3Frame, version: 2 | 3 | 4): Buffer {
  if (version === 2) return Buffer.concat([latin1(frame.id), u24be(frame.data.length), frame.data]);
  const f = frame.flags ?? {};
  let data = frame.data;
  let flags = 0;
  if (version === 3) {
    if (f.grouping) { flags |= 0x0020; data = Buffer.concat([Buffer.from([7]), data]); }
    if (f.compressed) { flags |= 0x0080; data = Buffer.concat([u32be(data.length), data]); }
    return Buffer.concat([latin1(frame.id), u32be(data.length), Buffer.from([flags >> 8, flags & 0xff]), data]);
  }
  const original = data.length;
  if (f.dataLength || f.compressed) { flags |= 0x0001; data = Buffer.concat([syncsafe(original), data]); }
  if (f.grouping) { flags |= 0x0040; data = Buffer.concat([Buffer.from([7]), data]); }
  if (f.compressed) flags |= 0x0008;
  if (f.unsync) { flags |= 0x0002; data = unsync(data); }
  return Buffer.concat([latin1(frame.id), syncsafe(data.length), Buffer.from([flags >> 8, flags & 0xff]), data]);
}

/** A user text frame: a description, then its values. */
export const txxxFrame = (description: string, value: string, encoding: Id3Encoding = 0): Id3Frame =>
  ({ id: 'TXXX', data: id3TextData(`${description}\0${value}`, encoding) });

/**
 * A whole ID3v2 tag. `unsync` on 2.2/2.3 applies to the tag; on 2.4 set it per
 * frame. `major` writes another version number over frames laid out as `version`.
 */
export function id3v2(frames: Id3Frame[], { version = 3 as 2 | 3 | 4, padding = 64, unsync: tagUnsync = false, extended = false, footer = false, major = 0 } = {}): Buffer {
  let body: Buffer = Buffer.concat(frames.map(f => id3Frame(f, version)));
  let flags = 0;
  if (extended && version === 3) { flags |= 0x40; body = Buffer.concat([u32be(6), Buffer.alloc(6), body]); }
  if (extended && version === 4) { flags |= 0x40; body = Buffer.concat([syncsafe(6), Buffer.from([1, 0]), body]); }
  if (tagUnsync && version < 4) { flags |= 0x80; body = unsync(body); }
  if (footer && version === 4) flags |= 0x10;
  body = Buffer.concat([body, Buffer.alloc(footer ? 0 : padding)]);
  const header = (magic: string) => Buffer.concat([latin1(magic), Buffer.from([major || version, 0, flags]), syncsafe(body.length)]);
  return Buffer.concat([header('ID3'), body, footer ? header('3DI') : Buffer.alloc(0)]);
}

/** An ID3v1 block: 128 bytes, Latin-1 fields padded with NULs. */
export function id3v1({ title = '', artist = '', album = '' }: { title?: string; artist?: string; album?: string }): Buffer {
  const field = (s: string, n: number) => { const b = Buffer.alloc(n); latin1(s).copy(b, 0, 0, n); return b; };
  return Buffer.concat([latin1('TAG'), field(title, 30), field(artist, 30), field(album, 30), field('2001', 4), field('', 30), Buffer.from([255])]);
}

// ---- Vorbis comments: FLAC and Ogg -----------------------------------------

export type Comments = [string, string][];

export function vorbisComment(comments: Comments, vendor = 'reference libFLAC 1.4.3'): Buffer {
  const fields = comments.map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  return Buffer.concat([u32le(Buffer.byteLength(vendor)), Buffer.from(vendor), u32le(fields.length), ...fields.flatMap(f => [u32le(f.length), f])]);
}

const flacBlock = (type: number, data: Buffer, last: boolean) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type]), u24be(data.length), data]);

/**
 * `fLaC`, STREAMINFO, an optional PICTURE of `picture` bytes ahead of the comments,
 * the VORBIS_COMMENT block (left out with `noComments`), then audio.
 */
export function flac(comments: Comments, { picture = 0, audio = 4096, id3 = Buffer.alloc(0) as Buffer, words = '', noComments = false } = {}): Buffer {
  const blocks: [number, Buffer][] = [[0, Buffer.alloc(34, 1)]];
  if (picture) blocks.push([6, Buffer.alloc(picture, 0x89)]);
  if (!noComments) blocks.push([4, vorbisComment(comments)]);
  return Buffer.concat([
    id3,
    latin1('fLaC'),
    ...blocks.map(([type, data], i) => flacBlock(type, data, i === blocks.length - 1)),
    audioBytes(audio, words),
  ]);
}

/** An APEv2 tag: items, then the 32-byte `APETAGEX` footer, as foobar2000 writes it. */
export function apeTag(fields: Record<string, string>): Buffer {
  const items = Object.entries(fields).map(([k, v]) => {
    const value = Buffer.from(v, 'utf8');
    return Buffer.concat([u32le(value.length), u32le(0), latin1(k), Buffer.from([0]), value]);
  });
  const body = Buffer.concat(items);
  return Buffer.concat([body, latin1('APETAGEX'), u32le(2000), u32le(body.length + 32), u32le(items.length), u32le(0), Buffer.alloc(8)]);
}

// Ogg pages for one stream's packets, at most `segments` lacing values a page, so
// a packet can span pages. The CRC is left at zero: the reader doesn't check it.
function oggPages(packets: Buffer[], serial: number, segments: number): Buffer {
  const laces: { lace: number; bytes: Buffer }[] = [];
  for (const p of packets) {
    let at = 0;
    for (; p.length - at >= 255; at += 255) laces.push({ lace: 255, bytes: p.subarray(at, at + 255) });
    laces.push({ lace: p.length - at, bytes: p.subarray(at) });
  }
  const pages: Buffer[] = [];
  for (let i = 0, seq = 0; i < laces.length; i += segments, seq++) {
    const page = laces.slice(i, i + segments);
    const header = Buffer.alloc(27);
    header.write('OggS', 0, 'latin1');
    header[5] = seq === 0 ? 0x02 : (laces[i - 1]?.lace === 255 ? 0x01 : 0);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(seq, 18);
    header[26] = page.length;
    pages.push(header, Buffer.from(page.map(l => l.lace)), ...page.map(l => l.bytes));
  }
  return Buffer.concat(pages);
}

/** Ogg Vorbis, Opus or FLAC with these comments; `segments` small to split the comment over pages. */
export function ogg(kind: 'vorbis' | 'opus' | 'flac', comments: Comments, { segments = 255, audio = 4096, serial = 0x5eed, words = '' } = {}): Buffer {
  const vc = vorbisComment(comments, 'Lavf61.7.100');
  const packets = kind === 'vorbis'
    ? [Buffer.concat([latin1('\x01vorbis'), Buffer.alloc(23, 2)]), Buffer.concat([latin1('\x03vorbis'), vc, Buffer.from([1])]), Buffer.concat([latin1('\x05vorbis'), Buffer.alloc(40, 3)])]
    : kind === 'opus'
      ? [Buffer.concat([latin1('OpusHead'), Buffer.alloc(11, 1)]), Buffer.concat([latin1('OpusTags'), vc])]
      : [Buffer.concat([latin1('\x7fFLAC'), Buffer.from([1, 0, 0, 1]), latin1('fLaC'), flacBlock(0, Buffer.alloc(34, 1), false)]), flacBlock(4, vc, true)];
  return Buffer.concat([oggPages(packets, serial, segments), oggPages([audioBytes(audio, words)], serial + 1, 255)]);
}

// ---- MP4 --------------------------------------------------------------------

export const atom = (type: string | Buffer, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32be(body.length + 8), typeof type === 'string' ? latin1(type) : type, body]);
};
const NAM = Buffer.from([0xa9, 0x6e, 0x61, 0x6d]);
const ALB = Buffer.from([0xa9, 0x61, 0x6c, 0x62]);
const ART = Buffer.from([0xa9, 0x41, 0x52, 0x54]);
/** A `data` atom: its type and version word (1 is UTF-8, version 0), a locale, the value. */
export const dataAtom = (value: Buffer, type: number) => atom('data', u32be(type), u32be(0), value);
/** An iTunes freeform item, `----` with `mean`, `name` and UTF-8 values. */
export const freeform = (name: string, values: string[], mean = 'com.apple.iTunes') =>
  atom('----', atom('mean', u32be(0), Buffer.from(mean, 'utf8')), atom('name', u32be(0), Buffer.from(name, 'utf8')),
    ...values.map(v => dataAtom(Buffer.from(v, 'utf8'), 1)));
export { NAM };

/**
 * An M4A: `ftyp`, then `moov` ahead of `mdat` (fast start) or after it (the default
 * writer). `tables` stands in for the sample tables ahead of `udta`; `cover` adds
 * a `covr` of that many bytes after `©nam`, as ffmpeg writes it. The other fields
 * come first, so a reader that took any field would take one of them. `stale`
 * puts a `free` atom holding an old `ilst` with that `©nam` just ahead of `moov`,
 * as retagging in place leaves it.
 */
export function mp4({ title, album, artist, utf16 = false, subtitle }: { title?: string; album?: string; artist?: string; utf16?: boolean; subtitle?: string },
  { layout = 'fast' as 'fast' | 'late', tables = 2000, cover = 0, audio = 4096, words = '', stale = undefined as string | undefined,
    items = [] as Buffer[], moovExtra = [] as Buffer[], moovBefore = [] as Buffer[], fullMeta = true, trakItems = undefined as Buffer[] | undefined } = {}): Buffer {
  const text = (s: string) => utf16 ? dataAtom(Buffer.from(s, 'utf16le').swap16(), 2) : dataAtom(Buffer.from(s, 'utf8'), 1);
  const ilst = atom('ilst',
    ...(album !== undefined ? [atom(ALB, text(album))] : []),
    ...(artist !== undefined ? [atom(ART, text(artist))] : []),
    ...(title !== undefined ? [atom(NAM, text(title))] : []),
    ...(subtitle !== undefined ? [freeform('SUBTITLE', [subtitle])] : []),
    ...items,
    ...(cover ? [atom('covr', dataAtom(Buffer.alloc(cover, 0xd8), 13))] : []));
  const meta = atom('meta', ...(fullMeta ? [Buffer.alloc(4)] : []), atom('hdlr', Buffer.alloc(8), latin1('mdirappl'), Buffer.alloc(13)), ilst);
  // `tables` stands in for a trak's sample tables: a trak/mdia/minf/stbl chain, as
  // TagLib parses it, around one leaf of that size.
  // `trakItems` puts an ilst in the trak's own udta, ahead of the moov's.
  const trakUdta = trakItems ? [atom('udta', atom('meta', Buffer.alloc(4), atom('ilst', ...trakItems)))] : [];
  const trak = atom('trak', atom('mdia', atom('minf', atom('stbl', atom('stsz', Buffer.alloc(Math.max(0, tables - 32), 0x11))))), ...trakUdta);
  const moov = atom('moov', atom('mvhd', Buffer.alloc(100)), trak, ...moovBefore, atom('udta', meta), ...moovExtra);
  const ftyp = atom('ftyp', latin1('M4A '), u32be(512), latin1('M4A isomiso2'));
  const mdat = atom('mdat', audioBytes(audio, words));
  const old = stale === undefined ? [] : [atom('free', atom('ilst', atom(NAM, text(stale))))];
  return Buffer.concat(layout === 'fast' ? [ftyp, ...old, moov, mdat] : [ftyp, mdat, ...old, moov]);
}
