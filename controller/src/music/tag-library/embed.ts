// Phase 1 - embedding. Turns each track's metadata and enrichment into the text
// vector the picker's similarity search runs over. See ../tag-library.ts.

import * as db from '../library-db.js';
import * as embeddings from '../embeddings.js';
import * as settings from '../../settings.js';
import { resolveEraYear } from '../show-filter.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';

// The embedding preflight both CLIs run before they embed (#2313): a provider is
// configured, and a real probe answers. The probe's measured dimension beats the
// name→dim guess (#174, #319).
export type EmbeddingPreflight = { ok: true; dim: number } | { ok: false; message: string };

export async function embeddingPreflight(): Promise<EmbeddingPreflight> {
  if (!embeddings.isAvailable()) {
    return { ok: false, message: 'Embeddings not available — set settings.embedding.enabled / provider' };
  }
  const probe = await embeddings.ensureReady();
  if (probe.code !== 'ok') {
    return { ok: false, message: `Embedding preflight failed (${probe.code}): ${probe.message}` };
  }
  return { ok: true, dim: probe.dim ?? embeddings.resolveEmbeddingDim() };
}

// The task-prefix mode a run embeds documents in. A reseed re-embeds everything,
// so it adopts the active model's preferred mode; otherwise stay consistent with
// the stored vectors, since query embeds must match the documents (a legacy meta
// row with no mode = embedded bare).
export function indexTextMode(reseed = false): embeddings.IndexTextMode {
  return reseed
    ? embeddings.preferredTextMode()
    : embeddings.resolveIndexTextMode(db.getEmbeddingMeta()?.textMode, db.vectorCount());
}

// The standalone Analyse run's trailing re-embed (#2313), so a new track's Sound:
// line does not wait for the next tag run. Dirty rows only, as the tag run's own
// trailing pass: never the unembedded rows phaseEmbed also takes. `before` is the
// dirty set read before the analysis, and a run that marked nothing embeds nothing
// and never probes the provider; one that marked something also takes the marks
// already waiting (an operator's, an era edit's), which cost the same either way.
// Only into the index as it stands: the same model and dimension as the stored
// vectors, or the run leaves its marks for the tag run, which owns a model change.
// Once, with no retry of its own (the default provider is a slow homelab Ollama),
// and best-effort: any failure logs and keeps the marks.
export async function reembedNewlyMarked(
  before: ReadonlySet<string>,
  log: (kind: 'info' | 'warning', text: string) => void,
): Promise<string[]> {
  const marked = db.textVectorDirtyIds();
  if (!marked.some(id => !before.has(id))) return [];
  const meta = db.getEmbeddingMeta();
  if (!meta) return [];
  const modelChanged = () =>
    log('info', `${marked.length} similarity vectors left for the next tag run: the embedding model ` +
      `changed since the index was built (${meta.model}, dim=${meta.dim})`);
  try {
    // The model is compared before the probe, so a run on another model sends
    // nothing, and never has ensureReady() pull a model it would then refuse.
    if (embeddings.isAvailable() && embeddings.activeModelLabel() !== meta.model) {
      modelChanged();
      return [];
    }
    const pre = await embeddingPreflight();
    if (!pre.ok) {
      log('info', `${marked.length} similarity vectors left for the next tag run: ${pre.message}`);
      return [];
    }
    if (pre.dim !== meta.dim) {
      log('info', `${marked.length} similarity vectors left for the next tag run: the embedding model ` +
        `changed since the index was built (${meta.model}, dim=${meta.dim})`);
      return [];
    }
    // The tag run's batch rule (tag-library.ts tagBatchSize).
    const batchSize = Math.max(1, Math.min(50, (settings.get() as any).embedding?.batchSize ?? 25));
    return await embedIds(marked, batchSize, indexTextMode());
  } catch (err: any) {
    log('warning', `Re-embedding analysed tracks failed (non-fatal; the next run retries): ${err?.message || err}`);
    return [];
  }
}

// Returns the ids whose vectors it wrote, so a caller can act on just those.
export async function phaseEmbed(
  targetIds: string[],
  batchSize: number,
  // The index's task-prefix mode, resolved once in run(): every document this
  // phase writes must match the vectors already in the index.
  textMode: embeddings.IndexTextMode,
): Promise<string[]> {
  // A dirty vector stays searchable until this pass replaces it, so it is
  // included even though hasVector(id) is true.
  const needsEmbed: string[] = db.textVectorDirtyIds();
  for (const id of targetIds) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  // Already-tagged tracks with no vector yet (legacy v1 imports) can't anchor
  // the KNN graph without this.
  for (const id of db.allTaggedIds()) {
    if (!db.hasVector(id)) needsEmbed.push(id);
  }
  const unique = [...new Set(needsEmbed)];
  if (unique.length === 0) {
    console.log('[tag] phase-1 nothing to embed');
    return [];
  }
  return embedIds(unique, batchSize, textMode);
}

async function embedIds(
  unique: string[],
  batchSize: number,
  textMode: embeddings.IndexTextMode,
): Promise<string[]> {
  const written: string[] = [];
  logEvent('info', `Building similarity vectors for ${unique.length.toLocaleString('en-GB')} tracks…`);
  reportProgress({ phase: 'embed', label: 'Embedding tracks', done: 0, total: unique.length });

  const embedBatchSize = Math.max(8, Math.min(64, batchSize * 2));
  for (let i = 0; i < unique.length; i += embedBatchSize) {
    const batch = unique.slice(i, i + embedBatchSize);
    const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
    const eraYears = songs.map(t =>
      resolveEraYear(t.year, t.originalYear, t.yearUntrusted),
    );
    // Measured acoustics only (#1246), through the one mapping.
    const acoustics = songs.map(t => embeddings.trackAcoustics(t));
    const texts = songs.map((t, index) =>
      embeddings.formatTrackText(
        {
          title: t.title, artist: t.artist, album: t.album, year: t.year, genres: t.genres,
          // Era precedence lives in ONE place (show-filter, #842), never raw year.
          eraYear: eraYears[index],
        },
        { lastfmTags: t.lastfmTags, lyricExcerpt: t.lyricExcerpt },
        acoustics[index],
      ),
    );
    let vecs: number[][];
    try {
      vecs = await embeddings.embedDocTexts(texts, textMode);
    } catch (err: any) {
      console.error(`[tag] embedding batch failed at offset ${i}: ${err.message}`);
      throw err;
    }
    for (let j = 0; j < songs.length; j++) {
      db.upsertTrackVector(songs[j].id, vecs[j], eraYears[j], embeddings.soundWords(acoustics[j]));
      written.push(songs[j].id);
    }
    if ((i + batch.length) % 500 === 0 || i + batch.length === unique.length) {
      console.log(`[tag] embedded ${i + batch.length}/${unique.length}`);
      reportProgress({ phase: 'embed', label: 'Embedding tracks', done: i + batch.length, total: unique.length });
    }
  }
  return written;
}
