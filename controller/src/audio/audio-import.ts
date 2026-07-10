// Shared helpers for operator-imported audio (jingles + sound effects).
//
// Imported files are run through ffmpeg so the library stays uniform with the
// generated assets: jingles become WAV (matching Piper TTS output), effects
// become MP3 (matching ElevenLabs output). ffmpeg also validates the upload —
// it exits non-zero on anything that isn't decodable audio. When ffmpeg is
// absent (a bare-host `npm start` dev box rather than the Docker image, which
// ships ffmpeg) we fall back to storing the raw bytes with their original
// extension so the feature still works; preview routes pick the content type
// off the extension either way.

import { spawn } from 'node:child_process';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Container/codec formats Liquidsoap can decode and we accept on import.
export const ACCEPTED_AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus'] as const;

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

// Lower-cased extension without the dot, or '' if there isn't one.
export function extOf(name: string): string {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return ext;
}

// Filename minus its extension — used as a default jingle label.
export function baseName(name: string): string {
  return path.basename(String(name || ''), path.extname(String(name || ''))).trim();
}

export function isAcceptedAudio(name: string): boolean {
  return (ACCEPTED_AUDIO_EXTS as readonly string[]).includes(extOf(name));
}

// Content type for an audio file path, defaulting to a safe generic.
export function audioContentType(filePath: string): string {
  return CONTENT_TYPES[extOf(filePath)] || 'application/octet-stream';
}

// Cached ffmpeg-availability probe. `null` until first checked.
let ffmpegOk: boolean | null = null;

export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegOk !== null) return ffmpegOk;
  ffmpegOk = await new Promise<boolean>((resolve) => {
    try {
      const proc = spawn('ffmpeg', ['-version']);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return ffmpegOk;
}

// Duration of an audio file in seconds via ffprobe (ships alongside ffmpeg in
// the Docker image). Returns null when ffprobe is missing or the file can't be
// probed — callers treat unknown length as acceptable rather than fail.
export function probeDurationSec(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        const n = parseFloat(out.trim());
        resolve(code === 0 && Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null);
      });
    } catch {
      resolve(null);
    }
  });
}

export type TranscodeFormat = 'wav' | 'mp3';

// ffmpeg's atempo filter only accepts 0.5–2.0 per instance; factors outside
// that range are reached by chaining instances (e.g. 4.0 → atempo=2.0,atempo=2.0).
export function atempoChain(factor: number): string {
  const steps: string[] = [];
  let f = factor;
  while (f > 2.0) { steps.push('atempo=2.0'); f /= 2.0; }
  while (f < 0.5) { steps.push('atempo=0.5'); f /= 0.5; }
  steps.push(`atempo=${f.toFixed(4)}`);
  return steps.join(',');
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().slice(-300)}`));
    });
  });
}

// Transcode an in-memory upload to outPath in the given format. The input is
// written to a temp file (not piped) so seek-dependent containers like m4a/mp4
// decode correctly. `loudnorm` applies EBU R128 levelling — appropriate for
// speech-length jingles, left off for short transient effects where a one-pass
// loudnorm on <2s of audio is unreliable.
export async function transcodeAudio(
  input: Buffer,
  { outPath, format, loudnorm = false, atempo }: { outPath: string; format: TranscodeFormat; loudnorm?: boolean; atempo?: number },
): Promise<void> {
  if (!input?.length) throw new Error('empty audio buffer');
  await mkdir(path.dirname(outPath), { recursive: true });

  const tmp = path.join(tmpdir(), `subwave-import-${crypto.randomBytes(6).toString('hex')}`);
  await writeFile(tmp, input);
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', tmp];
    const filters: string[] = [];
    if (loudnorm) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    if (atempo && Number.isFinite(atempo) && atempo > 0 && atempo !== 1.0) filters.push(atempoChain(atempo));
    if (filters.length) args.push('-af', filters.join(','));
    if (format === 'wav') args.push('-c:a', 'pcm_s16le');
    else args.push('-c:a', 'libmp3lame', '-q:a', '4');
    args.push('-y', outPath);
    await runFfmpeg(args);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
