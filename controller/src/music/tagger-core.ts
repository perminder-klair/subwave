// Shared tagging primitives.
// tagOne — one LLM call per track → { moods, energy }, validated against MOOD_VOCAB.
// tagBatch — one LLM call per N tracks → TagResult[], same validation, positional.
// tagOne is used by the inline /library/retag route; tagBatch is used by the
// bulk tag-library.ts script. Both produce identical shapes per track.
//
// TAGGER_CONTRACT_VERSION below is the re-tagging stamp's only prompt-side
// input (#1548) — change what the prompts ASK FOR and you must bump it by hand,
// or already-tagged rows are never re-decided. Full reasoning at the constant.

import { z } from 'zod';
import { moodVocab } from '../settings.js';
import { djObject } from '../llm/sdk.js';
import { songGenres } from './subsonic.js';

export const TagSchema = z.object({
  moods: z.array(z.string()).default([]),
  energy: z.string().nullable().default(null),
});

export const BatchTagSchema = z.object({
  results: z.array(TagSchema),
});

// ===========================================================================
//  BUMP TAGGER_CONTRACT_VERSION WHEN YOU CHANGE WHAT THE PROMPTS BELOW ASK FOR
// ===========================================================================
//
// `promptVocabHash(TAGGER_CONTRACT_VERSION)` (music/embeddings.ts) is the
// `prompt_hash` stamped on every LLM-tagged row, and `staleTaggedIds`
// (library-db/queries.ts) re-tags every row whose stamp differs on --upgrade /
// admin Re-scan → Re-decide moods. Since #1548 that stamp keys off this number
// plus the live mood vocabulary — NOT off the prompt text — so a cosmetic
// reword is free and a SEMANTIC change is invisible until you bump this.
//
// Bump it when the prompts start asking for something different:
//   - different mood-selection guidance (the FEELS-not-genre rules, the
//     worked examples that steer them);
//   - a different energy scale, or different values on it;
//   - a different fallback for an untaggable track;
//   - a different result shape or batch cardinality/order rule.
//
// Do NOT bump it for a reword, a typo, a reflow, or transport wording (#1536)
// — those don't change a single tag, and a bump costs a full library re-tag on
// the next Re-decide (~1600 batch calls on a 40k library, usually against a
// slow homelab Ollama box). Editing settings.moods invalidates on its own; the
// vocabulary is already a hash input and needs no bump.
//
//   1  the shipped contract as of #1548 (1-3 moods from the live vocabulary,
//      low|medium|high energy, {"moods":[],"energy":"medium"} when unreadable,
//      batch = exactly one entry per input track in input order)
//
// scripts/tagger-contract-hash.test.ts pins this number and the hash recipe, so
// a change to either shows up as a diff line in review.
export const TAGGER_CONTRACT_VERSION = 1;

// System prompts are FUNCTIONS, not consts: the mood list is operator-editable
// (settings.moods) and read live, so the prompt reflects the current vocabulary
// each call. The re-tagging stamp no longer reads the prompt at all — see
// TAGGER_CONTRACT_VERSION above.
//
// Both prompts describe the RESULT and never the output channel. Which channel
// a tag call actually uses is decided per leg inside djObject (forced `emit`
// tool for ollama/openai-compatible/locca, native structured output for the
// cloud providers, free text on the recovery attempt), and each branch states
// its own rule there. These prompts used to say "Return ONLY a JSON object",
// which was true on one of those three branches: on the forced-tool branch it
// contradicted toolChoice:'required' and gemma-4-12b on llama.cpp burned whole
// generations deciding which to obey, never tagging a single batch (#1536).
// Keep output-channel wording out of here — it cannot be right from here.
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

If you genuinely cannot tell from the title/artist/album, the result is {"moods":[],"energy":"medium"}. Do not invent.`;
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

If you genuinely cannot tell from the title/artist/album for a track, use {"moods":[],"energy":"medium"} for that entry. Do not invent.`;
}

export interface TaggableSong {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  // OpenSubsonic multi-value genres ([{name}] on raw children) alongside the
  // legacy scalar — genreLine() renders whichever is present.
  genres?: Array<string | { name?: string }> | null;
  genre?: string | null;
}

export interface TagResult {
  moods: string[];
  energy: 'low' | 'medium' | 'high' | null;
}

function sanitizeTag(parsed: { moods?: unknown; energy?: unknown }): TagResult {
  const vocab = moodVocab();
  const moods = Array.isArray(parsed.moods)
    ? (parsed.moods as unknown[])
        .filter((m): m is string => typeof m === 'string' && vocab.includes(m))
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
    `Genre: ${songGenres(song).join(', ') || '?'}`
  );
}

// `leg` pins the call to a specific LLM leg ('primary' | 'fallback') with no
// cross-leg failover — the dual-LLM tagger runs one consumer per leg and manages
// failover itself (discussion #320). Omitted → normal primary→fallback path.
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

  const parsed = await djObject({
    system: taggerSystem(),
    prompt: userPrompt,
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
