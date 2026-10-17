'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '../../ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../../ui/input-group';
import { Field, FieldLabel } from '../../ui/field';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../ui/select';
import { cn } from '../../../lib/cn';
 
import type { Energy, Sort, Vocal } from './types';
import { EnergyMeter } from './bits';

// The search box's examples, phrased as what a person wants. Clicking one puts
// it in the box. The first three are the empty box's suggestions.
const QUERY_EXAMPLES: Array<{ want: string; query: string }> = [
  { want: 'title starts with love', query: 'title:/^love/' },
  { want: 'exactly this artist', query: 'artist:="ABBA"' },
  { want: 'a decade, without pop', query: '-genre:pop year:[1990 TO 1999]' },
  { want: 'title ends with (Live)', query: 'title:/\\(live\\)$/' },
  { want: 'the whole word love', query: 'title:/\\blove\\b/' },
  { want: 'either one', query: 'title:live OR title:remix' },
  { want: 'faster than 140 bpm', query: 'bpm:>140' },
  { want: 'by mood and tag', query: 'mood:calm tag:christmas' },
  { want: 'anywhere in title, artist or album', query: 'live' },
];

interface BrowseFiltersProps {
  moodVocab: string[];
  moodCounts: Record<string, number>;
  energyCounts: Record<string, number>;
  genreList: { value: string; songCount: number }[];
  moods: string[]; setMoods: (m: string[]) => void;
  energy: Energy; setEnergy: (e: Energy) => void;
  vocal: Vocal; setVocal: (v: Vocal) => void;
  genre: string; setGenre: (g: string) => void;
  yearFrom: string; setYearFrom: (s: string) => void;
  yearTo: string; setYearTo: (s: string) => void;
  q: string; setQ: (s: string) => void;
  queryError: { message: string; offset: number; kind: 'syntax' | 'meaning' } | null;
  readsAs: string;
  sort: Sort; setSort: (s: Sort) => void;
}

// Under the search box: what the query was read as, why text ran as plain
// text instead (with a marker under the character), or, for an empty box, three
// examples to start from. The live region stays mounted so a screen reader
// announces each new reading or error.
function QueryFeedback({ q, queryError, readsAs, setQ }: {
  q: string;
  queryError: { message: string; offset: number; kind: 'syntax' | 'meaning' } | null;
  readsAs: string;
  setQ: (s: string) => void;
}) {
  const text = q.trim();
  // Inside quotes liqe reads `\` and `"` as escapes, so escape them to keep the text as written.
  const quoted = `"${text.replace(/[\\"]/g, '\\$&')}"`;
  return (
    <>
      <div className="field-hint mt-1.5" aria-live="polite">
        {queryError && text ? (
          <>
            <pre className="m-0 overflow-x-auto font-mono text-ink">{text}{'\n'}{' '.repeat(Math.min(queryError.offset, text.length))}^</pre>
            <div className="mt-1">
              {queryError.message} — searched as plain text instead.
              {queryError.kind === 'syntax' && (
                <> To search for this text as written: <button type="button" className="border-0 bg-transparent p-0 font-mono text-ink underline" onClick={() => setQ(quoted)}>{quoted}</button></>
              )}
            </div>
          </>
        ) : readsAs ? (
          <>reads as <span className="text-ink">{readsAs}</span></>
        ) : null}
      </div>
      {!text && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="field-hint">try</span>
          {QUERY_EXAMPLES.slice(0, 3).map(ex => (
            <button key={ex.query} type="button" className="lib-chip font-mono" title={ex.want} onClick={() => setQ(ex.query)}>
              {ex.query}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function BrowseFilters(p: BrowseFiltersProps) {
  const [showAllMoods, setShowAllMoods] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const examplesId = useId();
  const ranked = useMemo(
    () => [...p.moodVocab].sort((a, b) => (p.moodCounts[b] || 0) - (p.moodCounts[a] || 0)),
    [p.moodVocab, p.moodCounts],
  );
  const shown = showAllMoods ? ranked : ranked.slice(0, 12);
  const toggleMood = (m: string) =>
    p.setMoods(p.moods.includes(m) ? p.moods.filter(x => x !== m) : [...p.moods, m]);

  const energyOpts: { id: Energy; label: ReactNode }[] = [
    { id: 'any', label: 'Any' },
    { id: 'low', label: <><EnergyMeter level="low" /> Low{p.energyCounts.low ? ` · ${p.energyCounts.low}` : ''}</> },
    { id: 'medium', label: <><EnergyMeter level="medium" /> Mid{p.energyCounts.medium ? ` · ${p.energyCounts.medium}` : ''}</> },
    { id: 'high', label: <><EnergyMeter level="high" /> High{p.energyCounts.high ? ` · ${p.energyCounts.high}` : ''}</> },
  ];

  // The vocal facet only ever narrows to analysed tracks — un-analysed rows have no
  // vocal ranges to test.
  const vocalOpts: { id: Vocal; label: string }[] = [
    { id: 'any', label: 'Any' },
    { id: 'vocal', label: 'Vocal' },
    { id: 'instrumental', label: 'Instrumental' },
  ];

  return (
    <section className="card">
      <div className="border-b border-dashed border-separator-strong p-4">
        <InputGroup>
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput
            aria-label="Search tracks"
            placeholder="search tracks, or write a query — ? for examples"
            value={p.q}
            onChange={(e: ChangeEvent<HTMLInputElement>) => p.setQ(e.target.value)}
            className="font-mono"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label="Query examples"
              aria-expanded={showExamples}
              aria-controls={examplesId}
              onClick={() => setShowExamples(v => !v)}
              className={cn('font-mono', showExamples && 'text-ink')}
            >
              ?
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <QueryFeedback q={p.q} queryError={p.queryError} readsAs={p.readsAs} setQ={p.setQ} />
        {/* Hidden, not unmounted: aria-controls must point at an element. */}
        <div id={examplesId} hidden={!showExamples} className="mt-3 border-t border-dashed border-separator-strong pt-3">
          <div className="caption mb-2">write what you want</div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {QUERY_EXAMPLES.map(ex => (
              <button
                key={ex.query}
                type="button"
                onClick={() => p.setQ(ex.query)}
                className="flex min-w-0 items-baseline justify-between gap-3 border-0 bg-transparent py-1 text-left text-[12px] text-muted hover:text-ink focus-visible:text-ink"
              >
                <span className="truncate">{ex.want}</span>
                <code className="shrink-0 font-mono text-ink">{ex.query}</code>
              </button>
            ))}
          </div>
          <div className="field-hint mt-2.5">
            fields: title artist album genre tag mood energy year bpm · <code>/regex/</code> is case-insensitive · write <code className="whitespace-nowrap">title:a OR title:b</code>, not <code className="whitespace-nowrap">title:(a OR b)</code>
          </div>
        </div>
      </div>

      <div className="border-b border-dashed border-separator-strong p-4">
        <div className="caption mb-2.5">mood</div>
        <div className="flex flex-wrap gap-1.5">
          {shown.map(m => (
            <button key={m} type="button" className={cn('lib-chip', p.moods.includes(m) && 'on')} onClick={() => toggleMood(m)}>
              {m}<span className="n">{p.moodCounts[m] || 0}</span>
            </button>
          ))}
          {ranked.length > 12 && (
            <button type="button" className="lib-chip lib-chip-more" onClick={() => setShowAllMoods(s => !s)}>
              {showAllMoods ? '− less' : `+ ${ranked.length - 12} more`}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-4 border-b border-dashed border-separator-strong p-4">
        <div className="flex flex-col gap-2">
          <div className="caption">energy</div>
          <div className="flex flex-wrap border border-ink">
            {energyOpts.map((o, i) => (
              <button
                key={o.id}
                type="button"
                onClick={() => p.setEnergy(o.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold tracking-[0.12em] uppercase',
                  i > 0 && 'border-l border-ink',
                  p.energy === o.id ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="caption">vocal</div>
          <div className="flex flex-wrap border border-ink">
            {vocalOpts.map((o, i) => (
              <button
                key={o.id}
                type="button"
                onClick={() => p.setVocal(o.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold tracking-[0.12em] uppercase',
                  i > 0 && 'border-l border-ink',
                  p.vocal === o.id ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-4 p-4">
        <div className="flex w-full flex-col gap-2 sm:w-auto">
          <Field>
            <FieldLabel htmlFor="genre">genre</FieldLabel>
            <Select value={p.genre || '__any'} onValueChange={v => p.setGenre(v === '__any' ? '' : v)}>
              <SelectTrigger id="genre" className="w-full sm:min-w-[150px]"><SelectValue placeholder="Any genre" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__any">Any genre</SelectItem>
                {p.genreList.slice(0, 80).map(g => (
                  <SelectItem key={g.value} value={g.value}>
                    {g.value}{g.songCount ? ` · ${g.songCount}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <div className="caption">year</div>
          <div className="flex items-center gap-2">
            <Input type="number" inputMode="numeric" placeholder="from" aria-label="year from" className="w-20" value={p.yearFrom} onChange={e => p.setYearFrom(e.target.value)} />
            <span className="text-[10px] text-muted">–</span>
            <Input type="number" inputMode="numeric" placeholder="to" aria-label="year to" className="w-20" value={p.yearTo} onChange={e => p.setYearTo(e.target.value)} />
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto">
          <Field>
            <FieldLabel htmlFor="sort">sort</FieldLabel>
            <Select value={p.sort} onValueChange={v => p.setSort(v as Sort)}>
              <SelectTrigger id="sort" className="w-full sm:min-w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="artist">Artist / album / title</SelectItem>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="year">Year (newest first)</SelectItem>
                <SelectItem value="taggedAt">Recently tagged</SelectItem>
                <SelectItem value="bpm">Tempo (slow → fast)</SelectItem>
                <SelectItem value="loudness">Loudness (loud → quiet)</SelectItem>
                <SelectItem value="pace">Pace (intense → calm)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
    </section>
  );
}

