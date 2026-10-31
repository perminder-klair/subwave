// Audition the decoded source seam, not the station's Liquidsoap playback path.
// Keep at most ten seconds per side; decode fully to avoid trusting tag durations
// or approximate compressed-audio seeking when locating the end of a track.
import { verifyTrack } from './sub-flow-verify.js';

const SAMPLE_RATE = 44100;
const FRAME_BYTES = 4; // 16-bit stereo
const SIDE_BYTES = 10 * SAMPLE_RATE * FRAME_BYTES;

export async function renderJoin(tracks: { id: string; duration: number | null }[], signal: AbortSignal): Promise<Buffer> {
  const sides: Buffer[] = [];
  for (const [index, track] of tracks.entries()) {
    let pcm = Buffer.alloc(0);
    await verifyTrack(track.id, track.duration, { signal, onPcm: chunk => {
      if (index === 0) {
        const joined = Buffer.concat([pcm, chunk]);
        pcm = Buffer.from(joined.subarray(Math.max(0, joined.length - SIDE_BYTES)));
      } else if (pcm.length < SIDE_BYTES) {
        pcm = Buffer.concat([pcm, chunk.subarray(0, SIDE_BYTES - pcm.length)]);
      }
    } });
    sides.push(pcm);
  }
  signal.throwIfAborted();
  const pcm = Buffer.concat(sides);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * FRAME_BYTES, 28);
  header.writeUInt16LE(FRAME_BYTES, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
