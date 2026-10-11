import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as analyzer from '../../../../../music/analyzer.js';
import { definePickerTool } from '../defs.js';

// Only registered when the audio index exists AND the analysis backend can embed
// text through the CLAP text tower (heavy analyzer; lean builds and
// pre-text-tower sidecars report false). CLAP text and audio vectors share one
// space, so a described SOUND maps straight onto the stored track vectors — no
// per-track metadata involved. null capability (not yet probed / local venv)
// keeps the tool on; execute degrades cleanly.
export default definePickerTool({
  name: 'searchBySound',
  available: ({ hasAudioEmbeddings }) => hasAudioEmbeddings && analyzer.textEmbeddingAvailable() !== false,
  build: ({ collect, emptyResult, knnExclude }) => tool({
    description: 'Describe a SOUND in words and get tracks whose actual audio matches — e.g. "dusty late-night jazz with brushed drums", "warm acoustic fingerpicking". For timbre/instrumentation/energy asks the mood vocab can\'t express; searchByLyrics matches THEMES instead.',
    // No k input, same rationale as the other similarity tools: wide fixed
    // KNN (60), collect() caps to 8 fresh ones.
    inputSchema: z.object({
      query: z.string().min(3).describe('a description of how the music should sound'),
    }),
    execute: async ({ query }, { abortSignal }: { abortSignal?: AbortSignal }) => {
      try {
        await library.load();
        // Short deadline: this runs mid-pick, and a bulk analysis pass may
        // hold the backend's single-threaded worker — better to come back
        // empty (the agent falls through to other tools) than stall the DJ.
        // The tool's own abortSignal (the agent's 10s per-tool timeout) is the
        // real ceiling, so no cold retry: a second attempt could never fit
        // inside it, and it would keep the worker busy after the pick moved on.
        const vecs = await analyzer.embedTexts([query.trim()], { timeoutMs: 8_000, coldRetry: false, signal: abortSignal });
        if (!vecs || !vecs[0]) {
          return { error: 'sound search unavailable right now — use tracksByMood, searchByLyrics or similarSongs' };
        }
        const list = library.tracksByAudioVector(vecs[0], 60, { excludeIds: knnExclude });
        const out = collect(list);
        return out.length ? out : emptyResult(list.length, 'nothing in the library sounds like that — choose from your other tool results this round');
      }
      catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
