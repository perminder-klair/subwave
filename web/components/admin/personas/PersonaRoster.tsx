'use client';
// One "broadcast slate" card per persona, matching the show cards on /admin/shows.
// The whole card is the edit target; adding lives in the hero's "+ Add persona".
import { Users } from 'lucide-react';
import { API_BASE, PERSONA_MAX } from './constants';
import { initialsFor } from './helpers';
import type { PersonaRosterEntry, PersonaSort } from './roster-order';
import { PERSONA_SORTS, PERSONA_SORT_LABELS } from './roster-order';
import { cn } from '../../../lib/cn';
import { useRosterView } from '../../../lib/adminView';
import { Btn, Pill, MetaChip } from '../ui';
import PersonaTable from './PersonaTable';
import RosterViewToggle from '../RosterViewToggle';
import RosterToolbar from '../RosterToolbar';

interface PersonaRosterProps {
  // Already in display order — the panel owns the ordering so the editor's
  // "n of m" counter can name the same position the operator clicked.
  roster: PersonaRosterEntry[];
  /** The roster BEFORE filtering — the "n of m" count and the cap read this,
   *  so a filtered view never reports the station as having fewer DJs. */
  total: number;
  sort: PersonaSort;
  onSortChange: (v: PersonaSort) => void;
  query: string;
  onQueryChange: (v: string) => void;
  /** Every tag in use across the roster. */
  tags: string[];
  selectedTags: string[];
  onTagsChange: (next: string[]) => void;
  filtered: boolean;
  onClearFilters: () => void;
  // The admin-selected default — gets the "default" pill.
  activePersonaId: string;
  // Equals activePersonaId unless a show overrides it.
  onAirPersonaId: string;
  avatarTick: number;
  // Sourced from the RHF form's own formState.errors.personas — the schema's
  // answer, not a local reimplementation of it.
  isPersonaInvalid: (idx: number) => boolean;
  // Opens the system-prompt library modal.
  onOpenPrompt: () => void;
  onAdd: () => void;
  onSelect: (idx: number) => void;
  // null = still loading, button disabled.
  communityCount: number | null;
  onCommunity: () => void;
}

export function PersonaRoster({
  roster, total, sort, onSortChange, query, onQueryChange,
  tags, selectedTags, onTagsChange, filtered, onClearFilters,
  activePersonaId, onAirPersonaId, avatarTick, isPersonaInvalid,
  onOpenPrompt, onAdd, onSelect, communityCount, onCommunity,
}: PersonaRosterProps) {
  // Cards (default) or a dense table. Remembered per surface in localStorage.
  const [view, setView] = useRosterView('personas');

  return (
    <section className="grid gap-4">
      {/* On phones the actions take a full row of their own under the count:
          squeezed onto the count's line they run past the right edge. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="caption">
          roster · {total} / {PERSONA_MAX} · on air first · then {PERSONA_SORT_LABELS[sort].toLowerCase()}
        </span>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {/* Below the toolbar's threshold this is the only view toggle on the
              page, so it stays here rather than moving into a bar that isn't
              rendered. */}
          {total <= 5 && <RosterViewToggle view={view} onChange={setView} />}
          <Btn
            className="min-h-9 sm:min-h-0"
            onClick={onCommunity}
            disabled={communityCount === null}
            title="Browse and install personas shared by other stations"
          >
            <Users size={14} /> Community
            {communityCount !== null && communityCount > 0 && (
              <span className="ml-1 text-vermilion">{communityCount}</span>
            )}
          </Btn>
          <Btn className="min-h-9 sm:min-h-0" onClick={onOpenPrompt}>System prompt</Btn>
          <Btn className="min-h-9 sm:min-h-0" tone="accent" onClick={onAdd} disabled={total >= PERSONA_MAX}>
            + Add persona
          </Btn>
        </div>
      </div>
      {/* Hidden on a small roster: a filter bar over four cards is furniture,
          and the roster this exists for is the eleven-DJ one. */}
      {total > 5 && (
        <RosterToolbar<PersonaSort>
          query={query}
          onQueryChange={onQueryChange}
          noun="DJs"
          sort={sort}
          onSortChange={onSortChange}
          sortOptions={PERSONA_SORTS.map(k => [k, PERSONA_SORT_LABELS[k]] as const)}
          tags={tags}
          selectedTags={selectedTags}
          onTagsChange={onTagsChange}
          filtered={filtered}
          onClear={onClearFilters}
          view={view}
          onViewChange={setView}
          summary={filtered ? `${roster.length} of ${total}` : undefined}
        />
      )}

      {total > 0 && roster.length === 0 && (
        <div className="card card-body text-[13px] text-muted">
          No DJs match the current filters.{' '}
          <button type="button" className="font-bold text-vermilion underline" onClick={onClearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {view === 'list' && roster.length > 0 && (
        <PersonaTable
          entries={roster}
          activePersonaId={activePersonaId}
          onAirPersonaId={onAirPersonaId}
          avatarTick={avatarTick}
          isPersonaInvalid={isPersonaInvalid}
          onSelect={onSelect}
        />
      )}

      {view === 'cards' && roster.map(({ persona: p, index: i, position }) => {
        const isOnAir = p.id === onAirPersonaId;
        const isDefault = p.id === activePersonaId;
        const valid = !isPersonaInvalid(i);
        const src = p.avatar
          ? `${API_BASE}/persona-avatar/${encodeURIComponent(p.id)}?v=${avatarTick}`
          : null;
        const nSkills = p.skills.length;
        // On air wins, then default, then incomplete, then a plain hairline.
        const spine = isOnAir
          ? 'bg-[var(--accent)]'
          : isDefault
            ? 'bg-ink'
            : !valid
              ? 'bg-[var(--danger)]'
              : 'bg-separator-strong';
        return (
          <article
            key={p.id}
            role="button"
            tabIndex={0}
            aria-label={`Edit ${p.name.trim() || `Persona ${position}`}`}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); }
            }}
            className={cn(
              'group card relative cursor-pointer transition-colors hover:bg-[var(--ink-softer)]',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]',
              isOnAir && roster.length > 1 && 'mb-1',
            )}
          >
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-1 transition-[width] group-hover:w-1.5', spine)}
            />

            <div className="card-body flex gap-3.5">
              {/* Initials sit behind the image so a broken avatar still shows a
                  readable placeholder. */}
              <span className="relative grid size-12 flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]">
                <span className="text-[13px] font-extrabold text-muted">{initialsFor(p.name)}</span>
                {src && (
                  <img
                    src={src}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={e => { e.currentTarget.style.visibility = 'hidden'; }}
                  />
                )}
              </span>

              {/* body — text stack + right rail as siblings, so the taller rail
                  never inflates the name row and pushes the facets down */}
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="grid min-w-0 flex-1 gap-2.5">
                  <div className="min-w-0">
                    {(isOnAir || isDefault) && (
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        {isOnAir && <Pill tone="accent" dot>on air</Pill>}
                        {isDefault && !isOnAir && <Pill>default</Pill>}
                      </div>
                    )}
                    <div className="truncate text-[17px] font-extrabold tracking-[-0.01em] text-ink">
                      {p.name.trim() || `Persona ${position}`}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {(p.tags || []).map(t => (
                      <MetaChip key={`tag-${t}`} accent>#{t}</MetaChip>
                    ))}
                    <MetaChip>{p.frequency}</MetaChip>
                    {p.scriptLength !== 'concise' && <MetaChip>{p.scriptLength}</MetaChip>}
                    <MetaChip>{p.tts.engine}</MetaChip>
                    {p.tts.engine !== 'piper' && p.tts.voice.trim() && (
                      <MetaChip className="max-w-[140px] truncate">{p.tts.voice.trim()}</MetaChip>
                    )}
                  </div>

                  <p className="line-clamp-2 text-[12px] leading-[1.55] text-muted italic">
                    {p.tagline.trim() || 'no tagline'}
                  </p>
                </div>

                {/* right rail — status, skill count, edit affordance */}
                <div className="flex flex-none flex-col items-end gap-1.5 text-right">
                  {!valid && (
                    <Pill className="border-[var(--danger)] text-[var(--danger)]">incomplete</Pill>
                  )}
                  <div className="leading-none">
                    <span className="mono-num text-[20px] font-extrabold text-ink">{nSkills}</span>
                    <span className="caption ml-1">skill{nSkills === 1 ? '' : 's'}</span>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.16em] text-muted uppercase transition-colors group-hover:text-vermilion">
                    Edit <span aria-hidden="true">→</span>
                  </span>
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}
