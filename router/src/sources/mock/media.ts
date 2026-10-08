// Generated media: a per-song WAV tone for `stream`, a per-id gradient PNG for
// `getCoverArt`, and deterministic fake lyrics. Everything is derived from the
// id hash so the same song always sounds and looks the same.

import zlib from 'node:zlib';
import { fnv1a } from '../../util.js';
import type { Song } from '../../sdk/types.js';

const SR = 44100;

// A 16-bit mono PCM WAV: a soft pentatonic arpeggio with a per-song base note
// and tempo, faded out over the last 2.5s (which gives the acoustic analyzer a
// real "fade ending" to find). Range requests are not honoured — generated
// audio has no seekable bytes — so the response is always the whole file.
export function wavLength(song: Song): number {
  return 44 + Math.max(5, Math.round(song.duration ?? 0)) * SR * 2;
}

export async function* songWav(song: Song): AsyncIterable<Uint8Array> {
  const seconds = Math.max(5, Math.round(song.duration ?? 0));
  const totalSamples = seconds * SR;
  const dataBytes = totalSamples * 2;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  yield header;

  const h = fnv1a(`tone:${song.id}`);
  const PENTA = [0, 3, 5, 7, 10];
  const base = 220 * Math.pow(2, PENTA[h % 5]! / 12) * ((h >>> 4) % 2 ? 0.5 : 1);
  const bpm = 72 + ((h >>> 8) % 64);
  const beat = 60 / bpm;
  const PATTERNS = [
    [1, 1.5, 1, 2],
    [1, 1.25, 1.5, 1.25],
    [1, 2, 1.5, 1.25],
    [1, 1, 1.5, 0.75],
  ];
  const pattern = PATTERNS[(h >>> 14) % PATTERNS.length]!;

  let phase = 0;
  let n = 0;
  for (let sec = 0; sec < seconds; sec++) {
    const samples = Math.min(SR, totalSamples - sec * SR);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++, n++) {
      const t = n / SR;
      const beatIdx = Math.floor(t / beat);
      const tInBeat = t - beatIdx * beat;
      const freq = base * pattern[beatIdx % pattern.length]!;
      phase += (2 * Math.PI * freq) / SR;
      const pulse = 0.5 + 0.5 * Math.exp(-3 * (tInBeat / beat));
      let env = 1;
      if (t < 0.3) env = t / 0.3;
      const tail = seconds - t;
      if (tail < 2.5) env = Math.min(env, tail / 2.5);
      const v = (Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase)) / 1.42;
      const sample = Math.max(-1, Math.min(1, v * pulse * env * 0.32));
      buf.writeInt16LE(Math.round(sample * 32767), i * 2);
    }
    yield buf;
  }
}

// --- PNG cover art -------------------------------------------------------------

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Two-tone vertical gradient with a faint ring — enough to tell covers apart
// at a glance in the player. Truecolor 8-bit PNG built by hand (no image dep).
export function coverPng(id: string, sizeParam?: number): Buffer {
  const size = Math.max(16, Math.min(512, Math.floor(sizeParam || 300)));
  const h = fnv1a(`cover:${id}`);
  const [r1, g1, b1] = hslToRgb(h % 360, 0.55, 0.45);
  const [r2, g2, b2] = hslToRgb((h >>> 9) % 360, 0.6, 0.18);

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.32;
  const ringWidth = Math.max(1, size * 0.02);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    const f = size === 1 ? 0 : y / (size - 1);
    for (let x = 0; x < size; x++) {
      let r = r1 + (r2 - r1) * f;
      let g = g1 + (g2 - g1) * f;
      let b = b1 + (b2 - b1) * f;
      if (Math.abs(Math.hypot(x - cx, y - cy) - radius) < ringWidth) {
        r = Math.min(255, r + 80);
        g = Math.min(255, g + 80);
        b = Math.min(255, b + 80);
      }
      const o = row + 1 + x * 3;
      raw[o] = r | 0;
      raw[o + 1] = g | 0;
      raw[o + 2] = b | 0;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- lyrics --------------------------------------------------------------------

const LYRIC_OPEN = ['Under the', 'Past the', 'Beyond the', 'Beneath the'];
const LYRIC_MID = ['we were waiting', 'the signal carried on', 'the city kept its distance', 'nothing needed saying'];
const LYRIC_CLOSE = ['and the night held still', 'until the static cleared', 'while the tape ran out', 'as the lights came home'];

// Roughly a third of tracks have lyrics; the rest return an empty lyricsList,
// matching a real library where most rips carry no embedded lyrics.
export function lyricsFor(song: Song): string[] | null {
  const h = fnv1a(`lyr:${song.id}`);
  if (h % 3 !== 0) return null;
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const o = LYRIC_OPEN[(h >>> (i * 2)) % LYRIC_OPEN.length]!;
    const m = LYRIC_MID[(h >>> (i * 3 + 1)) % LYRIC_MID.length]!;
    lines.push(`${o} ${song.title.toLowerCase()}, ${m}`);
  }
  lines.push(LYRIC_CLOSE[h % LYRIC_CLOSE.length]!);
  return lines;
}
