// Piper TTS wrapper — generates a WAV file from text, returns the path.
// Reuses the same setup from your Kaze project.

import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

await mkdir(config.piper.outDir, { recursive: true });

// Resolve a persona's per-persona Piper voice to a concrete .onnx + manifest
// pair. `voice` is a bare filename (no path separators) the operator dropped
// into the shared voice folder (config.voices.dir), e.g. `en_US-amy-medium.onnx`
// alongside its `en_US-amy-medium.onnx.json` manifest — exactly the layout Piper
// (and Home Assistant) ship voices in (issue #230). The legacy chatterbox dir is
// scanned too for parity with the .wav voices, `dir` winning on clash. If the
// pair isn't found (or no voice was requested), fall back to the baked-in
// default so the DJ never goes silent.
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
  const files = await readdir(config.piper.outDir);
  const now = Date.now();
  for (const f of files) {
    const fp = path.join(config.piper.outDir, f);
    const s = await stat(fp);
    if (now - s.mtimeMs > maxAgeMs) await unlink(fp);
  }
}

// List the custom Piper voices the operator has dropped into the shared voice
// folder — a voice counts only when BOTH the `.onnx` model and its `.onnx.json`
// manifest are present (a model without a manifest can't be synthesised, so we
// never offer it). Mirrors chatterbox.listReferenceVoices(): scans the canonical
// dir plus the legacy chatterbox dir, deduped (canonical wins), sorted. Used by
// the admin UI to populate the per-persona Piper voice dropdown (issue #230).
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
