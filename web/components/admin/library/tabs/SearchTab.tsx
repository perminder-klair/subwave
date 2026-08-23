'use client';

import {
  useEffect, useMemo, useRef, useState,
  type ChangeEvent, type FormEvent,
} from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../../ui/input-group';
import { Card, Btn, Seg } from '../../ui';
import { RowsTable } from '../RowsTable';
import { useLibrary } from '../LibraryContext';
import { libraryKeys } from '../queries';
import { adminJson, useQueryErrorToast } from '../../../../lib/admin-query';
import type { SearchMode, Track } from '../types';
import { SEARCH_PAGE } from '../types';

interface SearchPage { rows: Track[]; hasMore: boolean }

export interface SearchTabProps {
  searchQuery: string; setSearchQuery: (s: string) => void;
  searchMode: SearchMode; setSearchMode: (m: SearchMode) => void;
  // False until useLibraryUrlState's restore has run — gates the deep-link
  // auto-search so it fires against the restored query, not an empty one.
  urlRestored: boolean;
}

export default function SearchTab({
  searchQuery, setSearchQuery, searchMode, setSearchMode, urlRestored,
}: SearchTabProps) {
  const { adminFetch, ready, coverage } = useLibrary();

  // Carries the same rationale lastSearchRef did: Load more must page the
  // search that produced the rows, not whatever is currently typed in the
  // (maybe edited) input.
  const [submitted, setSubmitted] = useState<{ q: string; mode: SearchMode } | null>(null);

  // Offset paging, not a cursor: /dj/search takes an offset and reports hasMore.
  // 'sound' mode is a fixed-K CLAP search with no paging at all, so its
  // getNextPageParam always returns undefined.
  const searchQ = useInfiniteQuery<SearchPage>({
    queryKey: libraryKeys.search(submitted?.q ?? '', submitted?.mode ?? 'library'),
    enabled: ready && !!submitted?.q,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      // `enabled` already gates on submitted?.q, so this is unreachable — but
      // the queryFn's own types don't know that.
      if (!submitted?.q) return { rows: [], hasMore: false };
      const { q: text, mode } = submitted;
      if (mode === 'sound') {
        const j = await adminJson<{ results?: Track[] }>(
          adminFetch,
          `/library/search-sound?q=${encodeURIComponent(text)}&limit=${SEARCH_PAGE}`,
          undefined,
          signal,
        );
        return { rows: j.results || [], hasMore: false };
      }
      const j = await adminJson<{ results?: Track[]; hasMore?: boolean }>(
        adminFetch,
        `/dj/search?q=${encodeURIComponent(text)}&limit=${SEARCH_PAGE}&offset=${pageParam as number}`,
        undefined,
        signal,
      );
      // Absent on an old controller (fixed 12 rows) → no Load more, as before.
      return { rows: j.results || [], hasMore: !!j.hasMore };
    },
    getNextPageParam: (last, all) =>
      (last.hasMore ? all.reduce((n, p) => n + p.rows.length, 0) : undefined),
  });
  useQueryErrorToast(searchQ.error, true);

  const rows = useMemo(
    () => searchQ.data?.pages.flatMap(p => p.rows) ?? null,
    [searchQ.data],
  );
  // isFetching covers the next page too; the Search button and the table
  // spinner are about the FIRST page, which is what `searching` tracked.
  const searching = searchQ.isFetching && !searchQ.isFetchingNextPage;

  const runSearch = (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const text = searchQuery.trim();
    if (text) setSubmitted({ q: text, mode: searchMode });
  };

  // Runs once per mount, for a deep link (?tab=search&sq=…) and — because this
  // component unmounts with the tab — on a return to Search with a query still
  // in the box. Keep the one-shot ref: remounting must not re-fire it.
  const autoSearchedRef = useRef(false);
  useEffect(() => {
    if (!ready || !urlRestored || autoSearchedRef.current) return;
    autoSearchedRef.current = true;
    if (searchQuery.trim()) setSubmitted({ q: searchQuery.trim(), mode: searchMode });
  }, [ready, urlRestored, searchQuery, searchMode]);

  return (
    <>
      <Card bodyClass="!py-3">
        <div className="grid gap-2.5">
          {/* On lean installs the tab stays plain metadata search. */}
          {coverage?.soundSearchAvailable === true && (
            <div className="flex flex-wrap items-center gap-3">
              <Seg
                value={searchMode}
                options={[
                  { id: 'library', label: 'Library' },
                  { id: 'sound', label: 'Sounds like' },
                ]}
                onChange={(v: string) => {
                  setSearchMode(v as SearchMode);
                  setSubmitted(null);
                }}
              />
              {searchMode === 'sound' && (
                <span className="text-[11px] text-muted">
                  describe a sound — matches the audio itself, not titles or tags
                </span>
              )}
            </div>
          )}
          {/* Phone: query on its own row, both buttons on the row under it. */}
          <form onSubmit={runSearch} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_auto_auto]">
            <InputGroup className="col-span-2 sm:col-span-1">
              <InputGroupAddon><Search /></InputGroupAddon>
              <InputGroupInput
                // Deliberately no minLength: one-character queries are
                // legitimate (an album called "1") and a floor would reject
                // them with a native validation bubble.
                required
                placeholder={searchMode === 'sound'
                  ? 'dusty late-night jazz with brushed drums, warm acoustic fingerpicking…'
                  : 'floating points, kingdoms in colour, 2018…'}
                value={searchQuery}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
              />
            </InputGroup>
            <Btn tone="accent" type="submit" disabled={searching || !searchQuery.trim() || !ready}>
              {searching ? 'Searching…' : 'Search'}
            </Btn>
            <Btn type="button" onClick={() => { setSearchQuery(''); setSubmitted(null); }} disabled={searching}>
              Clear
            </Btn>
          </form>
        </div>
      </Card>

      <Card
        title="Search results"
        sub={rows ? `${rows.length} result${rows.length === 1 ? '' : 's'}` : 'enter a query'}
        bodyClass="!p-0"
      >
        <RowsTable tab="search" rows={rows || []} loading={searching} />
      </Card>

      {searchQ.hasNextPage && (rows?.length || 0) > 0 && (
        <div className="flex justify-center">
          <Btn onClick={() => { void searchQ.fetchNextPage(); }} disabled={searchQ.isFetchingNextPage}>
            {searchQ.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Btn>
        </div>
      )}
    </>
  );
}
