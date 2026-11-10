// A definition-time baseline for the same raw stream representation the mixer
// will later prepare. Matching this baseline is not proof the original was complete.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as subsonic from './subsonic.js';

const MAX_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

export async function verifyTrack(id: string, expectedDuration: number | null, options: { signal?: AbortSignal; onPcm?: (chunk: Buffer) => void } = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'sub-flow-verify-'));
  const path = join(dir, 'audio');
  try {
    let response: Response;
    try { response = await fetch(subsonic.getRawStreamUrl(id), { signal }); }
    catch { throw new Error('Could not download the track from the music server'); }
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.ok || !response.body || /json|xml|text\//.test(type)) throw new Error('The music server did not return audio');
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_BYTES) return callback(new Error('Track exceeds the verification size limit'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    try { await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal }); }
    catch { throw new Error(size > MAX_BYTES ? 'Track exceeds the verification size limit' : 'The track download did not complete'); }
    if (size < 4096) throw new Error('The downloaded track is too small to verify');
    const duration = await new Promise<number>((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-map', '0:a:0', '-f', 's16le', '-ac', '2', '-ar', '44100', '-'], { timeout: TIMEOUT_MS, signal });
      let bytes = 0;
      proc.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        try { options.onPcm?.(chunk); }
        catch (error) { proc.kill(); reject(error); }
      });
      proc.stderr.resume();
      proc.once('error', () => reject(new Error('Audio verification could not start')));
      proc.once('close', code => code === 0 && bytes > 0 ? resolve(bytes / (44100 * 4)) : reject(new Error('The downloaded track could not be fully decoded')));
    });
    if (expectedDuration != null && Math.abs(duration - expectedDuration) > 2) {
      throw new Error('Decoded duration differs from the library duration by more than two seconds');
    }
    return { sha256: hash.digest('hex'), decodedSeconds: duration, bytes: size };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
