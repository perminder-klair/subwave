// Phase 1 - embedding. Turns each track's metadata and enrichment into the text
// vector the picker's similarity search runs over. See ../tag-library.ts.

import * as db from '../library-db.js';
import * as embeddings from '../embeddings.js';
import { resolveEraYear } from '../show-filter.js';
import { reportProgress } from '../tagger-progress.js';
import { logEvent } from './log.js';

export async function phaseEmbed(
  targetIds: string[],
  batchSize: number,
  // The index's task-prefix mode, resolved once in run(): every document this
  // phase writes must match the vectors already in the index.
  textMode: embeddings.IndexTextMode,
): Promise<void> {
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
    return;
  }
  logEvent('info', `Building similarity vectors for ${unique.length.toLocaleString('en-GB')} tracks…`);
  reportProgress({ phase: 'embed', label: 'Embedding tracks', done: 0, total: unique.length });

  const embedBatchSize = Math.max(8, Math.min(64, batchSize * 2));
  for (let i = 0; i < unique.length; i += embedBatchSize) {
    const batch = unique.slice(i, i + embedBatchSize);
    const songs = batch.map(id => db.getTrack(id)).filter((t): t is db.TrackRecord => !!t);
    const eraYears = songs.map(t =>
      resolveEraYear(t.year, t.originalYear, t.yearUntrusted),
    );
    const texts = songs.map((t, index) =>
      embeddings.formatTrackText(
        {
          title: t.title, artist: t.artist, album: t.album, year: t.year, genres: t.genres,
          // Era precedence lives in ONE place (show-filter, #842), never raw year.
          eraYear: eraYears[index],
        },
        { lastfmTags: t.lastfmTags, lyricExcerpt: t.lyricExcerpt },
        // Measured acoustics only (#1246). Nothing the tagger decides may enter
        // here: phases 2-4 vote over the graph these vectors form.
        {
          bpm: t.bpm, musicalKey: t.musicalKey, audioMoods: t.audioMoods,
          vocalRanges: t.vocalRanges,
        },
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
      db.upsertTrackVector(songs[j].id, vecs[j], eraYears[j]);
    }
    if ((i + batch.length) % 500 === 0 || i + batch.length === unique.length) {
      console.log(`[tag] embedded ${i + batch.length}/${unique.length}`);
      reportProgress({ phase: 'embed', label: 'Embedding tracks', done: i + batch.length, total: unique.length });
    }
  }
}
