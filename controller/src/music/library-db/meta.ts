// Embedding-model metadata: which model produced the stored text vectors, at
// what dimension, and in which text mode. Read on open to decide whether the
// index is still valid for the configured model.

import { requireDb } from './handle.js';

// Whether the vectors were embedded with the model's document prefix
// ('prefixed') or bare ('plain'); null = pre-tracking, equivalent to 'plain'.
type EmbeddingTextMode = 'plain' | 'prefixed';

export function getEmbeddingMeta(): {
  model: string;
  dim: number;
  textMode: EmbeddingTextMode | null;
  textFormat: number | null;
} | null {
  const row = requireDb()
    .prepare('SELECT model, dim, text_mode, text_format FROM embedding_meta WHERE pk = 1')
    .get() as
      | { model: string; dim: number; text_mode: string | null; text_format: number | null }
      | undefined;
  if (!row) return null;
  return {
    model: row.model,
    dim: row.dim,
    textMode: row.text_mode === 'prefixed' || row.text_mode === 'plain' ? row.text_mode : null,
    // NULL (pre-#1246 rows) reads as format 1, the shape every index carried
    // before the Sound line. Not null-as-unknown: an older build's index is a
    // KNOWN shape.
    textFormat: Number.isFinite(row.text_format as number) ? Number(row.text_format) : 1,
  };
}

// `textFormat` is required, not defaulted: a NULL write reads back as format 1,
// so a forgotten arg would regress the recorded shape and re-fire the re-embed
// advisory after a reseed. Resolve it via embeddings.resolveIndexTextFormat.
export function setEmbeddingMeta(
  model: string,
  dim: number,
  textMode: EmbeddingTextMode | null,
  textFormat: number,
): void {
  requireDb()
    .prepare(
      `INSERT INTO embedding_meta (pk, model, dim, set_at, text_mode, text_format)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET model = excluded.model, dim = excluded.dim,
         set_at = excluded.set_at, text_mode = excluded.text_mode,
         text_format = excluded.text_format`,
    )
    .run(model, dim, new Date().toISOString(), textMode, textFormat);
}

// Which CLAP model wrote the current audio vectors. Its own table: the audio and
// text spaces are independent. Null until the first audio vector is written.
export function setAudioEmbeddingMeta(model: string, dim: number): void {
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET model = excluded.model, dim = excluded.dim, set_at = excluded.set_at`,
    )
    .run(model, dim, new Date().toISOString());
}


