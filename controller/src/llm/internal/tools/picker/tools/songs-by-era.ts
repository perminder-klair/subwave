import { tool } from 'ai';
import { z } from 'zod';
import * as library from '../../../../../music/library.js';
import * as subsonic from '../../../../../music/subsonic.js';
import { inYearRange } from '../../../../../music/show-filter.js';
import { definePickerTool } from '../defs.js';
import * as blocklist from '../../../../../music/blocklist.js';

export default definePickerTool({
  name: 'songsByEra',
  build: ({ collect, candidateLimit, emptyResult }) => tool({
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
        const limit = candidateLimit(60);
        const first = library.filter({ ...bounds, limit });
        const offset = Math.floor(Math.random() * Math.max(1, first.total - limit + 1));
        const rows = offset ? library.filter({ ...bounds, limit, offset }).rows : first.rows;
        // Browse pages cap at 200; a strict discovery sample spans up to 300.
        while (rows.length < limit && offset + rows.length < first.total) {
          const next = library.filter({ ...bounds, limit: limit - rows.length, offset: offset + rows.length }).rows;
          if (!next.length) break;
          rows.push(...next);
        }
        const list = first.total
          ? blocklist.rejectBlocked(rows)
          : await subsonic.getRandomSongs({ size: limit, fromYear: fromYear ?? undefined, toYear: toYear ?? undefined });
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
