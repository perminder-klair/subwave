'use client';
// Persona roster — a list of "broadcast slate" cards (one per persona), matching
// the show cards on /admin/shows: an avatar, a status-keyed colour spine, mode
// kickers (on air / default), a bold name, the skill count as a metric, a
// scannable facet-chip row, and the tagline as a brief. The whole card is the
// edit target (the "click a persona to open it" pattern); adding lives in the
// hero's "+ Add persona" button.
import { Users } from 'lucide-react';
import type { Persona } from './types';
import { API_BASE, PERSONA_MAX } from './constants';
import { initialsFor, personaValid } from './helpers';
import { cn } from '../../../lib/cn';
import { useRosterView } from '../../../lib/adminView';
import { Btn, Pill, MetaChip, Seg } from '../ui';
import PersonaTable from './PersonaTable';

interface PersonaRosterProps {
  personas: Persona[];
  // The admin-selected default — gets the "default" pill.
  activePersonaId: string;
  // The persona actually broadcasting now (show override aware) — gets the
  // "on air" pill. Equals activePersonaId unless a show overrides.
  onAirPersonaId: string;
  avatarTick: number;
  // Opens the system-prompt library modal.
  onOpenPrompt: () => void;
  onAdd: () => void;
  onSelect: (idx: number) => void;
  // Shipped community catalog size (null = still loading — button disabled).
  communityCount: number | null;
  onCommunity: () => void;
}

export function PersonaRoster({
  personas, activePersonaId, onAirPersonaId, avatarTick,
  onOpenPrompt, onAdd, onSelect, communityCount, onCommunity,
}: PersonaRosterProps) {
  // Cards (default) or a dense table. Remembered per surface in localStorage.
  const [view, setView] = useRosterView('personas');

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="caption">roster · {personas.length} / {PERSONA_MAX}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            value={view}
            options={[{ id: 'cards', label: 'Cards' }, { id: 'list', label: 'List' }]}
            onChange={v => setView(v === 'list' ? 'list' : 'cards')}
          />
          <Btn
            onClick={onCommunity}
            disabled={communityCount === null}
            title="Browse and install personas shared by other stations"
          >
            <Users size={14} /> Community
            {communityCount !== null && communityCount > 0 && (
              <span className="ml-1 text-vermilion">{communityCount}</span>
            )}
          </Btn>
          <Btn onClick={onOpenPrompt}>System prompt</Btn>
          <Btn tone="accent" onClick={onAdd} disabled={personas.length >= PERSONA_MAX}>
            + Add persona
          </Btn>
        </div>
      </div>
      {view === 'list' && personas.length > 0 && (
        <PersonaTable
          personas={personas}
          activePersonaId={activePersonaId}
          onAirPersonaId={onAirPersonaId}
          avatarTick={avatarTick}
          onSelect={onSelect}
        />
      )}

      {view === 'cards' && personas.map((p, i) => {
        const isOnAir = p.id === onAirPersonaId;
        const isDefault = p.id === activePersonaId;
        const valid = personaValid(p);
        const src = p.avatar
          ? `${API_BASE}/persona-avatar/${encodeURIComponent(p.id)}?v=${avatarTick}`
          : null;
        const nSkills = p.skills.length;
        // Spine keyed to status — on air wins, then default, then incomplete,
        // then a plain hairline. The colour means something at a glance.
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
            aria-label={`Edit ${p.name.trim() || `Persona ${i + 1}`}`}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); }
            }}
            className={cn(
              'group card relative cursor-pointer transition-colors hover:bg-[var(--ink-softer)]',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]',
            )}
          >
            {/* status spine */}
            <span
              aria-hidden="true"
              className={cn('absolute inset-y-0 left-0 w-1 transition-[width] group-hover:w-1.5', spine)}
            />

            <div className="card-body flex gap-3.5">
              {/* avatar — initials sit behind the image so a missing / broken
                  avatar still shows a readable placeholder */}
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
                {/* text stack — kicker + name, facets, brief stack tightly */}
                <div className="grid min-w-0 flex-1 gap-2.5">
                  {/* kicker + name */}
                  <div className="min-w-0">
                    {(isOnAir || isDefault) && (
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        {isOnAir && <Pill tone="accent" dot>on air</Pill>}
                        {isDefault && !isOnAir && <Pill>default</Pill>}
                      </div>
                    )}
                    <div className="truncate text-[17px] font-extrabold tracking-[-0.01em] text-ink">
                      {p.name.trim() || `Persona ${i + 1}`}
                    </div>
                  </div>

                  {/* facets — how this persona sounds */}
                  <div className="flex flex-wrap gap-1">
                    <MetaChip>{p.frequency}</MetaChip>
                    {p.scriptLength !== 'concise' && <MetaChip>{p.scriptLength}</MetaChip>}
                    <MetaChip>{p.tts.engine}</MetaChip>
                    {p.tts.engine !== 'piper' && p.tts.voice.trim() && (
                      <MetaChip className="max-w-[140px] truncate">{p.tts.voice.trim()}</MetaChip>
                    )}
                  </div>

                  {/* brief */}
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
