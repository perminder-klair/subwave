'use client';


import { useRef } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { Pill, MetaChip } from '../ui';
import { cn } from '../../../lib/cn';
import { SHOW_COLORS } from '../schedule/lib';
import type { Persona, Show } from './types';
import { joinNames, showFacets } from './lib';
import { ShowAvatar } from './ShowAvatar';

interface ShowDefRowProps {
  show: Show;
  index: number;
  ok: boolean;
  hrs: number;
  host: Persona | null;
  guests: Persona[];
  apiBase: string;
  onEdit: () => void;
}

// One show as a "broadcast slate". The whole card is the edit target; Remove lives
// inside the editor.
export function ShowDefRow({ show: s, index: i, ok, hrs, host, guests, apiBase, onEdit }: ShowDefRowProps) {
  const spineRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(spineRef, { background: SHOW_COLORS[i % SHOW_COLORS.length] ?? '#000' });

  const hostName = host?.name?.trim() || (s.personaId ? 'Unnamed' : '');
  const guestNames = guests.map(g => g.name?.trim() || 'Unnamed');
  const skillPin = s.programme && s.segmentSkill ? s.segmentSkill : '';

  const facets = showFacets(s);

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Edit ${s.name.trim() || 'untitled show'}`}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); }
      }}
      className={cn(
        'group card relative cursor-pointer transition-colors hover:bg-[var(--ink-softer)]',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]',
      )}
    >
      <span
        ref={spineRef}
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1 transition-[width] group-hover:w-1.5"
      />

      <div className="card-body flex gap-3.5">
        <div className="flex flex-none flex-col items-center">
          <ShowAvatar persona={host} apiBase={apiBase} size="lg" />
          {guests.length > 0 && (
            <div className="mt-1 flex">
              {guests.map((g, gi) => (
                <ShowAvatar
                  key={g.id}
                  persona={g}
                  apiBase={apiBase}
                  size="sm"
                  className={cn('ring-2 ring-[var(--card-bg)]', gi > 0 && '-ml-2')}
                />
              ))}
            </div>
          )}
        </div>

        <div className="grid min-w-0 flex-1 gap-2.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              {(s.programme || (s.banter && guests.length > 0)) && (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {s.programme && (
                    <Pill tone="solid" dot>
                      Programme{skillPin ? ` · ${skillPin}` : ''}
                    </Pill>
                  )}
                  {s.banter && guests.length > 0 && <Pill>Banter</Pill>}
                </div>
              )}
              <div className="truncate text-[17px] font-extrabold tracking-[-0.01em] text-ink">
                {s.name.trim() || 'untitled'}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-muted">
                {host
                  ? <>host · <span className="font-semibold text-ink">{hostName}</span></>
                  : <span className="text-[var(--danger)]">no persona set</span>}
                {guests.length > 0 && <> · with {joinNames(guestNames)}</>}
              </div>
            </div>

            <div className="flex flex-none flex-col items-end gap-1.5 text-right">
              {!ok && <Pill tone="accent">incomplete</Pill>}
              {hrs > 0 ? (
                <div className="leading-none">
                  <span className="mono-num text-[20px] font-extrabold text-ink">{hrs}</span>
                  <span className="caption ml-1">h / wk</span>
                </div>
              ) : (
                <span className="caption">unscheduled</span>
              )}
              <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.16em] text-muted uppercase transition-colors group-hover:text-vermilion">
                Edit <span aria-hidden="true">→</span>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
            {facets.map(f => (
              <MetaChip key={f.key} accent={f.accent}>{f.label}</MetaChip>
            ))}
          </div>

          {s.topic.trim() && (
            <p className="line-clamp-2 text-[12px] leading-[1.55] text-muted italic">
              {s.topic.trim()}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

