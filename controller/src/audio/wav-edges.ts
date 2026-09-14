// Bake micro edge fades into a rendered voice WAV, in place. A hard clip
// boundary reaches air as a click once the mic-chain compressor's makeup gain
// lifts it. The TAIL fade cannot live in radio.liq: fade.out on a request.queue
// source doesn't know the remaining time and silences the whole clip (#830), so
// both edges are baked at render time, the only place the length is known.
//
// Only canonical PCM WAVs are edited: 16-bit int (format 1) and 32-bit float
// (format 3). Everything else, notably the cloud engine's mp3, is left alone —
// lossy encoders pad both ends, so the click doesn't arise.

import { readFile, writeFile } from 'node:fs/promises';

const RIFF = 0x46464952; // "RIFF" LE
const WAVE = 0x45564157; // "WAVE" LE

type Fmt = { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number };

// Walk the RIFF chunks for `fmt ` + `data`. Returns null on anything that
// isn't a plain little-endian WAV.
function parseWav(buf: Buffer): { fmt: Fmt; dataStart: number; dataLen: number } | null {
  if (buf.length < 44) return null;
  if (buf.readUInt32LE(0) !== RIFF || buf.readUInt32LE(8) !== WAVE) return null;
  let fmt: Fmt | null = null;
  let dataStart = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 8 + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      dataStart = off + 8;
      // A streaming writer may leave the size field stale — trust the file.
      dataLen = Math.min(size, buf.length - dataStart);
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || dataStart < 0 || dataLen <= 0) return null;
  return { fmt, dataStart, dataLen };
}

// Linear ramp over the first and last `ms` of the data chunk. Mutates `buf`.
// Returns false when the format isn't one we can safely edit.
function rampInPlace(buf: Buffer, fmt: Fmt, dataStart: number, dataLen: number, ms: number): boolean {
  const bytesPerSample = fmt.bitsPerSample / 8;
  const int16 = fmt.audioFormat === 1 && fmt.bitsPerSample === 16;
  const float32 = fmt.audioFormat === 3 && fmt.bitsPerSample === 32;
  if (!int16 && !float32) return false;
  if (!fmt.channels || !fmt.sampleRate) return false;

  const frameBytes = bytesPerSample * fmt.channels;
  const totalFrames = Math.floor(dataLen / frameBytes);
  const fadeFrames = Math.min(Math.floor((fmt.sampleRate * ms) / 1000), Math.floor(totalFrames / 2));
  if (fadeFrames <= 0) return true; // nothing to do on a tiny clip

  const scale = (frame: number, gain: number) => {
    const base = dataStart + frame * frameBytes;
    for (let ch = 0; ch < fmt.channels; ch++) {
      const at = base + ch * bytesPerSample;
      if (int16) buf.writeInt16LE(Math.round(buf.readInt16LE(at) * gain), at);
      else buf.writeFloatLE(buf.readFloatLE(at) * gain, at);
    }
  };
  for (let i = 0; i < fadeFrames; i++) {
    const gain = i / fadeFrames;
    scale(i, gain);                    // head: 0 → 1
    scale(totalFrames - 1 - i, gain);  // tail: 1 → 0 (mirrored)
  }
  return true;
}

// Best-effort by design: a clip must never fail to air because the edge polish
// couldn't be applied. True when fades were baked, false when left untouched.
export async function applyEdgeFades(filePath: string, ms = 40): Promise<boolean> {
  try {
    const buf = await readFile(filePath);
    const parsed = parseWav(buf);
    if (!parsed) return false;
    if (!rampInPlace(buf, parsed.fmt, parsed.dataStart, parsed.dataLen, ms)) return false;
    await writeFile(filePath, buf);
    return true;
  } catch {
    return false;
  }
}
