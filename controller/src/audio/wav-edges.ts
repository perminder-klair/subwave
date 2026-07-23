// Bake micro edge fades into a rendered voice WAV, in place.
//
// Some TTS engines cut the file hard at the clip boundary; once the broadcast
// mic-chain compressor's makeup gain lifts the clip, that hard edge lands on
// air as an audible click. The head fade also exists in radio.liq (fade.in on
// the voice queues), but the TAIL fade cannot live there: fade.out on a
// request.queue source doesn't know the track's remaining time in this
// Liquidsoap build and silences the entire clip (the 2026-07-04 silent-DJ
// incident, PR #830). So both edges are baked into the file at render time —
// the only place the clip's true length is known.
//
// Only canonical PCM WAVs are edited: 16-bit int (format 1) and 32-bit float
// (format 3). Anything else — notably the cloud engine's mp3 output — is left
// untouched: lossy encoders pad the stream with silence at both ends, so the
// hard-edge click doesn't arise there.

import { readFile, writeFile } from 'node:fs/promises';
import { parseWav, type Fmt } from './wav-riff.js';

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

// Public entry point — best-effort by design: a voice clip must never fail to
// air because the edge polish couldn't be applied. Returns true when fades
// were baked, false when the file was left untouched.
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
