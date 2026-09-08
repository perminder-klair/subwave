'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useDebounceValue } from 'usehooks-ts';
import { X } from 'lucide-react';
import { Card, Btn } from '../../ui';
import { num } from '../../LibraryTaggingPanel';
import type { LibraryStatsLite } from '../../LibraryTaggingPanel';
import { BrowseFilters } from '../BrowseFilters';
import { RowsTable } from '../RowsTable';
import { useLibrary } from '../LibraryContext';
import { libraryKeys, type BrowseKeyFilters } from '../queries';
import { useAdminQuery } from '../useAdminQuery';
import type { BrowseResponse, Energy, Sort, Vocal } from '../types';
import { PAGE_SIZE } from '../types';

export interface BrowseTabProps {
  // Filters live in useLibraryUrlState because they are mirrored to the query
  // string; `page` is not mirrored, so it lives here with its fetch.
  moods: string[]; setMoods: Dispatch<SetStateAction<string[]>>;
  energy: Energy; setEnergy: (e: Energy) => void;
  vocal: Vocal; setVocal: (v: Vocal) => void;
  genre: string; setGenre: (g: string) => void;
  yearFrom: string; setYearFrom: (y: string) => void;
  yearTo: string; setYearTo: (y: string) => void;
  q: string; setQ: (q: string) => void;
  sort: Sort; setSort: (s: Sort) => void;
  // Falls back for the filter counts before the first browse response lands.
  libStats: LibraryStatsLite | null;
}

export default function BrowseTab({
  moods, setMoods, energy, setEnergy, vocal, setVocal, genre, setGenre,
  yearFrom, setYearFrom, yearTo, setYearTo, q, setQ, sort, setSort, libStats,
}: BrowseTabProps) {
  const { seedVocab } = useLibrary();

  const [page, setPage] = useState(0);

  // Debounce the free-text box only; the other controls change one step at a
  // time and delaying them feels laggy.
  const [debouncedQ] = useDebounceValue(q, 250);

  const filters: BrowseKeyFilters = {
    moods, energy, vocal, genre, yearFrom, yearTo, q: debouncedQ.trim(), sort, page,
  };

  // No AbortController needed: the response is keyed to the filters that asked
  // for it, so a slow earlier request cannot overwrite a faster later one.
  const browseQuery = useAdminQuery<BrowseResponse>({
    key: libraryKeys.browse(filters),
    path: () => {
      const params = new URLSearchParams();
      if (moods.length) params.set('moods', moods.join(','));
      if (energy !== 'any') params.set('energy', energy);
      if (vocal !== 'any') params.set('vocal', vocal);
      if (genre) params.set('genre', genre);
      if (yearFrom) params.set('yearFrom', yearFrom);
      if (yearTo) params.set('yearTo', yearTo);
      if (debouncedQ.trim()) params.set('q', debouncedQ.trim());
      params.set('sort', sort);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      return `/library/browse?${params}`;
    },
    toastOnError: true,
  });
  const browse = browseQuery.data ?? null;

  const genresQuery = useAdminQuery<{ value: string; songCount: number }[]>({
    key: libraryKeys.genres(),
    path: '/library/genres',
    // Genres change only when the library is re-scanned.
    staleTime: Infinity,
    parse: raw => (raw as { genres?: { value: string; songCount: number }[] }).genres || [],
  });
  const genreList = genresQuery.data ?? [];

  useEffect(() => { setPage(0); }, [moods, energy, vocal, genre, yearFrom, yearTo, debouncedQ, sort]);

  // The vocab only rides the browse response, so other tabs fetch a one-row
  // browse rather than hardcoding SHOW_MOODS.
  useEffect(() => {
    if (browse?.moodVocab?.length) seedVocab(browse.moodVocab);
  }, [browse, seedVocab]);

  const stats = browse?.stats;
  const moodCounts = stats?.byMood || libStats?.byMood || {};
  const energyCounts = stats?.byEnergy || libStats?.byEnergy || {};
  const totalPages = browse ? Math.max(1, Math.ceil(browse.total / PAGE_SIZE)) : 1;
  const filtersActive =
    moods.length > 0 || energy !== 'any' || vocal !== 'any' || !!genre || !!yearFrom || !!yearTo || !!q.trim();

  const clearFilters = () => {
    setMoods([]); setEnergy('any'); setVocal('any'); setGenre(''); setYearFrom(''); setYearTo(''); setQ('');
    setSort('artist'); setPage(0);
  };

  return (
    <>
      <BrowseFilters
        moodVocab={browse?.moodVocab || []}
        moodCounts={moodCounts}
        energyCounts={energyCounts}
        genreList={genreList}
        moods={moods} setMoods={setMoods}
        energy={energy} setEnergy={setEnergy}
        vocal={vocal} setVocal={setVocal}
        genre={genre} setGenre={setGenre}
        yearFrom={yearFrom} setYearFrom={setYearFrom}
        yearTo={yearTo} setYearTo={setYearTo}
        q={q} setQ={setQ}
        sort={sort} setSort={setSort}
      />

      {filtersActive && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span className="caption">active</span>
          {moods.map(m => (
            <span key={m} className="lib-active-chip">
              {m}<button type="button" onClick={() => setMoods(moods.filter(x => x !== m))} aria-label={`remove ${m}`}>×</button>
            </span>
          ))}
          {energy !== 'any' && (
            <span className="lib-active-chip">{energy} energy<button type="button" onClick={() => setEnergy('any')} aria-label="remove energy">×</button></span>
          )}
          {vocal !== 'any' && (
            <span className="lib-active-chip">{vocal}<button type="button" onClick={() => setVocal('any')} aria-label="remove vocal filter">×</button></span>
          )}
          {genre && (
            <span className="lib-active-chip">{genre}<button type="button" onClick={() => setGenre('')} aria-label="remove genre">×</button></span>
          )}
          {(yearFrom || yearTo) && (
            <span className="lib-active-chip">{yearFrom || '…'}–{yearTo || '…'}<button type="button" onClick={() => { setYearFrom(''); setYearTo(''); }} aria-label="remove year">×</button></span>
          )}
          {q.trim() && (
            <span className="lib-active-chip">“{q.trim()}”<button type="button" onClick={() => setQ('')} aria-label="remove search">×</button></span>
          )}
          <button type="button" className="inline-flex items-center gap-1 font-bold text-muted hover:text-ink" onClick={clearFilters}>
            <X size={12} /> clear all
          </button>
        </div>
      )}

      <Card
        title="Tracks"
        sub={browse ? `${num(browse.total)} match${browse.total === 1 ? '' : 'es'}` : ''}
        bodyClass="!p-0"
      >
        {/* isFetching, not isLoading: isLoading is false on a cached-then-
            revalidating page, which would drop the spinner during a page
            change. isFetching is what browseLoading tracked. */}
        <RowsTable tab="browse" rows={browse?.rows || []} loading={browseQuery.isFetching} />
      </Card>

      {browse && browse.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-y-2 text-[11px] text-muted">
          <span className="mono-num">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, browse.total)} of {num(browse.total)}
          </span>
          <span className="flex items-center gap-2">
            <Btn sm disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>‹ prev</Btn>
            <span className="mono-num">page {page + 1} of {totalPages}</span>
            <Btn sm disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>next ›</Btn>
          </span>
        </div>
      )}
    </>
  );
}
