'use client';
// Full-width selectable roster — sits below the hero. A responsive grid of
// persona cards (avatar + name + tagline + badges) that wraps as personas are
// added; click a card to edit it in the full-width editor below. The last cell
// is a dashed "+ new persona" add card.
import type { Persona } from './types';
import { API_BASE, PERSONA_MAX } from './constants';
import { initialsFor, personaValid } from './helpers';
import { Pill } from '../ui';
import { cn } from '../../../lib/cn';

interface PersonaRosterProps {
  personas: Persona[];
  // The admin-selected default — gets the "default" pill.
  activePersonaId: string;
  // The persona actually broadcasting now (show override aware) — gets the
  // accent dot + "on air" pill. Equals activePersonaId unless a show overrides.
  onAirPersonaId: string;
  focusedIdx: number;
  avatarTick: number;
  onSelect: (idx: number) => void;
  onAdd: () => void;
}

export function PersonaRoster({
  personas, activePersonaId, onAirPersonaId, focusedIdx, avatarTick, onSelect, onAdd,
}: PersonaRosterProps) {
  const atMax = personas.length >= PERSONA_MAX;
  return (
    <section className="grid gap-2.5">
      <span className="caption">roster · {personas.length} / {PERSONA_MAX}</span>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {personas.map((p, i) => {
          const isOnAir = p.id === onAirPersonaId;
          const isDefault = p.id === activePersonaId;
          const isFocused = i === focusedIdx;
          const valid = personaValid(p);
          const src = p.avatar
            ? `${API_BASE}/persona-avatar/${encodeURIComponent(p.id)}?v=${avatarTick}`
            : null;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={isFocused}
              className={cn(
                'grid min-w-0 cursor-pointer content-start gap-2 border p-3 text-left font-[inherit]',
                isFocused
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-ink bg-[var(--card-bg)]',
              )}
            >
              <div className="flex min-w-0 items-start gap-2.5">
                {/* Initials sit behind the image so a missing / transparent /
                    broken avatar still shows a readable placeholder. */}
                <span className="relative grid size-10 flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]">
                  <span className="text-[12px] font-extrabold text-muted">{initialsFor(p.name)}</span>
                  {src && (
                    <img
                      src={src}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={e => { e.currentTarget.style.visibility = 'hidden'; }}
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {isOnAir && <span className="size-1.5 flex-none rounded-full bg-[var(--accent)]" />}
                    <span className="min-w-0 truncate text-[14px] font-extrabold tracking-[-0.01em] text-ink">
                      {p.name.trim() || `Persona ${i + 1}`}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {p.tagline.trim() || 'no tagline'}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {isOnAir && <Pill tone="accent" className="text-[8px]">on air</Pill>}
                {isDefault && !isOnAir && <Pill className="text-[8px]">default</Pill>}
                <Pill className="text-[8px]">{p.frequency}</Pill>
                {p.scriptLength === 'extended' && <Pill className="text-[8px]">extended</Pill>}
                <Pill className="text-[8px]">{p.tts.engine}</Pill>
                {p.tts.engine !== 'piper' && p.tts.voice.trim() && (
                  <Pill className="max-w-[120px] truncate text-[8px]">{p.tts.voice.trim()}</Pill>
                )}
                <Pill className="text-[8px]">
                  {p.skills.length} skill{p.skills.length === 1 ? '' : 's'}
                </Pill>
                {!valid && (
                  <Pill className="border-[var(--danger)] text-[8px] text-[var(--danger)]">incomplete</Pill>
                )}
              </div>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          disabled={atMax}
          className={cn(
            'grid min-h-[88px] place-items-center border border-dashed border-muted bg-transparent p-3 font-[inherit] text-[11px] font-bold tracking-[0.18em] text-muted uppercase',
            atMax ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
          )}
        >
          {atMax ? `maximum ${PERSONA_MAX}` : '+ new persona'}
        </button>
      </div>
    </section>
  );
}
