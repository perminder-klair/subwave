import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as subsonic from '../../../../../music/subsonic.js';
import { inYearRange } from '../../../../../music/show-filter.js';
import { definePickerTool } from '../defs.js';
import * as blocklist from '../../../../../music/blocklist.js';

export default definePickerTool({
  name: 'songsByEra',
  build: ({ collect, emptyResult }) => tool({
    description: 'A random library sample from a requested era, using original release years where known. Give inclusive year bounds; null leaves that end open. Reissue and compilation dates are not evidence of a track belonging to that era.',
    inputSchema: z.object({ fromYear: z.number().int().min(1000).max(9999).nullable(), toYear: z.number().int().min(1000).max(9999).nullable() }),
    execute: async ({ fromYear, toYear }) => {
      try {
        if (fromYear == null && toYear == null) return { error: 'provide at least one era bound' };
        if (fromYear != null && toYear != null && fromYear > toYear) return { error: 'era bounds are reversed' };
        await library.load();
        // The mirror filters on resolved original years, so a reissue is not
        // missed merely because Navidrome's file-year envelope excludes it.
        const bounds = { yearFrom: fromYear, yearTo: toYear };
        const first = library.filter({ ...bounds, limit: 60 });
        const offset = Math.floor(Math.random() * Math.max(1, first.total - 60 + 1));
        const list = first.total
          ? blocklist.rejectBlocked(offset ? library.filter({ ...bounds, limit: 60, offset }).rows : first.rows)
          : await subsonic.getRandomSongs({ size: 60, fromYear: fromYear ?? undefined, toYear: toYear ?? undefined });
        const resolved = list.map(track => {
          const record = library.get(track.id);
          return { ...track, originalYear: record?.originalYear, yearUntrusted: record?.yearUntrusted ?? track.isCompilation };
        });
        const out = collect(inYearRange(resolved, [{ fromYear, toYear }]));
        return out.length ? out : emptyResult(list.length, 'no eligible tracks in that era — try another source');
      } catch (err) { return { error: (err as Error).message }; }
    },
  }),
});
