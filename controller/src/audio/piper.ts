// Piper TTS wrapper: generates a WAV file from text, returns the path.

import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

await mkdir(config.piper.outDir, { recursive: true });

// Resolve a persona's Piper voice to a concrete .onnx + manifest pair. `voice`
// is a bare filename in the shared voice folder, e.g. `en_US-amy-medium.onnx`
// beside its `.onnx.json` manifest (#230). The legacy chatterbox dir is scanned
// too, `dir` winning on clash. No pair found (or no voice requested) falls back
// to the baked-in default so the DJ never goes silent.
function resolvePiperVoice(voice?: string): { model: string; configPath: string } {
  const fallback = { model: config.piper.voice, configPath: config.piper.voiceConfig };
  if (!voice || path.isAbsolute(voice) || voice.includes('/') || voice.includes('\\')) {
    return fallback;
  }
  for (const dir of [config.voices.dir, config.voices.legacyDir]) {
    const model = path.join(dir, voice);
    const configPath = `${model}.json`;
    if (existsSync(model) && existsSync(configPath)) return { model, configPath };
  }
  console.warn(`[piper] voice "${voice}" not found in voice dir — using built-in default`);
  return fallback;
}

export async function speak(
  text: string,
  { outPath: customPath, voice, speedScale }: { outPath?: string; voice?: string; speedScale?: number } = {},
): Promise<string> {
  if (!text || !text.trim()) throw new Error('Empty TTS text');

  const id = crypto.randomBytes(6).toString('hex');
  const outPath = customPath || path.join(config.piper.outDir, `${id}.wav`);

  // Make sure the parent dir exists (custom paths might be in a new folder)
  if (customPath) {
    await mkdir(path.dirname(customPath), { recursive: true });
  }

  const { model, configPath } = resolvePiperVoice(voice);
  const args = [
    '--model', model,
    '--config', configPath,
    '--output_file', outPath,
  ];
  // Piper's length_scale is a per-phoneme duration multiplier where HIGHER is
  // slower; our "speed" multiplier is the inverse, so invert here. Passed only
  // when the result differs from 1.0.
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

// Clean up old voice files (call periodically). Per-file try/catch: a WAV
// removed concurrently between readdir and stat (ENOENT) must not abort the
// sweep and leave the rest of the stale files unreaped until the next hour.
export async function cleanupOldVoices(maxAgeMs = 60 * 60 * 1000) {
  const files = await readdir(config.piper.outDir);
  const now = Date.now();
  for (const f of files) {
    const fp = path.join(config.piper.outDir, f);
    try {
      const s = await stat(fp);
      if (now - s.mtimeMs > maxAgeMs) await unlink(fp);
    } catch {}
  }
}

// Custom Piper voices in the shared voice folder, for the admin dropdown
// (#230). A voice counts only when BOTH the `.onnx` and its `.onnx.json`
// manifest are present, since a model without a manifest can't be synthesised.
// Like chatterbox.listReferenceVoices(): canonical dir plus legacy dir, deduped
// (canonical wins), sorted.
async function readPiperOnnx(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    const present = new Set(entries);
    return entries.filter(
      (f) => f.toLowerCase().endsWith('.onnx') && present.has(`${f}.json`),
    );
  } catch {
    return [];
  }
}
export async function listPiperVoices(): Promise<string[]> {
  const [primary, legacy] = await Promise.all([
    readPiperOnnx(config.voices.dir),
    readPiperOnnx(config.voices.legacyDir),
  ]);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const f of [...primary, ...legacy]) {
    if (seen.has(f)) continue;
    seen.add(f);
    merged.push(f);
  }
  return merged.sort();
}
