'use client';
// Hero header + live/active strip for /admin/personas.
import type { Persona } from './types';
import { PERSONA_MAX } from './constants';
import { engineLabel } from './helpers';
import { Btn, Eyebrow } from '../ui';

interface PersonaHeroProps {
  activePersona: Persona | undefined;
  defaultEngine: string;
  activeCloudIssue: string | null;
  personaCount: number;
  showPrompt: boolean;
  onTogglePrompt: () => void;
  onAdd: () => void;
}

export function PersonaHero({
  activePersona, defaultEngine, activeCloudIssue, personaCount, showPrompt, onTogglePrompt, onAdd,
}: PersonaHeroProps) {
  return (
    <section className="card">
      <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-4 border-b border-ink p-4">
        <div>
          <Eyebrow className="text-vermilion">personas</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            The voices on your station.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            One persona is on air at a time. A scheduled show can hand the hour to a different one.
            Every change applies live; no mixer restart.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={onTogglePrompt}>
            {showPrompt ? 'Hide system prompt' : 'System prompt'}
          </Btn>
          <Btn tone="accent" onClick={onAdd} disabled={personaCount >= PERSONA_MAX}>
            + Add persona
          </Btn>
        </div>
      </div>

      {/* Active strip */}
      <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
        <span className="caption text-vermilion">● live</span>
        <span className="text-[13px] font-bold">
          {activePersona ? (activePersona.name.trim() || 'Persona') : '—'}
        </span>
        {activePersona?.tagline.trim() && (
          <span className="text-[11px] text-muted">— {activePersona.tagline.trim()}</span>
        )}
        <span className="caption ml-4">
          frequency · {activePersona ? activePersona.frequency : '—'}
        </span>
        <span className="caption">voice · {activePersona ? engineLabel(activePersona) : '—'}</span>
        {activeCloudIssue && (
          <span className="caption text-[var(--danger)]">
            ⚠ cloud voice inactive, speaking via {defaultEngine}
          </span>
        )}
        <span className="caption">override · — (a scheduled show may reassign the hour)</span>
      </div>
    </section>
  );
}
