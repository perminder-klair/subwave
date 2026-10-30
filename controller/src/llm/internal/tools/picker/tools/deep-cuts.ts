import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import { DEEP_CUT_DAYS } from '../../../../../music/airing.js';
import { definePickerTool } from '../defs.js';

export default definePickerTool({
  name: 'deepCuts',
  // Needs the library mirror (the tagger's Navidrome walk) — on an un-synced
  // install the tracks table is empty and the tool could only return [].
  //
  // Gated on `mirrorTotal` (every row) and NOT on `stats.total`, which counts
  // only TAGGED tracks: db.deepCutTracks queries `tracks` unconditionally, so a
  // synced-but-untagged install — the exact install this tool serves best,
  // since nothing else there knows anything about the library — would have had
  // 50k rows to sample and a tool that never registered.
  available: ({ stats }) => ((stats.mirrorTotal ?? stats.total) ?? 0) > 0,
  build: ({ collect, candidateLimit, emptyResult }) => tool({
    description: `The library's unexplored shelves: a random sample of tracks this station has NEVER aired, or hasn't aired in ${DEEP_CUT_DAYS}+ days. The strongest variety signal available — reach for it whenever the rotation feels familiar, and treat what it returns as first-class candidates, not a last resort.`,
    inputSchema: z.object({}),
    execute: async () => {
      try {
        await library.load();
        const rows = library.deepCuts(undefined, candidateLimit(60));
        const out = collect(rows);
        if (out.length) return out;
        return emptyResult(rows.length, rows.length
          ? 'every deep cut fell outside this pick\'s filters — choose from your other tool results this round'
          : 'the whole library has aired recently — no deep cuts to surface; use another tool');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
