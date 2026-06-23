'use client';
// Hero header + live/active strip for /admin/personas.
import type { Persona } from './types';
import { PERSONA_MAX } from './constants';
import { engineLabel } from './helpers';
import { Btn, Eyebrow } from '../ui';

interface PersonaHeroProps {
  // The persona actually broadcasting (show override aware) — what the live
  // strip describes. Distinct from the default below.
  onAirPersona: Persona | undefined;
  // The admin-selected default — shown only when a show has overridden it, so
  // the operator can see who'd be on air without the show.
  defaultPersona: Persona | undefined;
  // The show reassigning the hour, or null when the default is on air.
  onAirShow: { id: string; name: string } | null;
  defaultEngine: string;
  onAirCloudIssue: string | null;
  personaCount: number;
  showPrompt: boolean;
  onTogglePrompt: () => void;
  onAdd: () => void;
}

export function PersonaHero({
  onAirPersona, defaultPersona, onAirShow, defaultEngine, onAirCloudIssue,
  personaCount, showPrompt, onTogglePrompt, onAdd,
}: PersonaHeroProps) {
  const overridden = !!onAirShow && defaultPersona?.id !== onAirPersona?.id;
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

      {/* On-air strip — describes the persona actually broadcasting now, which
          a scheduled show can make different from the default selection. */}
      <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
        <span className="caption text-vermilion">● on air</span>
        <span className="text-[13px] font-bold">
          {onAirPersona ? (onAirPersona.name.trim() || 'Persona') : '—'}
        </span>
        {onAirPersona?.tagline.trim() && (
          <span className="text-[11px] text-muted">— {onAirPersona.tagline.trim()}</span>
        )}
        <span className="caption ml-4">
          frequency · {onAirPersona ? onAirPersona.frequency : '—'}
        </span>
        <span className="caption">voice · {onAirPersona ? engineLabel(onAirPersona) : '—'}</span>
        {onAirCloudIssue && (
          <span className="caption text-[var(--danger)]">
            ⚠ cloud voice inactive, speaking via {defaultEngine}
          </span>
        )}
        <span className="caption">
          {overridden
            ? `override · “${onAirShow!.name}” owns this hour · default ${defaultPersona ? (defaultPersona.name.trim() || 'Persona') : '—'}`
            : 'override · none · default persona on air'}
        </span>
      </div>
    </section>
  );
}
