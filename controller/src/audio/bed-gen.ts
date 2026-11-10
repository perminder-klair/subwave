// ElevenLabs Music client. A bed is an instrumental the DJ talks over between
// songs, so it needs >=30s and a different endpoint from an sfx stinger
// (sound-generation, <=22s): /v1/music, where `force_instrumental` guarantees no
// vocals. Same credential as the sfx generator and cloud TTS.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { elevenLabsKey } from './elevenlabs.js';

// mp3 to match the rest of the library; 44.1kHz is the broadcast source rate.
const ENDPOINT = 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128';

// Ceiling on a generated bed: a bed is trimmed per-link (liq_cue_out), so past
// ~2 min a clip only burns Music credits. Floor is broadcast/beds.ts
// MIN_DURATION_SEC; the caller clamps to [floor, this]. The figure lives in the
// shared imaging schema so the admin form and this module can't disagree.
export { BED_GEN_MAX_SEC } from '../schemas/imaging.js';

// The Music API's own absolute bounds, in ms — a defensive clamp so a bad caller
// can't send an out-of-range length.
const API_MIN_MS = 3_000;
const API_MAX_MS = 600_000;
const DEFAULT_SEC = 45;

// Generate an instrumental bed from a text prompt and write it to outPath (mp3).
// durationSec is the desired length in seconds (defaults to 45); it is converted
// to `music_length_ms` and clamped to the API's bounds. Returns the written path.
export async function generateBed(
  prompt: string,
  { durationSec, outPath }: { durationSec?: number; outPath?: string } = {},
): Promise<string> {
  if (!prompt || !prompt.trim()) throw new Error('Empty bed prompt');
  if (!outPath) throw new Error('generateBed requires an outPath');
  const key = elevenLabsKey();
  if (!key) {
    throw new Error('ElevenLabs API key not configured — set it under cloud TTS, or ELEVENLABS_API_KEY');
  }

  const d = Number(durationSec);
  const sec = Number.isFinite(d) && d > 0 ? d : DEFAULT_SEC;
  const musicLengthMs = Math.min(API_MAX_MS, Math.max(API_MIN_MS, Math.round(sec * 1000)));

  const body = {
    prompt: prompt.trim(),
    model_id: 'music_v1',
    force_instrumental: true,
    music_length_ms: musicLengthMs,
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs music generation failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
  return outPath;
}
