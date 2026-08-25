'use client';

// Three chip states off GET /library/genres/related: empty field → most-stocked
// genres, exact genre → its nearest by embedding similarity, partial text →
// substring matches.

import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { adminJson, useAdminQuery } from '../../lib/admin-query';
import { settingsKeys } from './settings/queries';

interface GenreItem {
  value: string;
  songCount: number;
}

interface SuggestData {
  genres: GenreItem[];
  related: Record<string, GenreItem[]>;
  hasEmbeddings: boolean;
}

interface Props {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  value: string;
  onSelect: (genre: string) => void;
  // Genres already picked. The caller keeps the typed filter in place across
  // picks, so the same chip list stays on screen — without marking what's
  // already in it, a chip gives no feedback when clicked.
  selected?: string[];
  disabled?: boolean;
}

const POPULAR = 12;
const MATCHES = 10;
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
export const genreSelectionKey = (s: string) => s.trim().toLowerCase();

export default function GenreSuggest({ adminFetch, value, onSelect, selected, disabled }: Props) {
  const query = useAdminQuery<SuggestData>({
    key: settingsKeys.genreSuggestions(),
    adminFetch,
    request: (fetcher, signal) =>
      adminJson<SuggestData>(fetcher, '/library/genres/related', undefined, signal),
    toastOnError: false,
  });
  const data = query.data ?? null;
  // The field is free text, so the typed value is resolved to a real genre here.
  const byNorm = useMemo(
    () => new Map((data?.genres || []).map((genre) => [norm(genre.value), genre])),
    [data],
  );
  const selectedKeys = useMemo(
    () => new Set((selected || []).map(genreSelectionKey)),
    [selected],
  );

  if (query.error || !data || data.genres.length === 0) return null;

  const typed = value.trim();
  const nv = norm(typed);
  const match = nv ? byNorm.get(nv) : undefined;

  let label: string;
  let chips: GenreItem[];
  if (match && data.related[match.value]?.length) {
    label = `similar to ${match.value}`;
    chips = data.related[match.value] ?? [];
  } else if (nv) {
    // Substring matches, minus the exact one already in the field.
    const subs = data.genres.filter((g) => norm(g.value).includes(nv) && norm(g.value) !== nv);
    if (subs.length) {
      label = 'matches';
      chips = subs.slice(0, MATCHES);
    } else {
      label = 'popular genres';
      chips = data.genres.slice(0, POPULAR);
    }
  } else {
    label = 'popular genres';
    chips = data.genres.slice(0, POPULAR);
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="field-hint m-0">
        {label}
        {match && !data.hasEmbeddings ? ' — tag your library with embeddings for related genres' : ''}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((g) => {
          const isSelected = selectedKeys.has(genreSelectionKey(g.value));
          const tracks = `${g.songCount} track${g.songCount === 1 ? '' : 's'}`;
          return (
            <button
              key={g.value}
              type="button"
              className={cn('lib-chip', (isSelected || (norm(g.value) === nv && nv !== '')) && 'on')}
              onClick={() => onSelect(g.value)}
              disabled={isSelected || disabled}
              aria-pressed={isSelected}
              title={isSelected ? `${tracks} — already added` : tracks}
            >
              {g.value}
              {g.songCount > 0 && <span className="n">{g.songCount}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
