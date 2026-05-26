// Text-embedding layer for the library tagger.
//
// Wraps the AI SDK embedMany call so the rest of the tagger can stay provider-
// agnostic. Provider + model are resolved via llm/provider.ts → tracks the
// existing settings.llm by default (Ollama local) or settings.embedding when
// the operator wants something different.
//
// The track-text formatter lives here too because it's the single canonical
// string-shape that drives every embedding. Seeds, propagation, future
// similarity queries — all use formatTrackText so the same input always
// produces the same vector.

import { embedMany } from 'ai';
import {
  embeddingModel,
  activeEmbeddingModelLabel,
  activeEmbeddingDim,
  embeddingEnabled,
} from '../llm/provider.js';
import { SHOW_MOODS as MOOD_VOCAB } from '../settings.js';
import crypto from 'node:crypto';

const LYRIC_EXCERPT_CHARS = 400; // cap lyrics before they bloat the embedding text

export interface SongMeta {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  genre?: string | null;
}

export interface TrackEnrichment {
  lastfmTags?: string[] | null;
  lyricExcerpt?: string | null;
}

export function isAvailable(): boolean {
  if (!embeddingEnabled()) return false;
  try {
    embeddingModel();
    return true;
  } catch {
    return false;
  }
}

export function activeModelLabel(): string {
  return activeEmbeddingModelLabel();
}

// Used by library.ts on first open — we need the schema dim before any
// embedding call.
export function resolveEmbeddingDim(): number {
  return activeEmbeddingDim();
}

// Canonical text shape. Single function so seed + propagation + future
// similarity queries all produce the same vector for the same input.
//
// Without enrichment:
//   "Snoop Dogg — Slid Off · Missionary (2024) [Hip-Hop]"
//
// With enrichment (the v1 default when both signals exist):
//   "Snoop Dogg — Slid Off · Missionary (2024) [Hip-Hop]
//    Last.fm: chill, west-coast, smooth, late-night
//    Lyrics: I slid off, ain't been the same since the call dropped..."
export function formatTrackText(song: SongMeta, enrich?: TrackEnrichment | null): string {
  const head =
    `${song.artist || 'Unknown Artist'} — ${song.title || 'Unknown Title'} ` +
    `· ${song.album || 'Unknown Album'} (${song.year ?? '?'}) [${song.genre || '?'}]`;
  const lines = [head];
  if (enrich?.lastfmTags && enrich.lastfmTags.length) {
    lines.push(`Last.fm: ${enrich.lastfmTags.join(', ')}`);
  }
  if (enrich?.lyricExcerpt) {
    const trimmed = enrich.lyricExcerpt.slice(0, LYRIC_EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
    if (trimmed) lines.push(`Lyrics: ${trimmed}`);
  }
  return lines.join('\n');
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = embeddingModel();
  const { embeddings } = await embedMany({ model, values: texts });
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(
      `embedMany returned ${embeddings?.length ?? 'no'} vectors for ${texts.length} texts`,
    );
  }
  return embeddings as number[][];
}

// The mood vocabulary is part of the LLM tagger's prompt; including its hash
// in promptHash means a vocab change auto-invalidates older tags via the
// --upgrade path.
export function promptVocabHash(systemPrompt: string): string {
  return crypto
    .createHash('sha256')
    .update(systemPrompt)
    .update('|')
    .update(MOOD_VOCAB.join(','))
    .digest('hex')
    .slice(0, 16);
}
