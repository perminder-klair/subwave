// Pad silence onto the head and tail of a rendered voice WAV, writing a NEW
// file (the original is never mutated — a ducked fallback may still need it).
//
// This is the padding toolbox for pause-then-talk (issue #551): when a long
// spoken segment is injected into the music timeline as its own item, the head
// silence lets the outgoing song finish fading out before the first word
// lands, and the tail silence gives the clip's own exit crossfade something to
// eat other than the DJ's last word. See broadcast/pause-talk.ts for the
// timing math.
//
// Best-effort by design, exactly like applyEdgeFades: only canonical PCM WAVs
// (16-bit int / 32-bit float) are paddable; anything else (notably the cloud
// engine's mp3 output) returns null so the caller falls back to the ducked
// path. Any parse/IO failure returns null too — a clip must never fail to air
// because padding couldn't be applied.

import { readFile, writeFile } from 'node:fs/promises';
import { parseWav, isEditablePcm } from './wav-riff.js';

// Whole silent frames for `ms` at the file's own rate — floored, never rounded
// up, so padding can only be shorter than requested, never longer.
function silentBytes(ms: number, sampleRate: number, frameBytes: number): number {
  if (ms <= 0) return 0;
  const frames = Math.floor((sampleRate * ms) / 1000);
  return frames * frameBytes;
}

// Returns the path of a NEW padded file, or null when the source isn't a
// canonical PCM WAV (caller then falls back to duck). `destPath` receives the
// padded copy; it should live in the same voice out-dir so the existing
// 1-hour cleanup owns its lifecycle.
export async function padWavSilence(
  srcPath: string,
  destPath: string,
  { headMs, tailMs }: { headMs: number; tailMs: number },
): Promise<string | null> {
  try {
    const buf = await readFile(srcPath);
    const parsed = parseWav(buf);
    if (!parsed) return null;
    const { fmt, dataStart, dataLen } = parsed;
    if (!isEditablePcm(fmt)) return null;

    const frameBytes = (fmt.bitsPerSample / 8) * fmt.channels;
    const headBytes = silentBytes(headMs, fmt.sampleRate, frameBytes);
    const tailBytes = silentBytes(tailMs, fmt.sampleRate, frameBytes);
    if (headBytes <= 0 && tailBytes <= 0) return null; // nothing to add

    // Silence is zero frames for both int16 and float32 (0.0 encodes to all
    // zero bytes in IEEE-754 LE), so a zero-filled buffer is valid silence.
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const audio = buf.subarray(dataStart, dataStart + dataLen);

    const newDataLen = headBytes + dataLen + tailBytes;
    const header = Buffer.from(buf.subarray(0, dataStart)); // copy of everything up to the data body

    // Rewrite the two length fields to match the padded body. `data` is now the
    // final chunk (any trailing chunks are dropped), so total file size is
    // dataStart + newDataLen and the RIFF size is that minus the 8-byte header.
    header.writeUInt32LE(newDataLen, dataStart - 4);            // data chunk size
    header.writeUInt32LE(dataStart + newDataLen - 8, 4);        // RIFF chunk size

    await writeFile(destPath, Buffer.concat([header, head, audio, tail]));
    return destPath;
  } catch {
    return null;
  }
}
