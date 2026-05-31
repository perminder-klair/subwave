// Piper TTS wrapper — generates a WAV file from text, returns the path.
// Reuses the same setup from your Kaze project.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

await mkdir(config.piper.outDir, { recursive: true });

export async function speak(
  text: string,
  { outPath: customPath, speedScale }: { outPath?: string; speedScale?: number } = {},
): Promise<string> {
  if (!text || !text.trim()) throw new Error('Empty TTS text');

  const id = crypto.randomBytes(6).toString('hex');
  const outPath = customPath || path.join(config.piper.outDir, `${id}.wav`);

  // Make sure the parent dir exists (custom paths might be in a new folder)
  if (customPath) {
    await mkdir(path.dirname(customPath), { recursive: true });
  }

  const args = [
    '--model', config.piper.voice,
    '--config', config.piper.voiceConfig,
    '--output_file', outPath,
  ];
  // Piper expresses speech rate as length_scale — the per-phoneme duration
  // multiplier, where HIGHER is slower. We carry a "speed" multiplier
  // everywhere (lower = slower), so invert it here. The per-call speedScale
  // (daypart energy) composes on top of the configured speed; only passed to
  // Piper when the result differs from 1.0 so unchanged stations behave
  // identically.
  const speed = config.piper.speed * (speedScale != null ? speedScale : 1);
  if (speed && speed > 0 && speed !== 1.0) {
    args.push('--length_scale', String(1 / speed));
  }

  return new Promise((resolve, reject) => {
    const piper = spawn(config.piper.binary, args);

    let stderr = '';
    piper.stderr.on('data', (d) => { stderr += d.toString(); });

    piper.on('error', reject);
    piper.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Piper exited ${code}: ${stderr}`));
      resolve(outPath);
    });

    piper.stdin.write(text);
    piper.stdin.end();
  });
}

// Clean up old voice files (call periodically)
export async function cleanupOldVoices(maxAgeMs = 60 * 60 * 1000) {
  const { readdir, stat, unlink } = await import('node:fs/promises');
  const files = await readdir(config.piper.outDir);
  const now = Date.now();
  for (const f of files) {
    const fp = path.join(config.piper.outDir, f);
    const s = await stat(fp);
    if (now - s.mtimeMs > maxAgeMs) await unlink(fp);
  }
}
