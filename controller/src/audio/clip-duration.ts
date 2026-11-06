// Measured file duration only: no text estimate or broadcast padding.
import {readFileSync,openSync,readSync,closeSync,statSync} from 'node:fs';
import {isUtf8} from 'node:buffer';
import {mpegLayer3Frame,mp3FrameOffset} from './mp3-frames.js';

export function measuredClipDurationMs(path:string):number|null {
  return wavDurationMs(path)??mp3DurationMs(path);
}

// Keep trailer parsing bounded, but size alone is never evidence of metadata.
const MP3_TRAILER_MAX_BYTES = 4096;

function hasValidMp3Trailer(buf: Buffer, off: number): boolean {
  let end = buf.length;
  if (end - off > MP3_TRAILER_MAX_BYTES) return false;
  // ID3v1/1.1 has no length field: its signature and fixed 128-byte extent
  // must occupy the end of the file, with no junk between it and the audio.
  if (end - off >= 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  if (end === off) return true;
  if (end - off < 32) return false;

  const footer = end - 32;
  if (buf.toString('latin1', footer, footer + 8) !== 'APETAGEX') return false;
  const version = buf.readUInt32LE(footer + 8);
  const size = buf.readUInt32LE(footer + 12);
  const count = buf.readUInt32LE(footer + 16);
  const flags = buf.readUInt32LE(footer + 20);
  if ((version !== 1000 && version !== 2000) || size < 32 || size > end - off
      || (flags !== 0 && flags !== 0x80000000)
      || (version === 1000 && flags !== 0)
      || buf.subarray(footer + 24, end).some(byte => byte !== 0)) return false;

  // APE's size includes the footer and items, but excludes its optional
  // header. Both records must agree, and every item must fit before the footer.
  let item = end - size;
  if (flags === 0x80000000) {
    if (item - 32 !== off
        || !buf.subarray(off, off + 20).equals(buf.subarray(footer, footer + 20))
        || buf.readUInt32LE(off + 20) !== 0xa0000000
        || buf.subarray(off + 24, off + 32).some(byte => byte !== 0)) return false;
  } else if (item !== off) return false;
  const keys = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (item + 8 > footer) return false;
    const valueSize = buf.readUInt32LE(item);
    const itemFlags = buf.readUInt32LE(item + 4);
    if ((itemFlags & ~7) !== 0 || (itemFlags & 6) === 6) return false;
    item += 8;
    const keyEnd = buf.indexOf(0, item);
    if (keyEnd < item || keyEnd >= footer) return false;
    const key = buf.toString('latin1', item, keyEnd);
    if (!/^[\x20-\x7e]{2,255}$/.test(key) || ['OggS', 'TAG', 'ID3', 'MP+'].includes(key)) return false;
    const folded = key.toLowerCase();
    if (keys.has(folded)) return false;
    keys.add(folded);
    const valueStart = keyEnd + 1;
    item = valueStart + valueSize;
    if (item > footer || ((itemFlags & 6) !== 2 && !isUtf8(buf.subarray(valueStart, item)))) return false;
  }
  return item === footer;
}

// Duration of an mp3 clip (ElevenLabs, Fish, openai-compatible) without
// decoding it: walk the frame headers and add up what each frame holds. That
// stays exact on variable bitrate, where file size over bitrate can come out
// seconds short, and short is the direction that lets the next line talk over
// this one. Returns null, so the caller falls back to the estimate, for
// anything that is not Layer III or that the walk cannot follow to the end.
function mp3DurationMs(path: string): number | null {
  try {
    const buf = readFileSync(path);
    let off = mp3FrameOffset(buf);
    if (off == null) return null;
    let seconds = 0;
    let frames = 0;
    for (let frame = mpegLayer3Frame(buf, off); frame && off + frame.length <= buf.length; frame = mpegLayer3Frame(buf, off)) {
      seconds += frame.seconds;
      frames += 1;
      off += frame.length;
    }
    if (frames < 2 || !hasValidMp3Trailer(buf, off)) return null;
    return Math.ceil(seconds * 1000);
  } catch {
    return null;
  }
}

// Duration from a WAV header (byteRate from `fmt `, byte count from `data`).
// Returns null for non-WAV or anything it can't parse, so the caller tries the
// mp3 reader and then the word-count estimate. Reads only the first 4KB —
// headers are tiny.
export function wavDurationMs(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 12 || head.toString('ascii', 0, 4) !== 'RIFF'
        || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let byteRate = 0;
    let dataSize = 0;
    let off = 12;
    while (off + 8 <= n) {
      const id = head.toString('ascii', off, off + 4);
      const size = head.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        byteRate = head.readUInt32LE(off + 8 + 8);   // fmt body offset 8 → byteRate
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      off += 8 + size + (size % 2);   // chunks are word-aligned
    }
    if (!byteRate) return null;
    // Streamed WAVs sometimes write a bogus/placeholder data size — fall back
    // to the real file size minus the header we walked.
    if (!dataSize || dataSize > 0x7fffffff) {
      dataSize = Math.max(0, statSync(path).size - (off + 8));
    }
    if (!dataSize) return null;
    return Math.ceil((dataSize / byteRate) * 1000);
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}
