// Shared tagging primitives.
// tagOne — one LLM call per track → { moods, energy }, validated against MOOD_VOCAB.
// tagBatch — one LLM call per N tracks → TagResult[], same validation, positional.
// tagOne is used by the inline /library/retag route; tagBatch is used by the
// bulk tag-library.ts script. Both produce identical shapes per track.

import { z } from 'zod';
import { SHOW_MOODS as MOOD_VOCAB } from '../settings.js';
import { djObject } from '../llm/sdk.js';

export const TagSchema = z.object({
  moods: z.array(z.string()).default([]),
  energy: z.string().nullable().default(null),
});

export const BatchTagSchema = z.object({
  results: z.array(TagSchema),
});

export const TAGGER_SYSTEM = `You tag music tracks with mood and energy for a personal radio station.

For each track, output ONLY a JSON object:
{
  "moods": [1-3 strings, each from this exact list: ${MOOD_VOCAB.join(', ')}],
  "energy": "low" | "medium" | "high"
}

Choose moods that reflect how the track FEELS to listen to, not just its genre.
A spiritual Punjabi devotional is "spiritual" and "reflective" — not "cultural".
A high-BPM dance track is "energetic" and "workout" — not "celebratory" unless it sounds festive.
A slow rainy-day instrumental is "calm" and "rainy" — not "evening" just because it's chill.

If you genuinely cannot tell from the title/artist/album, return {"moods":[],"energy":"medium"}. Do not invent.`;

export const TAGGER_BATCH_SYSTEM = `You tag music tracks with mood and energy for a personal radio station.

You will be given a numbered list of tracks. Return ONLY a JSON object of the form:
{
  "results": [
    { "moods": [...], "energy": "low" | "medium" | "high" },
    ...
  ]
}

The results array MUST have exactly one entry per input track, in the same order as the numbered list. Entry 1 in results corresponds to track 1, entry 2 to track 2, and so on.

For each entry:
- moods: 1-3 strings, each from this exact list: ${MOOD_VOCAB.join(', ')}
- energy: "low" | "medium" | "high"

Choose moods that reflect how the track FEELS to listen to, not just its genre.
A spiritual Punjabi devotional is "spiritual" and "reflective" — not "cultural".
A high-BPM dance track is "energetic" and "workout" — not "celebratory" unless it sounds festive.
A slow rainy-day instrumental is "calm" and "rainy" — not "evening" just because it's chill.

If you genuinely cannot tell from the title/artist/album for a track, return {"moods":[],"energy":"medium"} for that entry. Do not invent.`;

export interface TaggableSong {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  genre?: string | null;
}

export interface TagResult {
  moods: string[];
  energy: 'low' | 'medium' | 'high' | null;
}

function sanitizeTag(parsed: { moods?: unknown; energy?: unknown }): TagResult {
  const moods = Array.isArray(parsed.moods)
    ? (parsed.moods as unknown[])
        .filter((m): m is string => typeof m === 'string' && MOOD_VOCAB.includes(m))
        .slice(0, 3)
    : [];
  const energy = ['low', 'medium', 'high'].includes(parsed.energy as string)
    ? (parsed.energy as 'low' | 'medium' | 'high')
    : null;
  return { moods, energy };
}

function formatSong(song: TaggableSong): string {
  return (
    `Title: ${song.title || '?'} | ` +
    `Artist: ${song.artist || '?'} | ` +
    `Album: ${song.album || '?'} | ` +
    `Year: ${song.year || '?'} | ` +
    `Genre: ${song.genre || '?'}`
  );
}

export async function tagOne(song: TaggableSong): Promise<TagResult> {
  const userPrompt =
    `Title: ${song.title}\n` +
    `Artist: ${song.artist || '?'}\n` +
    `Album: ${song.album || '?'}\n` +
    `Year: ${song.year || '?'}\n` +
    `Genre: ${song.genre || '?'}`;

  const parsed = await djObject({
    system: TAGGER_SYSTEM,
    prompt: userPrompt,
    schema: TagSchema,
    temperature: 0.2,
    kind: 'tag-library',
  });
  return sanitizeTag(parsed);
}

export async function tagBatch(songs: TaggableSong[]): Promise<TagResult[]> {
  if (songs.length === 0) return [];
  const lines = songs.map((s, i) => `${i + 1}. ${formatSong(s)}`).join('\n');
  const userPrompt =
    `Tag these ${songs.length} tracks. Return one entry per track in the same order.\n\n${lines}`;

  const parsed = await djObject({
    system: TAGGER_BATCH_SYSTEM,
    prompt: userPrompt,
    schema: BatchTagSchema,
    temperature: 0.2,
    kind: 'tag-library-batch',
  });
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  if (results.length !== songs.length) {
    throw new Error(`batch length mismatch: expected ${songs.length}, got ${results.length}`);
  }
  return results.map(r => sanitizeTag(r));
}
