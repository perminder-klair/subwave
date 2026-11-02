// The title a file's own tags hold, for the proof that a mapped guess is the
// track (subsonic.ts isRequestedFile). It reads the two windows the caller
// already has, the first and last 64 KiB. Like Navidrome's tag reader (TagLib),
// it picks the format by the file's extension, and it reads that format's title
// field as a whole value. Where it can't be sure it reads the field Navidrome
// read, it says `unsure`, and the track streams.
// - MP3 (mp3, mp2): an ID3v2 tag at the head (`TT2`/`TIT2`, all four text
//   encodings). A present ID3v2 tag is the only source, even with no title in
//   it: Navidrome then titles the file from its name. An APEv2 tag behind it
//   changes nothing, since Navidrome reads the ID3v2 title, so it isn't looked
//   for. Without an ID3v2 tag, an APEv2 tag anywhere in the windows is unsure (it
//   would win, and this doesn't read APE), and otherwise ID3v1 in the last 128
//   bytes is read.
// - FLAC: the VORBIS_COMMENT block's TITLE=. A FLAC with that block ignores an
//   ID3v2 tag in front of it, even when the block holds no TITLE. A FLAC with an
//   ID3v2 tag and no such block is unsure.
// - Ogg Vorbis, Opus and FLAC (ogg, oga, opus): the comment header's TITLE=.
// - MP4 (m4a, m4b, m4p, mp4): the `©nam` data atom of each `ilst` in both
//   windows. Two that disagree are unsure: retagging in place leaves a stale
//   `ilst` in a `free` atom. An ID3v2 tag in front of the file is unsure too,
//   since Navidrome doesn't index such a file.
// - Anything else (WAV, AIFF, WavPack, APE, WMA…) has no title this reads.
// Of several values, the first is the title, as Navidrome reports it: the first
// of a NUL-separated ID3v2 title, the first TITLE=, a `©nam`'s first data atom.
// The same words in another field, in cover art or in the audio are no title.
//
// No step costs more than linear time in the window, whatever the file holds. No
// regex runs on file text but a 3-4 byte frame id. A field longer than
// MAX_TITLE_CHARS is never normalised. The `ilst` search resumes past each list
// it walks, so it takes at most one atom step per 8 bytes of window (_ilstScan
// counts them). Garbage reads as no title: this runs on the push path, where a
// throw would cost the pick.

/**
 * The longest field the comparison normalises. Navidrome cuts the title it
 * reports at 1,024 characters, and NFC folds at most four UTF-16 units of a
 * decomposed character into one, so a longer field could equal it only once
 * trimmed: a title padded with thousands of spaces. That file streams. A server
 * title over this proves nothing either, whatever the server.
 */
export const MAX_TITLE_CHARS = 4096;

export type TitleField = { kind: 'title'; value: string } | { kind: 'none' } | { kind: 'unsure' };

const NONE: TitleField = { kind: 'none' };
const UNSURE: TitleField = { kind: 'unsure' };
const titled = (value: string | null): TitleField => (value === null ? NONE : { kind: 'title', value });

/**
 * Both sides of the comparison: NFC, trimmed, trailing NULs dropped. Linear: a
 * loop from the end, where a `[\s\0]+$` regex backtracks quadratically on a run
 * that doesn't end the string.
 */
export function normalizeTitle(value: string): string {
  const s = value.normalize('NFC');
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === 0 || s[end - 1].trim() === '')) end--;
  return s.slice(0, end).trimStart();
}

/**
 * Does the file's title field hold this title? `none` when there is no title
 * field to compare, or one this can't be sure of. Case counts: the right file
 * holds the title as Navidrome read it from that field, and folding case would
 * only let in a file whose title differs.
 */
export function titleVerdict(field: TitleField, title: string): 'same' | 'other' | 'none' {
  if (field.kind !== 'title') return 'none';
  // Never normalised, so never the title, even if a trim would leave one.
  if (field.value.length > MAX_TITLE_CHARS) return 'other';
  const want = normalizeTitle(title);
  return want && normalizeTitle(field.value) === want ? 'same' : 'other';
}

/**
 * The title field of a file, from its extension and its first window. The last
 * window is read through `readTail` only when the format keeps tags there.
 */
export function fileTitle(ext: string, head: Buffer, readTail: () => Buffer): TitleField {
  try {
    switch (ext.toLowerCase()) {
      case 'mp3': case 'mp2': return mpegTitle(head, readTail);
      case 'flac': return flacFileTitle(head);
      case 'ogg': case 'oga': case 'opus': return titled(oggTitle(head));
      case 'm4a': case 'm4b': case 'm4p': case 'mp4': return mp4FileTitle(head, readTail);
      default: return NONE;
    }
  } catch {
    return NONE;
  }
}

function startsWith(buf: Buffer, at: number, magic: string): boolean {
  return at >= 0 && buf.length >= at + magic.length && buf.toString('latin1', at, at + magic.length) === magic;
}

function utf16(bytes: Buffer, bigEndian: boolean): string {
  const even = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  return (bigEndian ? even.swap16() : even).toString('utf16le');
}

// The first of NUL-separated values, as Navidrome reports a multi-valued field.
function firstValue(text: string): string {
  const nul = text.indexOf('\u0000');
  return nul < 0 ? text : text.slice(0, nul);
}

// ---- MP3 ----------------------------------------------------------------------

const APE = Buffer.from('APETAGEX', 'latin1');

function mpegTitle(head: Buffer, readTail: () => Buffer): TitleField {
  const id3 = id3v2(head);
  if (id3) return id3.field;
  const tail = readTail();
  if (head.includes(APE) || tail.includes(APE)) return UNSURE;
  return titled(id3v1Title(tail));
}

// ---- ID3v2 --------------------------------------------------------------------

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

// A text frame's first value. UTF-16 with no byte order mark is unsure:
// Navidrome reads no title from it.
function id3Text(data: Buffer | null): TitleField {
  if (!data?.length) return NONE;
  const body = data.subarray(1);
  const bom = body.length >= 2 ? (body[0] === 0xff && body[1] === 0xfe ? 'le' : body[0] === 0xfe && body[1] === 0xff ? 'be' : null) : null;
  switch (data[0]) {
    case 0: return titled(firstValue(body.toString('latin1')));
    case 1: return bom ? titled(firstValue(utf16(body.subarray(2), bom === 'be'))) : UNSURE;
    case 2: return titled(firstValue(utf16(bom === 'be' ? body.subarray(2) : body, true)));
    case 3: return titled(firstValue(body.toString('utf8')));
    default: return NONE;
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
// Null when there is no tag there.
function id3v2(head: Buffer): { field: TitleField; end: number } | null {
  if (!startsWith(head, 0, 'ID3') || head.length < 10) return null;
  const major = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  if (size === null || !ID3_TITLE[major]) return null;
  const end = 10 + size + (major === 4 && flags & 0x10 ? 10 : 0);
  // v2.2 compression never had a defined scheme.
  if (major === 2 && flags & 0x40) return { field: NONE, end };
  let body = head.subarray(10, Math.min(10 + size, head.length));
  if (major < 4 && flags & 0x80) body = resync(body);
  let pos = 0;
  if (major > 2 && flags & 0x40) {
    const ext = major === 3 ? (body.length >= 4 ? body.readUInt32BE(0) + 4 : null) : syncsafe(body, 0);
    if (ext === null) return { field: NONE, end };
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
      return { field: id3Text(frameText(body.subarray(start, stop), major, frameFlags, flags)), end };
    }
    pos = stop;
  }
  return { field: NONE, end };
}

// ---- ID3v1 --------------------------------------------------------------------

// The 30-byte title of a `TAG` block, in Latin-1 and up to its first NUL, as
// TagLib reads it.
function id3v1Title(tail: Buffer): string | null {
  if (tail.length < 128 || !startsWith(tail, tail.length - 128, 'TAG')) return null;
  const at = tail.length - 125;
  return firstValue(tail.toString('latin1', at, at + 30));
}

// ---- Vorbis comments: FLAC and Ogg -----------------------------------------------

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

// A FLAC stream from `at` (0, or past an ID3v2 tag): its VORBIS_COMMENT block,
// `absent` when the metadata ends without one, `unseen` when the walk leaves the
// window first (a PICTURE block ahead of it).
function flacComments(buf: Buffer, at: number): Buffer | 'absent' | 'unseen' {
  for (let pos = at + 4; pos + 4 <= buf.length;) {
    const type = buf[pos] & 0x7f;
    const length = buf.readUIntBE(pos + 1, 3);
    if (type === 4) return buf.subarray(pos + 4, pos + 4 + length);
    if (buf[pos] & 0x80) return 'absent';
    pos += 4 + length;
  }
  return 'unseen';
}

function flacFileTitle(head: Buffer): TitleField {
  const id3 = id3v2(head);
  const at = id3 ? id3.end : 0;
  if (!startsWith(head, at, 'fLaC')) return NONE;
  const comments = flacComments(head, at);
  if (comments === 'absent') return id3 ? UNSURE : NONE;
  if (comments === 'unseen') return NONE;
  return titled(vorbisTitle(comments));
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

// ---- MP4 ------------------------------------------------------------------------

const NAM = Buffer.from([0xa9, 0x6e, 0x61, 0x6d]); // ©nam

// The first `data` atom of a `©nam`: UTF-8 (type 1) or UTF-16BE (type 2).
function mp4Data(atom: Buffer): string | null {
  if (atom.length < 16 || !startsWith(atom, 4, 'data')) return null;
  const size = atom.readUInt32BE(0);
  if (size < 16 || size > atom.length) return null;
  const type = atom.readUInt32BE(8) & 0xffffff;
  if (type === 1) return atom.toString('utf8', 16, size);
  if (type === 2) return utf16(atom.subarray(16, size), true);
  return null;
}

/**
 * Every `©nam` of every `ilst` in the window, and the atom steps it took. An
 * `ilst` is found by its type, so its start need not be reachable from the
 * file's first atom (a late `moov` starts outside the tail window), then read by
 * the atoms' own sizes: only a value inside a whole `©nam`/`data` pair counts.
 * The search resumes past the end of each list it walks, so no atom is walked
 * twice and the steps stay under one per 8 bytes. Exported for the tests.
 */
export function _ilstScan(buf: Buffer): { names: string[]; steps: number } {
  const names: string[] = [];
  let steps = 0;
  for (let at = buf.indexOf('ilst', 4, 'latin1'); at !== -1;) {
    const size = buf.readUInt32BE(at - 4);
    let next = at + 4;
    if (size >= 8) {
      const end = Math.min(at - 4 + size, buf.length);
      for (let pos = at + 4; pos + 8 <= end;) {
        steps++;
        const childSize = buf.readUInt32BE(pos);
        if (childSize < 8) break;
        if (buf.subarray(pos + 4, pos + 8).equals(NAM)) {
          const name = mp4Data(buf.subarray(pos + 8, Math.min(pos + childSize, end)));
          if (name !== null) names.push(name);
        }
        pos += childSize;
      }
      next = Math.max(next, end);
    }
    at = buf.indexOf('ilst', next, 'latin1');
  }
  return { names, steps };
}

function mp4FileTitle(head: Buffer, readTail: () => Buffer): TitleField {
  if (startsWith(head, 0, 'ID3')) return UNSURE;
  if (!startsWith(head, 4, 'ftyp')) return NONE;
  const tail = readTail();
  const names = [..._ilstScan(head).names, ...(tail === head ? [] : _ilstScan(tail).names)];
  if (!names.length) return NONE;
  return names.every(n => n === names[0]) ? titled(names[0]) : UNSURE;
}
