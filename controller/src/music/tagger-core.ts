// Shared tagging primitives. tagOne (one call per track, used by /library/retag)
// and tagBatch (one call per N tracks, positional, used by tag-library.ts) both
// yield the same per-track shape, validated against the live mood vocabulary.

import { z } from 'zod';
import { moodVocab } from '../settings.js';
import { djObject } from '../llm/sdk.js';
import { songGenres } from './subsonic.js';
import type { TaggerAcoustics } from './sound-line.js';
import { formatEvidence } from './tagger-evidence.js';

export const TagSchema = z.object({
  moods: z.array(z.string()).default([]),
  energy: z.string().nullable().default(null),
});

export const BatchTagSchema = z.object({
  results: z.array(TagSchema),
});

// BUMP THIS when you change what the prompts below ASK FOR (mood guidance,
// energy scale, untaggable fallback, result shape, batch order). The re-tagging
// stamp keys off this number plus the live vocabulary, never the prompt text
// (#1548): a semantic change is invisible without a bump, a reword costs a full
// library re-tag with one.
//   1  title/artist/album/year/genre only
//   2  + the Sound:/Last.fm: evidence line, which outranks album reputation (#2281)
export const TAGGER_CONTRACT_VERSION = 2;

// How the prompts read the evidence line (formatEvidence). Shared so the two
// prompts can't drift on what outranks what.
function evidenceGuidance(): string {
  return `Some tracks carry an evidence line. "Sound:" was measured from that track's own audio: its tempo (a tempo marked "or half-time" may have been read at twice the pulse you hear), its key mode, and whether it is sung or instrumental. "Last.fm:" is what listeners tag the song or its artist with. This is evidence about the track, and it outranks what you know of the album or artist: a slow minor-key song is not "high" energy because the album around it is loud.`;
}

// Functions, not consts: the mood list is operator-editable and read live.
// Both prompts describe the RESULT and never the output channel — djObject picks
// the channel per leg, so channel wording here contradicts it (#1536).
export function taggerSystem(): string {
  return `You tag music tracks with mood and energy for a personal radio station.

For each track, the required result has this shape:
{
  "moods": [1-3 strings, each from this exact list: ${moodVocab().join(', ')}],
  "energy": "low" | "medium" | "high"
}

Choose moods that reflect how the track FEELS to listen to, not just its genre.
A spiritual Punjabi devotional is "spiritual" and "reflective" — not "cultural".
A high-BPM dance track is "energetic" and "workout" — not "celebratory" unless it sounds festive.
A slow rainy-day instrumental is "calm" and "rainy" — not "evening" just because it's chill.

${evidenceGuidance()}

If there is no evidence line and you genuinely cannot tell from the title/artist/album, the result is {"moods":[],"energy":"medium"}. Do not invent.`;
}

export function taggerBatchSystem(): string {
  return `You tag music tracks with mood and energy for a personal radio station.

You will be given a numbered list of tracks. The required result has this shape:
{
  "results": [
    { "moods": [...], "energy": "low" | "medium" | "high" },
    ...
  ]
}

The results array MUST have exactly one entry per input track, in the same order as the numbered list. Entry 1 in results corresponds to track 1, entry 2 to track 2, and so on.

For each entry:
- moods: 1-3 strings, each from this exact list: ${moodVocab().join(', ')}
- energy: "low" | "medium" | "high"

Choose moods that reflect how the track FEELS to listen to, not just its genre.
A spiritual Punjabi devotional is "spiritual" and "reflective" — not "cultural".
A high-BPM dance track is "energetic" and "workout" — not "celebratory" unless it sounds festive.
A slow rainy-day instrumental is "calm" and "rainy" — not "evening" just because it's chill.

${evidenceGuidance()}

If a track has no evidence line and you genuinely cannot tell from the title/artist/album, use {"moods":[],"energy":"medium"} for that entry. Do not invent.`;
}

export interface TaggableSong {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  // OpenSubsonic multi-value genres alongside the legacy scalar.
  genres?: Array<string | { name?: string }> | null;
  genre?: string | null;
  // The measured evidence (#2281): the row's acoustics through taggerAcoustics,
  // which carries tempo, key and vocal evidence and nothing else, and its stored
  // Last.fm tags. Absent or empty adds no line: the track is tagged from its
  // metadata alone, blind.
  acoustics?: TaggerAcoustics | null;
  lastfmTags?: string[] | null;
}

export interface TagResult {
  moods: string[];
  energy: 'low' | 'medium' | 'high' | null;
  // True when the model named moods and none were in the vocabulary, so an
  // empty `moods` was a miss rather than its "can't tell" answer (#2283).
  offVocab?: boolean;
}

export function sanitizeTag(parsed: { moods?: unknown; energy?: unknown }): TagResult {
  const vocab = moodVocab();
  const named = Array.isArray(parsed.moods)
    ? (parsed.moods as unknown[]).filter((m): m is string => typeof m === 'string' && m.trim() !== '')
    : [];
  const moods = named.filter(m => vocab.includes(m)).slice(0, 3);
  const energy = ['low', 'medium', 'high'].includes(parsed.energy as string)
    ? (parsed.energy as 'low' | 'medium' | 'high')
    : null;
  return named.length > 0 && moods.length === 0 ? { moods, energy, offVocab: true } : { moods, energy };
}

// One numbered entry: the metadata line, then the evidence line indented under
// it when there is one.
function formatSong(song: TaggableSong): string {
  const head =
    `Title: ${song.title || '?'} | ` +
    `Artist: ${song.artist || '?'} | ` +
    `Album: ${song.album || '?'} | ` +
    `Year: ${song.year || '?'} | ` +
    `Genre: ${songGenres(song).join(', ') || '?'}`;
  const { sound, lastfm } = formatEvidence(song);
  const evidence = [sound, lastfm].filter(Boolean).join(' | ');
  return evidence ? `${head}\n   ${evidence}` : head;
}

// `leg` pins the call to one LLM leg with no cross-leg failover: the dual-LLM
// tagger runs a consumer per leg and manages failover itself. Omitted = normal
// primary then fallback.
export interface TagOpts {
  leg?: 'primary' | 'fallback';
}

export async function tagOne(song: TaggableSong, opts: TagOpts = {}): Promise<TagResult> {
  const userPrompt =
    `Title: ${song.title}\n` +
    `Artist: ${song.artist || '?'}\n` +
    `Album: ${song.album || '?'}\n` +
    `Year: ${song.year || '?'}\n` +
    `Genre: ${songGenres(song).join(', ') || '?'}`;
  const { sound, lastfm } = formatEvidence(song);
  const evidence = [sound, lastfm].filter(Boolean).join('\n');

  const parsed = await djObject({
    system: taggerSystem(),
    prompt: evidence ? `${userPrompt}\n${evidence}` : userPrompt,
    schema: TagSchema,
    temperature: 0.2,
    kind: 'tag-library',
    leg: opts.leg,
  });
  return sanitizeTag(parsed);
}

export async function tagBatch(songs: TaggableSong[], opts: TagOpts = {}): Promise<TagResult[]> {
  if (songs.length === 0) return [];
  const lines = songs.map((s, i) => `${i + 1}. ${formatSong(s)}`).join('\n');
  const userPrompt =
    `Tag these ${songs.length} tracks. Return one entry per track in the same order.\n\n${lines}`;

  const parsed = await djObject({
    system: taggerBatchSystem(),
    prompt: userPrompt,
    schema: BatchTagSchema,
    temperature: 0.2,
    kind: 'tag-library-batch',
    leg: opts.leg,
  });
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  if (results.length !== songs.length) {
    throw new Error(`batch length mismatch: expected ${songs.length}, got ${results.length}`);
  }
  return results.map(r => sanitizeTag(r));
}
