'use client';

// GenreSuggest — related-genre chips beneath the show editor's "genre lean"
// field. Three states, all driven off GET /library/genres/related:
//   • field empty        → the most-stocked genres as quick-picks
//   • field is a genre    → its nearest genres by embedding similarity
//   • field partially typed → genres whose name contains the text
// Click a chip to set the lean. A single-value helper — one genre in, one out —
// that turns the embedding data into something actionable instead of decorative.

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

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
}

const POPULAR = 12;
const MATCHES = 10;
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export default function GenreSuggest({ adminFetch, value, onSelect }: Props) {
  const [data, setData] = useState<SuggestData | null>(null);
  const [error, setError] = useState(false);
  // Resolve the typed value to a real genre on the client (the field is free
  // text); used to look up its neighbour list.
  const byNorm = useRef<Map<string, GenreItem>>(new Map());

  // Fetch once on mount. No "already fetched" ref guard — under React
  // StrictMode the first mount's fetch is cancelled by the cleanup, so the
  // remount must be free to fetch again or `data` never populates.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await adminFetch('/library/genres/related');
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as SuggestData;
        if (!live) return;
        if (j && Array.isArray(j.genres)) {
          byNorm.current = new Map(j.genres.map((g) => [norm(g.value), g]));
          setData(j);
        } else setData(null);
      } catch {
        if (live) setError(true);
      }
    })();
    return () => { live = false; };
  }, [adminFetch]);

  if (error || !data || data.genres.length === 0) return null;

  const typed = value.trim();
  const nv = norm(typed);
  const match = nv ? byNorm.current.get(nv) : undefined;

  let label: string;
  let chips: GenreItem[];
  if (match && data.related[match.value]?.length) {
    label = `similar to ${match.value}`;
    chips = data.related[match.value] ?? [];
  } else if (nv) {
    // Typed text that isn't an exact genre → substring matches (minus the exact
    // one, which is already in the field), falling back to popular.
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
        {chips.map((g) => (
          <button
            key={g.value}
            type="button"
            className={cn('lib-chip', norm(g.value) === nv && nv !== '' && 'on')}
            onClick={() => onSelect(g.value)}
            title={`${g.songCount} track${g.songCount === 1 ? '' : 's'}`}
          >
            {g.value}
            {g.songCount > 0 && <span className="n">{g.songCount}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
