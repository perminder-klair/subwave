// Minimal little-endian RIFF/WAVE parser, shared by the voice-clip editors
// (wav-edges.ts bakes edge fades; wav-pad.ts pads silence for pause-then-talk).
// Both only touch canonical PCM WAVs — 16-bit int (format 1) and 32-bit float
// (format 3); anything else (notably the cloud engine's mp3 output) is left to
// the caller to skip. Kept tiny and dependency-free so the "best-effort, never
// block airing" philosophy of its callers holds.

export const RIFF = 0x46464952; // "RIFF" LE
export const WAVE = 0x45564157; // "WAVE" LE

export type Fmt = { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number };

export type ParsedWav = { fmt: Fmt; dataStart: number; dataLen: number };

// Walk the RIFF chunks for `fmt ` + `data`. Returns null on anything that
// isn't a plain little-endian WAV.
export function parseWav(buf: Buffer): ParsedWav | null {
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

// True for the two formats the editors can safely rewrite sample-by-sample.
export function isEditablePcm(fmt: Fmt): boolean {
  const int16 = fmt.audioFormat === 1 && fmt.bitsPerSample === 16;
  const float32 = fmt.audioFormat === 3 && fmt.bitsPerSample === 32;
  return (int16 || float32) && !!fmt.channels && !!fmt.sampleRate;
}
