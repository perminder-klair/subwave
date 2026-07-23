// ElevenLabs Music client. A bed is an instrumental the DJ talks over BETWEEN
// songs, so — unlike an sfx stinger (sound-generation, ≤22s) — it needs ≥30s of
// musical audio. That's a different ElevenLabs endpoint: the Music API
// (/v1/music), where `force_instrumental` guarantees no vocals and
// `music_length_ms` sets the length. Same credential as the sfx generator and
// cloud TTS (audio/elevenlabs.ts).

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { elevenLabsKey } from './elevenlabs.js';

// mp3 to match the rest of the library; 44.1kHz is the broadcast source rate.
const ENDPOINT = 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128';

// Ceiling on a generated bed. A bed is trimmed per-link (liq_cue_out), so a clip
// longer than the DJ's longest script is never heard in full — past ~2 min it
// only burns Music credits. The floor lives in broadcast/beds.ts
// (MIN_DURATION_SEC); the caller clamps to [floor, this] before calling.
export const BED_GEN_MAX_SEC = 120;

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
