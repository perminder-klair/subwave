import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as embeddings from '../../../../../music/embeddings.js';
import { definePickerTool } from '../defs.js';

// Only registered when both the text embedding index (withEmbedding > 0) AND a
// text-embedding provider are available. Every code path inside requires both:
// embed the query, then KNN over stored track vectors. Without them the tool
// errors or returns nothing — hide it so the model uses searchLibrary (lexical)
// or similarSongs instead.
export default definePickerTool({
  name: 'searchByLyrics',
  available: ({ hasTextEmbeddings, hasEmbeddingProvider }) => hasTextEmbeddings && hasEmbeddingProvider,
  build: ({ collect, emptyResult, knnExclude, textIndexDegraded }) => tool({
    description: 'Semantic lyric / theme search over the library — for thematic picks the mood vocab can\'t express, e.g. "songs about hometown", "tracks with hopeful lyrics", "feeling stuck".'
      + (textIndexDegraded
          ? ' NOTE: few tracks in this index carry lyric excerpts, so matches are mostly metadata text rather than actual lyrics — treat results loosely.'
          : ''),
    // No k input: the agent reliably picked a small k, and recency filtering
    // then thins it further. Pull a wide fixed KNN (60) internally — collect()
    // still caps to 8 fresh ones. Mirrors the seed-similarity tools.
    inputSchema: z.object({
      query: z.string().min(3),
    }),
    execute: async ({ query }, { abortSignal }: { abortSignal?: AbortSignal }) => {
      try {
        if (!embeddings.isAvailable()) return { error: 'embeddings not configured — set settings.embedding.enabled / provider' };
        await library.load();
        // abortSignal is the agent's per-tool timeout: it cancels the provider
        // call (and the SDK's own retries) rather than letting it run on.
        const vec = await embeddings.embedQueryText(query.trim(), library.embeddingIndexTextMode(), { abortSignal });
        if (!vec) return { error: 'embedding query failed' };
        const list = library.tracksByVector(vec, 60, { excludeIds: knnExclude });
        const out = collect(list, 8, { similarity: { kind: 'text', reference: query.trim() } });
        return out.length ? out : emptyResult(list.length, 'no thematic match in the lyric index — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
