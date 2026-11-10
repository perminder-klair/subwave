'use client';


import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Input } from '../ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';
import { Btn } from './ui';
import RosterViewToggle from './RosterViewToggle';
import type { RosterView } from '../../lib/adminView';

export interface RosterToolbarProps<S extends string> {
  query: string;
  onQueryChange: (v: string) => void;
  /** Placeholder + aria label, e.g. "shows". */
  noun: string;

  sort: S;
  onSortChange: (v: S) => void;
  /** Ordered [value, label] pairs — the panel's own sort vocabulary. */
  sortOptions: readonly (readonly [S, string])[];

  /** Every tag in use. The row hides itself when nothing carries one, so a
   *  station that never tags never sees the feature. */
  tags: string[];
  selectedTags: string[];
  onTagsChange: (next: string[]) => void;

  /** Whether Clear should appear — the panel decides, since it owns the full
   *  filter shape (this component can't see `extraFilters`' state). */
  filtered: boolean;
  onClear: () => void;

  view: RosterView;
  onViewChange: (v: RosterView) => void;

  /** Panel-specific selects, dropped in between search and sort. */
  extraFilters?: ReactNode;
  /** e.g. "12 of 44 shows" — the panel already computes it for its counter. */
  summary?: ReactNode;
}

export function RosterToolbar<S extends string>({
  query, onQueryChange, noun,
  sort, onSortChange, sortOptions,
  tags, selectedTags, onTagsChange,
  filtered, onClear,
  view, onViewChange,
  extraFilters, summary,
}: RosterToolbarProps<S>) {
  return (
    <section className="card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full flex-none sm:min-w-[200px] sm:flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder={`Search ${noun}…`}
            aria-label={`Search ${noun}`}
            className="pl-8"
          />
        </div>
        {extraFilters}
        <Select value={sort} onValueChange={v => onSortChange(v as S)}>
          <SelectTrigger className="min-w-0 flex-1 sm:w-[160px] sm:flex-none" aria-label={`Sort ${noun}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered && (
          <Btn className="min-h-9 sm:min-h-0" onClick={onClear} title="Clear all filters">
            <X size={14} /> Clear
          </Btn>
        )}
        <div className="ml-auto flex items-center gap-2">
          {summary && <span className="caption">{summary}</span>}
          <RosterViewToggle view={view} onChange={onViewChange} />
        </div>
      </div>
      {tags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          <span className="caption mr-1">tags</span>
          {tags.map(t => {
            const on = selectedTags.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => onTagsChange(on ? selectedTags.filter(x => x !== t) : [...selectedTags, t])}
                className={cn(
                  'min-h-9 border border-ink px-2 py-0.5 text-[12px] sm:min-h-0',
                  on ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default RosterToolbar;
