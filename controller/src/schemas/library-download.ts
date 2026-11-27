// POST /library/download (routes/library/download.ts): what the admin Library's
// download button asks for. Exactly one of:
// - `ids`: the rows the operator ticked, in the order to pack them;
// - `filter`: the Browse list's own query-string parameters (minus paging), so
//   the server reads every page of exactly the list on screen;
// - `liked`: the Tracks tab's Liked list, by its own view parameters (minus
//   paging): every liked track, in the order the view shows for that sort.
import { z } from 'zod';

/** Ticked rows per request: a deliberate choice, so a wide limit. */
export const LIBRARY_DOWNLOAD_IDS_MAX = 10_000;

/** A whole list (`filter` or `liked`) downloads at most this many tracks, and
 *  a Browse list only once narrowed: never the whole library by accident
 *  (music/download-policy.ts). The admin offers the list button under the same
 *  number, read from the schema mirror. */
export const LIBRARY_DOWNLOAD_LIST_MAX = 2_000;

// Subsonic ids are short alphanumerics (the /cover/:id and preview rule).
const trackId = z.string().regex(/^[\w-]{1,64}$/, 'bad track id');
const param = (max: number) => z.string().max(max).optional();

export const libraryDownloadFilterSchema = z.object({
  moods: param(2_000),
  energy: param(32),
  genre: param(200),
  vocal: param(32),
  yearFrom: param(8),
  yearTo: param(8),
  q: param(2_000),
  sort: param(32),
});

// The Liked view's sorts (GET /library/liked). Strict here: an unknown sort
// is refused rather than read as the default.
export const LIKED_SORTS = ['recent', 'count', 'artist'] as const;

export const libraryDownloadLikedSchema = z.object({
  sort: z.enum(LIKED_SORTS).optional(),
  q: param(2_000),
}).strict();

export const libraryDownloadSchema = z.object({
  ids: z.array(trackId).min(1, 'ids must name at least one track')
    .max(LIBRARY_DOWNLOAD_IDS_MAX, `at most ${LIBRARY_DOWNLOAD_IDS_MAX} ticked tracks per download`)
    .optional(),
  filter: libraryDownloadFilterSchema.optional(),
  liked: libraryDownloadLikedSchema.optional(),
}).refine(b => [b.ids, b.filter, b.liked].filter(v => v !== undefined).length === 1, {
  message: 'send exactly one of ids, filter or liked',
});

export type LibraryDownloadBody = z.infer<typeof libraryDownloadSchema>;
export type LibraryDownloadFilter = z.infer<typeof libraryDownloadFilterSchema>;
export type LibraryDownloadLiked = z.infer<typeof libraryDownloadLikedSchema>;
