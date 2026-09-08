// Shared preamble for the TTS engines' speak(): validate the text, ensure the
// output dir, mint a random id, resolve the WAV path (honouring a caller
// `outPath`). Shared by kokoro/chatterbox/pocket-tts so the id scheme and the
// custom-parent-dir step can't drift. The `id` is the worker request key.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

export interface TtsOutOpts {
  outDir?: string;
  ext?: string;
  prefix?: string;
}

export async function resolveTtsOutPath(
  text: string,
  customPath: string | undefined,
  { outDir = config.piper.outDir, ext = 'wav', prefix = '' }: TtsOutOpts = {},
): Promise<{ id: string; outPath: string }> {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  await mkdir(outDir, { recursive: true });

  const id = crypto.randomBytes(6).toString('hex');
  const outPath = customPath || path.join(outDir, `${prefix}${id}.${ext}`);
  if (customPath) await mkdir(path.dirname(customPath), { recursive: true });

  return { id, outPath };
}
