// Shared preamble for the TTS engines' speak() functions: validate the text,
// make sure the output dir exists, mint a random id, and resolve the WAV path
// (honouring a caller-supplied `outPath`). The kokoro / chatterbox / pocket-tts
// engines each open with this exact sequence; centralising it keeps the id
// scheme and the "ensure custom parent dir" step from drifting between them.
//
// Returns both the `id` (engines pass it as the worker request key) and the
// resolved `outPath`. Parameterised for the pieces that legitimately vary
// (output dir, extension, filename prefix) even though today all three callers
// take the defaults.

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
