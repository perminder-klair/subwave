// The Library download's whole-list guard (routes/library/download.ts): a list
// download (`filter`: a Browse list, `liked`: the Liked list) never takes the
// whole library by accident. An unfiltered Browse list is the whole library
// (tens of thousands of tracks on a real station), so it is refused outright;
// any narrowed list is refused above LIBRARY_DOWNLOAD_LIST_MAX tracks. Ticked
// rows (`ids`) are a deliberate choice and keep only their own schema limit.
// The admin offers the list button under the same two rules
// (web/components/admin/library/download-policy.ts), so it never offers what
// this refuses. Both directions fail closed: when in doubt, no download.

/** The parsed Browse filter (routes/library/browse.ts `browseFilterFromQuery`). */
export interface BrowseListOpts {
  moods: readonly string[];
  energy: string | null;
  genre: string | null;
  vocal: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  query: unknown;
}

// Narrowed means the list's WHERE filters on something; the sort alone does not.
// Judged on the parsed filter, i.e. on what the list query actually applies, so
// an empty or unreadable parameter never counts as a filter.
export function browseListNarrowed(o: BrowseListOpts): boolean {
  return o.moods.length > 0 || !!o.energy || !!o.genre || !!o.vocal
    || o.yearFrom != null || o.yearTo != null || o.query != null;
}

export interface ListDownloadRefusal { error: string; count?: number; cap: number }

const n = (v: number) => v.toLocaleString('en-US');

// `count` is null when it was not worth counting (an unnarrowed list is refused
// before its rows are read).
export function listDownloadRefusal({ narrowed, count, cap }: {
  narrowed: boolean; count: number | null; cap: number;
}): ListDownloadRefusal | null {
  if (!narrowed) {
    return {
      error: 'narrow the list first (a search or a filter), or tick the tracks to take: the whole library never downloads at once',
      cap,
    };
  }
  if (count != null && count > cap) {
    return {
      error: `this list holds ${n(count)} tracks; a whole list downloads at most ${n(cap)}: narrow it or tick the tracks to take`,
      count,
      cap,
    };
  }
  return null;
}
