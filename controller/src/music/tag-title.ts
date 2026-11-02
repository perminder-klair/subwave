// The title a file's own tags hold, for the proof that a mapped guess is the
// track (subsonic.ts isRequestedFile). It reads the two windows the caller
// already has, the first and last 64 KiB, and in them only the title field of
// each layout, as its whole value:
// - ID3v2.2, 2.3 and 2.4 at the head (`TT2`/`TIT2`, all four text encodings);
// - Vorbis comments at the head (`TITLE=`), in FLAC and in Ogg Vorbis, Opus and FLAC;
// - the MP4 `©nam` data atom inside an `ilst`, at either end: a fast-start file
//   keeps its `moov` at the head, the default writer at the tail;
// - ID3v1, in the last 128 bytes.
// The same words in another field, in cover art or in the audio are not a title.
// A field the window cuts off, or a compressed or encrypted frame, is not read.
//
// One title per file, in the order TagLib (Navidrome's reader) prefers: a FLAC's
// comments over its ID3v2, ID3v2 over ID3v1. So a stale ID3v1 can't speak for a
// file whose ID3v2 names another song.
//
// Everything here is bounded by the buffer it is given, and garbage reads as no
// title: this runs on the push path, where a throw would cost the pick.

/** Both sides of the comparison: NFC, trimmed, trailing NULs dropped. */
export function normalizeTitle(value: string): string {
  return value.normalize('NFC').replace(/[\s\u0000]+$/u, '').trim();
}

/**
 * Does the file's title field hold this title? `none` when no title field could
 * be read in the windows. Case counts: the server read its `title` from this
 * same field, so the right file matches as written, and folding case would only
 * let in a file whose title differs.
 */
export function titleVerdict(field: string | null, title: string): 'same' | 'other' | 'none' {
  if (field === null) return 'none';
  const want = normalizeTitle(title);
  return want && normalizeTitle(field) === want ? 'same' : 'other';
}

/** The title field in the first window, or null when it holds none. */
export function headTitle(head: Buffer): string | null {
  try {
    const id3 = id3v2(head);
    return flacTitle(head, id3?.end ?? 0) ?? oggTitle(head) ?? id3?.title ?? mp4Title(head);
  } catch {
    return null;
  }
}

/** The title field in the last window: a late `moov`, then ID3v1. */
export function tailTitle(tail: Buffer): string | null {
  try {
    return mp4Title(tail) ?? id3v1Title(tail);
  } catch {
    return null;
  }
}

function startsWith(buf: Buffer, at: number, magic: string): boolean {
  return buf.length >= at + magic.length && buf.toString('latin1', at, at + magic.length) === magic;
}

function utf16(bytes: Buffer, bigEndian: boolean): string {
  const even = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  return (bigEndian ? even.swap16() : even).toString('utf16le');
}

// ---- ID3v2 ------------------------------------------------------------------

const ID3_TITLE: Record<number, string> = { 2: 'TT2', 3: 'TIT2', 4: 'TIT2' };

function syncsafe(buf: Buffer, at: number): number | null {
  if (at + 4 > buf.length) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    if (buf[at + i] & 0x80) return null;
    n = (n << 7) | buf[at + i];
  }
  return n;
}

// Undo unsynchronisation: every 0xFF 0x00 was written for a 0xFF.
function resync(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  let w = 0;
  for (let r = 0; r < bytes.length; r++) {
    out[w++] = bytes[r];
    if (bytes[r] === 0xff && bytes[r + 1] === 0x00) r++;
  }
  return out.subarray(0, w);
}

function id3Text(data: Buffer | null): string | null {
  if (!data?.length) return null;
  const body = data.subarray(1);
  const bom = body.length >= 2 ? (body[0] === 0xff && body[1] === 0xfe ? 'le' : body[0] === 0xfe && body[1] === 0xff ? 'be' : null) : null;
  switch (data[0]) {
    case 0: return body.toString('latin1');
    case 1: return utf16(bom ? body.subarray(2) : body, bom === 'be');
    case 2: return utf16(bom === 'be' ? body.subarray(2) : body, true);
    case 3: return body.toString('utf8');
    default: return null;
  }
}

// A frame's text, past what its flags put in front of it. Null for a frame this
// can't read: compressed or encrypted.
function frameText(data: Buffer, major: number, frameFlags: number, tagFlags: number): Buffer | null {
  if (major === 3) {
    if (frameFlags & 0x00c0) return null;
    return frameFlags & 0x0020 ? data.subarray(1) : data;
  }
  if (major === 4) {
    if (frameFlags & 0x000c) return null;
    // Unsynchronisation covers everything after the frame header, the grouping
    // byte and the data length included.
    let text = frameFlags & 0x0002 || tagFlags & 0x80 ? resync(data) : data;
    if (frameFlags & 0x0040) text = text.subarray(1);
    if (frameFlags & 0x0001) text = text.subarray(4);
    return text;
  }
  return data;
}

// The ID3v2 tag at the head: its first title frame, and where the tag ends.
function id3v2(head: Buffer): { title: string | null; end: number } | null {
  if (!startsWith(head, 0, 'ID3') || head.length < 10) return null;
  const major = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  if (size === null || !ID3_TITLE[major]) return null;
  const end = 10 + size + (major === 4 && flags & 0x10 ? 10 : 0);
  // v2.2 compression never had a defined scheme.
  if (major === 2 && flags & 0x40) return { title: null, end };
  let body = head.subarray(10, Math.min(10 + size, head.length));
  if (major < 4 && flags & 0x80) body = resync(body);
  let pos = 0;
  if (major > 2 && flags & 0x40) {
    const ext = major === 3 ? (body.length >= 4 ? body.readUInt32BE(0) + 4 : null) : syncsafe(body, 0);
    if (ext === null) return { title: null, end };
    pos = ext;
  }
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  while (pos + headerLength <= body.length) {
    const id = body.toString('latin1', pos, pos + idLength);
    // Padding, or the end of the frames.
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const frameSize = major === 2 ? body.readUIntBE(pos + 3, 3) : major === 3 ? body.readUInt32BE(pos + 4) : syncsafe(body, pos + 4);
    if (frameSize === null) break;
    const start = pos + headerLength;
    const stop = start + frameSize;
    // Cut off by the window.
    if (stop > body.length) break;
    if (id === ID3_TITLE[major]) {
      const frameFlags = major === 2 ? 0 : body.readUInt16BE(pos + 8);
      return { title: id3Text(frameText(body.subarray(start, stop), major, frameFlags, flags)), end };
    }
    pos = stop;
  }
  return { title: null, end };
}

// ---- ID3v1 ------------------------------------------------------------------

// The 30-byte title of a `TAG` block, in Latin-1 as TagLib reads it.
function id3v1Title(tail: Buffer): string | null {
  if (tail.length < 128 || !startsWith(tail, tail.length - 128, 'TAG')) return null;
  const at = tail.length - 125;
  return tail.toString('latin1', at, at + 30);
}

// ---- Vorbis comments: FLAC and Ogg -----------------------------------------

// The first TITLE= in a comment block (vendor, count, then length-prefixed
// KEY=value fields). A field the window cut off is not read.
function vorbisTitle(block: Buffer): string | null {
  if (block.length < 4) return null;
  let pos = 4 + block.readUInt32LE(0);
  if (pos + 4 > block.length) return null;
  const count = block.readUInt32LE(pos);
  pos += 4;
  for (let i = 0; i < count && pos + 4 <= block.length; i++) {
    const length = block.readUInt32LE(pos);
    pos += 4;
    if (pos + length > block.length) break;
    if (length >= 6 && block.toString('latin1', pos, pos + 6).toUpperCase() === 'TITLE=') {
      return block.toString('utf8', pos + 6, pos + length);
    }
    pos += length;
  }
  return null;
}

// A FLAC stream's VORBIS_COMMENT block, walking the metadata blocks from `at`
// (0, or past an ID3v2 tag some writers put first).
function flacTitle(buf: Buffer, at: number): string | null {
  if (!startsWith(buf, at, 'fLaC')) return null;
  for (let pos = at + 4; pos + 4 <= buf.length;) {
    const type = buf[pos] & 0x7f;
    const length = buf.readUIntBE(pos + 1, 3);
    if (type === 4) return vorbisTitle(buf.subarray(pos + 4, pos + 4 + length));
    if (buf[pos] & 0x80) break;
    pos += 4 + length;
  }
  return null;
}

// The first packets of the first logical stream, rebuilt from its pages' lacing.
// A packet the window cut off comes back as far as it goes.
function oggPackets(buf: Buffer, max: number): Buffer[] {
  const packets: Buffer[] = [];
  let parts: Buffer[] = [];
  let serial: number | null = null;
  let pos = 0;
  while (packets.length < max && pos + 27 <= buf.length && startsWith(buf, pos, 'OggS')) {
    const segments = buf[pos + 26];
    const page = buf.readUInt32LE(pos + 14);
    serial ??= page;
    let at = pos + 27 + segments;
    for (let i = 0; i < segments && pos + 27 + i < buf.length; i++) {
      const lace = buf[pos + 27 + i];
      if (page === serial) {
        parts.push(buf.subarray(at, at + lace));
        if (lace < 255) {
          packets.push(Buffer.concat(parts));
          parts = [];
        }
      }
      at += lace;
    }
    pos = at;
  }
  if (parts.length && packets.length < max) packets.push(Buffer.concat(parts));
  return packets;
}

// The comment header of Ogg Vorbis (`\x03vorbis`), Opus (`OpusTags`) or FLAC
// (a VORBIS_COMMENT metadata packet).
function oggTitle(buf: Buffer): string | null {
  if (!startsWith(buf, 0, 'OggS')) return null;
  const [first, ...rest] = oggPackets(buf, 16);
  if (!first) return null;
  if (startsWith(first, 0, '\x01vorbis')) return rest[0] && startsWith(rest[0], 0, '\x03vorbis') ? vorbisTitle(rest[0].subarray(7)) : null;
  if (startsWith(first, 0, 'OpusHead')) return rest[0] && startsWith(rest[0], 0, 'OpusTags') ? vorbisTitle(rest[0].subarray(8)) : null;
  if (startsWith(first, 0, '\x7fFLAC')) {
    const comment = rest.find(p => p.length >= 4 && (p[0] & 0x7f) === 4);
    return comment ? vorbisTitle(comment.subarray(4)) : null;
  }
  return null;
}

// ---- MP4 --------------------------------------------------------------------

const NAM = Buffer.from([0xa9, 0x6e, 0x61, 0x6d]); // ©nam

// The `data` atom of a `©nam`: UTF-8 (type 1) or UTF-16BE (type 2).
function mp4Data(atom: Buffer): string | null {
  if (atom.length < 16 || !startsWith(atom, 4, 'data')) return null;
  const size = atom.readUInt32BE(0);
  if (size < 16 || size > atom.length) return null;
  const type = atom.readUInt32BE(8) & 0xffffff;
  if (type === 1) return atom.toString('utf8', 16, size);
  if (type === 2) return utf16(atom.subarray(16, size), true);
  return null;
}

// The `©nam` of the first `ilst` in the window that holds one. The `ilst` is found
// by its type, so its start need not be reachable from the file's first atom (a
// late `moov` starts outside the tail window), and is then read by the atoms' own
// sizes: only a value inside a whole `©nam`/`data` pair of that list counts.
function mp4Title(buf: Buffer): string | null {
  for (let at = buf.indexOf('ilst', 4, 'latin1'); at !== -1; at = buf.indexOf('ilst', at + 4, 'latin1')) {
    const size = buf.readUInt32BE(at - 4);
    if (size < 8) continue;
    const end = Math.min(at - 4 + size, buf.length);
    for (let pos = at + 4; pos + 8 <= end;) {
      const childSize = buf.readUInt32BE(pos);
      if (childSize < 8) break;
      if (buf.subarray(pos + 4, pos + 8).equals(NAM)) {
        const title = mp4Data(buf.subarray(pos + 8, Math.min(pos + childSize, end)));
        if (title !== null) return title;
      }
      pos += childSize;
    }
  }
  return null;
}
