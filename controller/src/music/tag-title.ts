// The title a file's tags give it, as stock Navidrome (0.64) reports it over the
// Subsonic API, for the proof that a mapped guess is the track (subsonic.ts
// isRequestedFile). It reads the two windows the caller already has, the first
// and last 64 KiB, and follows what Navidrome does with a file: its tag reader
// (TagLib) picks the format by the file's extension and reads one tag of it as
// whole values; Navidrome takes the first value that isn't empty under the keys
// it maps to the title, and cuts it at 1,024 bytes; and the Subsonic API appends
// the subtitle when there is one, `Title (Subtitle)`, or `Title [Live]` when the
// subtitle brings its own brackets. Where this knows TagLib or Navidrome reads a
// tag another way, it says `unsure`, and the track streams.
// - MP3 (mp3, mp2): an ID3v2.2-2.4 tag at the head: `TIT2` (`TT2`), `TIT3`
//   (`TT3`), and `TXXX` frames described `TITLE` or `SUBTITLE`, which join them in
//   frame order, in all four text encodings.
//   A present ID3v2 tag is the only source, even with no title in it: Navidrome
//   then titles the file from its name, or, for a tag with no frames at all,
//   reads the ID3v1 or APE title behind it, and this streams that file. Unsure:
//   another major version, a 2.3 extended header (TagLib finds no frames past
//   it), a `TXXX` whose description is another of Navidrome's title keys, and a
//   title or subtitle frame that is compressed, encrypted, grouped or carries a
//   data length, which TagLib reads differently. Without an ID3v2 tag, an APEv2
//   tag anywhere in the windows is unsure (it would win, and this doesn't read
//   APE), and otherwise ID3v1 in the last 128 bytes is read.
// - FLAC: the first VORBIS_COMMENT block, over any ID3v2 tag in front of it, even
//   when the block holds no title. A FLAC with an ID3v2 tag and no such block is
//   unsure.
// - Ogg Vorbis, Opus and FLAC (ogg, oga, opus): the comment header.
//   Comment keys are matched as TagLib upper-cases them, so `title=` counts, and
//   `TIT2=`, `TIT3=`, `INAM=` and `WM/SUBTITLE=` count where Navidrome counts them.
// - MP4 (m4a, m4b, m4p, mp4): the `©nam` item and an iTunes `SUBTITLE` item of the
//   first `moov/udta/meta/ilst`, by atom path, as TagLib reads them: only `data`
//   atoms of type 1, version 0 (UTF-8), and the first of two `©nam` items.
//   TagLib parses every atom in file order, and Navidrome doesn't index a file it
//   can't parse, so every atom up to the end of that `ilst` has to lie in a window
//   and be sound. Unsure: anything else on the way, an ID3v2 tag in front of the
//   file, another item whose name Navidrome lower-cases into one of its title or
//   subtitle keys (`TIT2`, `inam`, `©NAM`, a freeform `TITLE`), a `©nam` or
//   freeform item with a 64-bit size, and a `data` atom TagLib reads its own way:
//   under 16 bytes, of 2^31 or more, or running past its item.
// - Anything else (WAV, AIFF, WavPack, APE, WMA…) has no title this reads.
// Each value is read up to its first NUL, as TagLib reads it, and Navidrome drops
// empty values, so the title is the first that isn't. A title or subtitle value
// that isn't text (bytes that aren't UTF-8, a lone UTF-16 surrogate) is unsure,
// even after a valid one: Navidrome's TagLib replaces the bad bytes, and this
// doesn't try to match how. Within one ID3 frame nothing after its first value
// that isn't empty is decoded, since Navidrome never reports it. The same words in
// another field, in cover art or in the audio are no title.
// Two shapes this can't see still let a wrong file of the right size and title
// play, the only ones known: a subtitle, or another of Navidrome's title keys,
// past the windows behind a title that matches (a title past them streams), and
// an MP4 with a broken atom after its `ilst`, which Navidrome doesn't index.
//
// Every walk is linear in the window, whatever the file holds: no regex runs on
// file text but a 3-4 byte frame id, the trims are loops, and the MP4 walk visits
// each header once (_mp4Steps counts them). The one step that isn't is NFC, which is
// quadratic in a run of combining marks; the 1,024-byte cut bounds it, at the
// cost measured in docs/internals/music.md. Garbage reads as no title: this runs
// on the push path, where a throw would cost the pick.

import { isUtf8 } from 'node:buffer';

/** Navidrome's cut on every tag value it stores, in UTF-8 bytes (`defaultMaxTagLength`). */
export const MAX_TAG_BYTES = 1024;

/**
 * The longest title Navidrome's Subsonic API can report: a cut title, then a cut
 * subtitle in brackets. A server title longer than this proves nothing, and is
 * never normalised.
 */
export const MAX_REPORTED_TITLE_BYTES = 2 * MAX_TAG_BYTES + 3;

/**
 * `value` is the title as Navidrome reports it. `plain` is the title without the
 * subtitle the API appended, when there is one: a server that doesn't append it
 * (Navidrome with `Subsonic.AppendSubtitle` off, or another server) reports that.
 */
export type TitleField = { kind: 'title'; value: string; plain?: string } | { kind: 'none' } | { kind: 'unsure' };

const NONE: TitleField = { kind: 'none' };
const UNSURE: TitleField = { kind: 'unsure' };

// Text TagLib decodes with replacement characters: bytes that aren't UTF-8, or a
// lone UTF-16 surrogate. Navidrome then reports U+FFFD, which this doesn't try to
// match, so under a title or subtitle key it is unsure (reported()). A NUL, which
// no value read here holds: each is cut at its first.
const INVALID = '\u0000';

/**
 * Both sides of the comparison: NFC, trimmed, trailing NULs dropped. The trim is
 * a loop from the end, where a `[\s\0]+$` regex backtracks quadratically on a run
 * that doesn't end the string.
 */
export function normalizeTitle(value: string): string {
  const s = value.normalize('NFC');
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === 0 || s[end - 1].trim() === '')) end--;
  return s.slice(0, end).trimStart();
}

/**
 * Does the file's title, as Navidrome reports it, equal this title? `none` when
 * there is none, or none this can be sure of, which includes a file that matches
 * only without its subtitle. Case counts: the right file holds the title as
 * Navidrome read it, and folding case would only let in a file whose title differs.
 */
export function titleVerdict(field: TitleField, title: string): 'same' | 'other' | 'none' {
  if (field.kind !== 'title') return 'none';
  const want = normalizeTitle(title);
  if (want && normalizeTitle(field.value) === want) return 'same';
  if (want && field.plain !== undefined && normalizeTitle(field.plain) === want) return 'none';
  return 'other';
}

/**
 * The title of a file, from its extension and its first window. The last window
 * is read through `readTail` only when the format keeps tags there. `size` is the
 * file's length, where the tail window ends.
 */
export function fileTitle(ext: string, head: Buffer, readTail: () => Buffer, size = head.length): TitleField {
  try {
    switch (ext.toLowerCase()) {
      case 'mp3': case 'mp2': return mpegTitle(head, readTail);
      case 'flac': return flacFileTitle(head);
      case 'ogg': case 'oga': case 'opus': return oggTitle(head);
      case 'm4a': case 'm4b': case 'm4p': case 'mp4': return mp4FileTitle(head, readTail, size);
      default: return NONE;
    }
  } catch {
    return NONE;
  }
}

// ---- What Navidrome makes of TagLib's keys ------------------------------------

// The keys Navidrome reads, in its mappings' order (resources/mappings.yaml).
const TITLE_KEYS = ['tit2', 'title', '©nam', 'inam'];
const SUBTITLE_KEYS = ['tit3', 'subtitle', '----:com.apple.itunes:subtitle', 'wm/subtitle'];
const NAVIDROME_KEYS = new Set([...TITLE_KEYS, ...SUBTITLE_KEYS]);

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

// Go's strings.ToLower over the keys met here: ASCII, plus the two characters whose
// lower case is ASCII (`İ` and the Kelvin sign).
function goLower(key: string): string {
  if (isAscii(key)) return key.toLowerCase();
  let out = '';
  for (const c of key) out += c === 'İ' ? 'i' : c === 'K' ? 'k' : c >= 'A' && c <= 'Z' ? c.toLowerCase() : c;
  return out;
}

// TagLib's String::upper(): ASCII letters only.
function asciiUpper(key: string): string {
  if (isAscii(key)) return key.toUpperCase();
  let out = '';
  for (const c of key) out += c >= 'a' && c <= 'z' ? c.toUpperCase() : c;
  return out;
}

// Go's strings.TrimSpace (unicode.IsSpace).
const GO_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
function goTrimSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && GO_SPACE.has(s.charCodeAt(start))) start++;
  while (end > start && GO_SPACE.has(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/** Navidrome's cut: the first 1,024 bytes of the value's UTF-8, never half a character. */
export function cutTag(value: string): string {
  if (value.length * 3 <= MAX_TAG_BYTES) return value;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= MAX_TAG_BYTES) return value;
  let end = MAX_TAG_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.toString('utf8', 0, end);
}

// The Subsonic API's appendSuffix: brackets the subtitle unless it already opens
// and closes with a pair. Go compares the bytes through a map whose missing key
// reads as 0, so a subtitle ending in a NUL counts as bracketed too.
const BRACKETS: Record<number, number> = { 0x28: 0x29, 0x5b: 0x5d, 0x7b: 0x7d, 0x3c: 0x3e };
function withSubtitle(title: string, subtitle: string): string {
  const s = goTrimSpace(subtitle);
  const b = Buffer.from(s, 'utf8');
  return b.length >= 2 && (BRACKETS[b[0]] ?? 0) === b[b.length - 1] ? `${title} ${s}` : `${title} (${s})`;
}

/**
 * The title Navidrome reports for a file whose tag TagLib reads as these keys and
 * values, in TagLib's order: the first value that isn't empty under its title
 * keys, cut, with the subtitle's appended the same way. Navidrome lower-cases
 * the keys into one map, so two that lower alike leave it one at random: unsure.
 */
function reported(props: Map<string, string[]>): TitleField {
  const lowered = new Map<string, string[]>();
  for (const [key, values] of props) {
    const k = goLower(key);
    if (NAVIDROME_KEYS.has(k) && (lowered.has(k) || values.includes(INVALID))) return UNSURE;
    lowered.set(k, values);
  }
  const first = (keys: string[]) => {
    for (const k of keys) for (const v of lowered.get(k) ?? []) if (v !== '') return v;
    return null;
  };
  const title = first(TITLE_KEYS);
  // Navidrome titles the file from its name.
  if (title === null) return NONE;
  const plain = cutTag(title);
  const subtitle = first(SUBTITLE_KEYS);
  return subtitle === null ? { kind: 'title', value: plain } : { kind: 'title', value: withSubtitle(plain, cutTag(subtitle)), plain };
}

function add(props: Map<string, string[]>, key: string, values: string[]) {
  const list = props.get(key);
  if (list) list.push(...values);
  else props.set(key, [...values]);
}

// ---- Bytes ----------------------------------------------------------------------

function startsWith(buf: Buffer, at: number, magic: string): boolean {
  return at >= 0 && buf.length >= at + magic.length && buf.toString('latin1', at, at + magic.length) === magic;
}

// TagLib's String: up to the first NUL.
function upToNul(s: string): string {
  const nul = s.indexOf('\u0000');
  return nul < 0 ? s : s.slice(0, nul);
}

// A UTF-8 value up to its first NUL, or INVALID.
function utf8(bytes: Buffer): string {
  return isUtf8(bytes) ? upToNul(bytes.toString('utf8')) : INVALID;
}

// A UTF-16 value up to its first NUL, or INVALID for a surrogate without its pair.
function utf16(bytes: Buffer, bigEndian: boolean): string {
  const even = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
  const s = (bigEndian ? even.swap16() : even).toString('utf16le');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    const next = s.charCodeAt(i + 1);
    if (c > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return INVALID;
    i++;
  }
  return upToNul(s);
}

// ---- MP3 ----------------------------------------------------------------------

const APE = Buffer.from('APETAGEX', 'latin1');

function mpegTitle(head: Buffer, readTail: () => Buffer): TitleField {
  const id3 = id3v2(head);
  if (id3) return id3.field;
  const tail = readTail();
  if (head.includes(APE) || tail.includes(APE)) return UNSURE;
  return id3v1(tail);
}

// ---- ID3v2 --------------------------------------------------------------------

// The frames read here by their 2.3/2.4 id; TagLib renames 2.2's the same way.
const V22: Record<string, string> = { TT2: 'TIT2', TT3: 'TIT3', TXX: 'TXXX' };

function syncsafe(buf: Buffer, at: number): number | null {
  if (at + 4 > buf.length) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    if (buf[at + i] & 0x80) return null;
    n = (n << 7) | buf[at + i];
  }
  return n;
}

// TagLib's SynchData::toUInt: a size that isn't syncsafe is read as a plain one.
function syncsafeOrPlain(buf: Buffer, at: number): number | null {
  if (at + 4 > buf.length) return null;
  return syncsafe(buf, at) ?? buf.readUInt32BE(at);
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

// A text frame's values as TagLib's TextIdentificationFrame splits them: trailing
// NULs dropped, split on the encoding's NUL at its alignment, empty pieces skipped
// (a TXXX keeps its first, the description), each piece decoded alone. A UTF-16
// piece without a byte order mark takes the first piece's, and the first piece
// without one reads as empty. Null for an encoding TagLib doesn't define.
// Only what Navidrome can report is decoded: the split stops at the frame's first
// value that isn't empty, since every value after it comes after it in TagLib's
// list too, and at a TXXX's description unless that is `TITLE` or `SUBTITLE`.
// Empty values aren't returned: Navidrome drops them.
function id3Values(data: Buffer, txxx: boolean): string[] | null {
  if (data.length < 2) return [];
  const encoding = data[0];
  if (encoding > 3) return null;
  const align = encoding === 0 || encoding === 3 ? 1 : 2;
  let length = data.length - 1;
  while (length > 0 && data[length] === 0) length--;
  while (length % align !== 0) length++;
  const body = data.subarray(1, 1 + length);
  const values: string[] = [];
  let index = 0;
  let firstBom = 0;
  // Decodes one piece; true when the split can stop.
  const take = (from: number, to: number): boolean => {
    const first = index++ === 0;
    const description = first && txxx;
    if (to === from && !description) return false;
    const piece = body.subarray(from, to);
    let value: string;
    if (encoding === 0) value = upToNul(piece.toString('latin1'));
    else if (encoding === 3) value = utf8(piece);
    else if (encoding === 2) value = utf16(piece, true);
    else {
      const bom = piece.length >= 2 ? piece.readUInt16BE(0) : 0;
      if (first) firstBom = bom;
      if (bom === 0xfeff || bom === 0xfffe) value = utf16(piece.subarray(2), bom === 0xfeff);
      else if (!first && (firstBom === 0xfeff || firstBom === 0xfffe)) value = utf16(piece, firstBom === 0xfeff);
      else value = '';
    }
    if (description) {
      values.push(value);
      const key = asciiUpper(value);
      return key !== 'TITLE' && key !== 'SUBTITLE';
    }
    if (value === '') return false;
    values.push(value);
    return true;
  };
  let from = 0;
  for (let at = 0; at + align <= body.length; at += align) {
    if (body[at] === 0 && (align === 1 || body[at + 1] === 0)) {
      if (take(from, at)) return values;
      from = at + align;
    }
  }
  if (from < body.length) take(from, body.length);
  return values;
}

// The ID3v2 tag at the head, read as TagLib reads it, and where it ends. Null when
// TagLib sees no tag there.
function id3v2(head: Buffer): { field: TitleField; end: number } | null {
  if (!startsWith(head, 0, 'ID3') || head.length < 10) return null;
  const major = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  if (size === null || major === 0xff || head[4] === 0xff) return null;
  const end = 10 + size + (major === 4 && flags & 0x10 ? 10 : 0);
  // TagLib parses other versions its own way, and finds no frames past a 2.3
  // extended header, nor a 2.2 compressed tag's.
  if (major < 2 || major > 4 || (major < 4 && flags & 0x40)) return { field: UNSURE, end };
  return { field: id3Frames(head, major, flags, size), end };
}

function id3Frames(head: Buffer, major: number, flags: number, size: number): TitleField {
  const whole = 10 + size <= head.length;
  let body = head.subarray(10, Math.min(10 + size, head.length));
  if (major < 4 && flags & 0x80) body = resync(body);
  let pos = 0;
  if (major === 4 && flags & 0x40) {
    const ext = syncsafeOrPlain(body, 0);
    if (ext === null) return NONE;
    if (ext <= (whole ? body.length : size)) pos = ext;
  }
  // TagLib stops a frame header short of the end: while the position is under the
  // data's length less 10 (the tag header's size, whatever the version), with a
  // footer's 10 bytes taken off first, in unsigned arithmetic. A tag the window cut
  // has an end this can't see: the walk stops at the window's edge instead.
  let length = body.length;
  if (major === 4 && flags & 0x10 && length >= 10) length -= 10;
  const limit = whole ? (length - 10) >>> 0 : Infinity;
  const props = new Map<string, string[]>();
  const headerLength = major === 2 ? 6 : 10;
  while (pos < limit && pos + headerLength <= body.length) {
    // Padding, or the end of the frames.
    if (body[pos] === 0) break;
    let id = body.toString('latin1', pos, pos + (major === 2 ? 3 : 4));
    // iTunes wrote 2.2 ids into 2.3 tags; TagLib reads them as 2.2's.
    if (major === 3 && (id[3] === '\0' || id[3] === ' ')) id = V22[id.slice(0, 3)] ?? id.slice(0, 3);
    else if (major === 2) id = V22[id] ?? id;
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const frameSize = major === 2 ? body.readUIntBE(pos + 3, 3) : major === 3 ? body.readUInt32BE(pos + 4) : syncsafeOrPlain(body, pos + 4)!;
    const frameFlags = major === 2 ? 0 : body.readUInt16BE(pos + 8);
    const start = pos + headerLength;
    const stop = start + frameSize;
    // A frame past the tag's end, or a data length that can't fit, ends TagLib's
    // walk; past the window's edge, the rest is unseen.
    if (stop > body.length) {
      if (whole) break;
      return titleFrom(props, false);
    }
    if (major === 4 && frameFlags & 0x0001 && frameSize < 4) break;
    if (id === 'TIT2' || id === 'TIT3' || id === 'TXXX') {
      const values = frameValues(body.subarray(start, stop), id, major, frameFlags, flags);
      if (values === null) return UNSURE;
      if (id !== 'TXXX') add(props, id === 'TIT2' ? 'TITLE' : 'SUBTITLE', values);
      else if (values.length) {
        // TagLib keys a TXXX by its description, upper-cased: `SUBTITLE` joins
        // TIT3's values in frame order, and Navidrome's other keys would reorder them.
        const key = asciiUpper(values[0]);
        if (key === 'TITLE' || key === 'SUBTITLE') add(props, key, values.slice(1));
        else if (NAVIDROME_KEYS.has(goLower(key))) return UNSURE;
      }
    }
    pos = stop;
  }
  return titleFrom(props, true);
}

// A walk the window cut short has seen part of the frames: a title found is the
// title (later frames only add later values), and none found is none read here.
function titleFrom(props: Map<string, string[]>, complete: boolean): TitleField {
  const field = reported(props);
  return complete || field.kind === 'title' ? field : NONE;
}

// A frame's values, past what its flags put in front of them. Null for a frame
// TagLib reads differently from this: compressed, encrypted (TagLib decompresses
// what it can and skips the rest), grouped (TagLib reads the group byte as the
// text encoding) or with a data length (TagLib cuts the text to it, read its own
// way), and for a text encoding past 3.
function frameValues(data: Buffer, id: string, major: number, frameFlags: number, tagFlags: number): string[] | null {
  if (major === 3 && frameFlags & 0x00e0) return null;
  if (major === 4) {
    if (frameFlags & 0x004d) return null;
    if (frameFlags & 0x0002 || tagFlags & 0x80) data = resync(data);
  }
  return id3Values(data, id === 'TXXX');
}

// ---- ID3v1 --------------------------------------------------------------------

// The 30-byte title of a `TAG` block, as TagLib reads it: Latin-1, up to its first
// NUL, stripped of tabs, line breaks and spaces.
function id3v1(tail: Buffer): TitleField {
  if (tail.length < 128 || !startsWith(tail, tail.length - 128, 'TAG')) return NONE;
  const at = tail.length - 125;
  let title = upToNul(tail.toString('latin1', at, at + 30));
  let start = 0;
  let end = title.length;
  while (start < end && '\t\n\f\r '.includes(title[start])) start++;
  while (end > start && '\t\n\f\r '.includes(title[end - 1])) end--;
  title = title.slice(start, end);
  return reported(new Map([['TITLE', [title]]]));
}

// ---- Vorbis comments: FLAC and Ogg -----------------------------------------------

// A comment block as TagLib's XiphComment reads it: vendor, count, then
// length-prefixed KEY=value fields, each key upper-cased and dropped unless it is
// ASCII 0x20-0x7D without `=`. `length` is the block's whole length, which the
// window may have cut: past the cut, a title is unseen and a subtitle unread.
function vorbisTitle(block: Buffer, length: number): TitleField {
  if (length < 8 || block.length < 4) return NONE;
  let pos = 4 + block.readUInt32LE(0);
  if (pos > length - 4 || pos + 4 > block.length) return NONE;
  const count = block.readUInt32LE(pos);
  pos += 4;
  if (count > 50000 || count > Math.floor((length - 8) / 4)) return NONE;
  const props = new Map<string, string[]>();
  let complete = true;
  for (let i = 0; i < count; i++) {
    if (pos + 4 > block.length) { complete = pos + 4 > length; break; }
    const size = block.readUInt32LE(pos);
    pos += 4;
    if (pos + size > block.length) { complete = pos + size > length; break; }
    const entry = block.subarray(pos, pos + size);
    pos += size;
    const sep = entry.indexOf(0x3d);
    if (sep < 1) continue;
    const key = vorbisKey(entry.subarray(0, sep));
    // Pictures aren't fields, and only Navidrome's title keys matter here.
    if (key && NAVIDROME_KEYS.has(key.toLowerCase())) add(props, key, [utf8(entry.subarray(sep + 1))]);
  }
  return titleFrom(props, complete);
}

// A comment's key as TagLib reads it: UTF-8 up to a NUL, upper-cased, and dropped
// unless every character is ASCII 0x20-0x7D. Plain ASCII skips the decode.
function vorbisKey(bytes: Buffer): string | null {
  let ascii = true;
  for (let i = 0; i < bytes.length && ascii; i++) ascii = bytes[i] >= 0x20 && bytes[i] <= 0x7d;
  const key = ascii ? bytes.toString('latin1') : utf8(bytes);
  if (!key) return null;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c > 0x7d || c === 0x3d) return null;
  }
  // ASCII by now, so this is TagLib's String::upper().
  return key.toUpperCase();
}

// A FLAC stream from `at` (0, or past an ID3v2 tag): its first VORBIS_COMMENT
// block, `absent` when the metadata ends without one, `unseen` when the walk leaves
// the window first (a PICTURE block ahead of it).
function flacComments(buf: Buffer, at: number): { block: Buffer; length: number } | 'absent' | 'unseen' {
  for (let pos = at + 4; pos + 4 <= buf.length;) {
    const type = buf[pos] & 0x7f;
    const length = buf.readUIntBE(pos + 1, 3);
    if (type === 4) return { block: buf.subarray(pos + 4, pos + 4 + length), length };
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
  return vorbisTitle(comments.block, comments.length);
}

// The first packets of the first logical stream, rebuilt from its pages' lacing.
// A packet the window cut off comes back as far as it goes, marked unfinished.
function oggPackets(buf: Buffer, max: number): { bytes: Buffer; whole: boolean }[] {
  const packets: { bytes: Buffer; whole: boolean }[] = [];
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
          packets.push({ bytes: Buffer.concat(parts), whole: at + lace <= buf.length });
          parts = [];
        }
      }
      at += lace;
    }
    pos = at;
  }
  if (parts.length && packets.length < max) packets.push({ bytes: Buffer.concat(parts), whole: false });
  return packets;
}

// The comment header of Ogg Vorbis (`\x03vorbis`), Opus (`OpusTags`) or FLAC
// (a VORBIS_COMMENT metadata packet).
function oggTitle(buf: Buffer): TitleField {
  if (!startsWith(buf, 0, 'OggS')) return NONE;
  const [first, ...rest] = oggPackets(buf, 16);
  if (!first) return NONE;
  const comment = (packet: { bytes: Buffer; whole: boolean } | undefined, skip: number) => {
    if (!packet) return NONE;
    const block = packet.bytes.subarray(skip);
    return vorbisTitle(block, packet.whole ? block.length : Infinity);
  };
  if (startsWith(first.bytes, 0, '\x01vorbis')) return rest[0] && startsWith(rest[0].bytes, 0, '\x03vorbis') ? comment(rest[0], 7) : NONE;
  if (startsWith(first.bytes, 0, 'OpusHead')) return rest[0] && startsWith(rest[0].bytes, 0, 'OpusTags') ? comment(rest[0], 8) : NONE;
  if (startsWith(first.bytes, 0, '\x7fFLAC')) return comment(rest.find(p => p.bytes.length >= 4 && (p.bytes[0] & 0x7f) === 4), 4);
  return NONE;
}

// ---- MP4 ------------------------------------------------------------------------

// The atoms TagLib parses children of. `stem` it skips whole.
const CONTAINERS = new Set(['moov', 'udta', 'mdia', 'meta', 'ilst', 'stbl', 'minf', 'moof', 'traf', 'trak', 'stsd']);
const META_CHILDREN = new Set(['hdlr', 'ilst', 'mhdr', 'ctry', 'lang']);
const NAM = '©nam';

// `wide` is a 64-bit size, which TagLib reads past for a container but takes for
// the start of an item's data.
interface Header { name: string; offset: number; length: number; body: number; wide: boolean }
type Stop = 'invalid' | 'unseen';
const PATH = ['moov', 'udta', 'meta', 'ilst'];

/**
 * The items of the first `moov/udta/meta/ilst`, as TagLib's parser reaches them,
 * read from the two windows. TagLib parses every atom in file order, containers
 * to their leaves, so everything ahead of each step of that path is parsed whole
 * here too. `invalid` is an atom TagLib rejects (a size under 8 or past the end of
 * the file), which ends its parse and keeps Navidrome from indexing the file;
 * `unseen` is a header outside both windows; `none` is a file with no such path.
 * The walk stops at the end of that ilst: what follows it can't change the items,
 * only, if broken, whether Navidrome indexes the file. `complete` is false when an
 * item header lay outside the windows. Each atom is visited once.
 */
function mp4Items(at: (offset: number, length: number) => Buffer | null, size: number):
  { result: { items: Header[]; complete: boolean } | Stop | 'none'; steps: number } {
  let steps = 0;
  const header = (pos: number): Header | Stop => {
    steps++;
    const head = at(pos, 8);
    if (!head) return pos + 8 > size ? 'invalid' : 'unseen';
    let length = head.readUInt32BE(0);
    let body = pos + 8;
    const wide = length === 1;
    if (length === 0) length = size - pos;
    else if (wide) {
      const big = at(pos + 8, 8);
      if (!big) return pos + 16 > size ? 'invalid' : 'unseen';
      length = Number(big.readBigUInt64BE(0));
      body = pos + 16;
    }
    if (length < 8 || length > size - pos) return 'invalid';
    const name = head.toString('latin1', 4, 8);
    if (name === 'meta') {
      // Not a full atom when a child's type follows at once.
      const peek = at(body, 8);
      if (!peek) return 'unseen';
      if (!META_CHILDREN.has(peek.toString('latin1', 4, 8))) body += 4;
    } else if (name === 'stsd') {
      body += 8;
    }
    return { name, offset: pos, length, body, wide };
  };
  // An atom parsed whole, children and all; where TagLib goes on from, which for a
  // container is its last child's end, wherever that is.
  const whole = (h: Header, depth: number): number | Stop => {
    if (!CONTAINERS.has(h.name)) return h.offset + h.length;
    if (depth > 64) return 'unseen';
    let pos = h.body;
    while (pos < h.offset + h.length) {
      const child = header(pos);
      if (typeof child === 'string') return child;
      const next = whole(child, depth + 1);
      if (typeof next === 'string') return next;
      pos = next;
    }
    return pos;
  };
  let start = 0;
  let end = size;
  for (const [depth, name] of PATH.entries()) {
    let found: Header | null = null;
    for (let pos = start; depth === 0 ? pos + 8 <= size : pos < end;) {
      const h = header(pos);
      if (typeof h === 'string') return { result: h, steps };
      if (h.name === name) { found = h; break; }
      const next = whole(h, depth);
      if (typeof next === 'string') return { result: next, steps };
      pos = next;
    }
    // No moov: TagLib calls the file invalid. A step missing further down: no tags.
    if (!found) return { result: depth === 0 ? 'invalid' : 'none', steps };
    start = found.body;
    end = found.offset + found.length;
  }
  const items: Header[] = [];
  for (let pos = start; pos < end;) {
    const h = header(pos);
    if (h === 'unseen') return { result: { items, complete: false }, steps };
    if (h === 'invalid') return { result: h, steps };
    items.push(h);
    const next = whole(h, PATH.length);
    if (next === 'unseen') return { result: { items, complete: false }, steps };
    if (next === 'invalid') return { result: next, steps };
    pos = next;
  }
  return { result: { items, complete: true }, steps };
}

// The `data` atoms of an item as TagLib's parseData2 reads them, after `mean` and
// `name` for a freeform one: a type and version word, then the value from byte 16.
// TagLib reads each length as a signed int and cuts the value to the length less
// 16, so a data atom under 16 bytes, of 2^31 or more, or running past its item
// reads its own way there: null, unsure. A short or misnamed `mean` or `name` ends
// the item, as in TagLib, which then drops it.
function mp4Data(item: Buffer, freeform: boolean): { flags: number; value: Buffer }[] | null {
  const out: { flags: number; value: Buffer }[] = [];
  for (let pos = 0, i = 0; pos < item.length; i++) {
    const named = freeform && i < 2;
    if (pos + (named ? 12 : 16) > item.length) return named ? out : null;
    const length = item.readUInt32BE(pos);
    const name = item.toString('latin1', pos + 4, pos + 8);
    const flags = item.readUInt32BE(pos + 8);
    if (named) {
      if (length < 12 || length >= 2 ** 31 || name !== (i === 0 ? 'mean' : 'name')) return out;
      out.push({ flags, value: item.subarray(pos + 12, Math.min(pos + length, item.length)) });
    } else {
      if (length < 16 || length >= 2 ** 31 || pos + length > item.length) return null;
      if (name !== 'data') break;
      out.push({ flags, value: item.subarray(pos + 16, pos + length) });
    }
    pos += length;
  }
  return out;
}

function mp4FileTitle(head: Buffer, readTail: () => Buffer, size: number): TitleField {
  // Navidrome doesn't index an MP4 with an ID3v2 tag in front of it.
  if (startsWith(head, 0, 'ID3')) return UNSURE;
  if (!startsWith(head, 4, 'ftyp')) return NONE;
  let tail: Buffer | null = null;
  const at = (offset: number, length: number): Buffer | null => {
    if (offset < 0 || offset + length > size) return null;
    if (offset + length <= head.length) return head.subarray(offset, offset + length);
    tail ??= readTail();
    const from = size - tail.length;
    return offset >= from ? tail.subarray(offset - from, offset - from + length) : null;
  };
  const { result } = mp4Items(at, size);
  // Navidrome doesn't index a file TagLib can't parse; one with no moov/udta/meta/ilst
  // it titles from its name.
  if (typeof result === 'string') return result === 'none' ? NONE : UNSURE;
  let title: string[] | null = null;
  const subtitles = new Set<string>();
  let subtitle: string[] | null = null;
  let complete = result.complete;
  // False once an item's data lay outside the windows. The atoms after it are
  // still checked by name and size, and a `©nam` or freeform item after it is
  // unsure: the unread one may be a subtitle or title ahead of it, and a freeform
  // item's key is in its data.
  let reading = true;
  for (const item of result.items) {
    // TagLib hands Navidrome any other atom as a key named after it, which Navidrome
    // lower-cases: `TIT2`, `inam`, `©NAM` would be another title or subtitle.
    if (item.name !== NAM && NAVIDROME_KEYS.has(goLower(item.name))) return UNSURE;
    if (item.name !== NAM && item.name !== '----') continue;
    // TagLib reads an item's data from 8 bytes in, so a 64-bit size reads as data.
    if (item.wide) return UNSURE;
    if (!reading) return UNSURE;
    if (item.name === NAM && title) continue;
    const bytes = at(item.body, item.offset + item.length - item.body);
    // Past the windows, like an item header there: a title is unseen, a subtitle unread.
    if (!bytes) { complete = false; reading = false; continue; }
    const data = mp4Data(bytes, item.name === '----');
    if (!data) return UNSURE;
    if (item.name === NAM) {
      // TagLib keeps the first `©nam` with a UTF-8 value; a later one is a duplicate.
      const text = data.filter(d => d.flags === 1);
      if (text.length) title = text.map(d => utf8(d.value));
      continue;
    }
    if (data.length <= 2) continue;
    const mean = utf8(data[0].value);
    const name = utf8(data[1].value);
    // TagLib keys the item by its mean and name, and maps the iTunes ones to a
    // property by name; Navidrome lower-cases both kinds of key. One named after a
    // title key is unsure whatever its mean.
    if (TITLE_KEYS.includes(goLower(name))) return UNSURE;
    const key = mean === 'com.apple.iTunes' ? goLower(name) : null;
    if (!((key !== null && SUBTITLE_KEYS.includes(key)) || goLower(`----:${mean}:${name}`) === '----:com.apple.itunes:subtitle')) continue;
    // TagLib keeps the first item of a key; of two keys, Navidrome keeps one at random.
    const exact = `${mean}:${name}`;
    if (subtitles.has(exact)) continue;
    subtitles.add(exact);
    if (subtitles.size > 1 || data[2].flags !== 1) return UNSURE;
    subtitle = data.slice(2).map(d => utf8(d.value));
  }
  if (!title) return complete ? NONE : UNSURE;
  const props = new Map([['TITLE', title]]);
  if (subtitle) props.set('SUBTITLE', subtitle);
  return reported(props);
}

/** How many headers the MP4 walk reads in `bytes`, as one window. Exported for the tests. */
export function _mp4Steps(bytes: Buffer): number {
  return mp4Items((offset, length) => (offset + length <= bytes.length ? bytes.subarray(offset, offset + length) : null), bytes.length).steps;
}
