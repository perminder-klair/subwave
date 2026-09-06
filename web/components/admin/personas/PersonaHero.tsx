'use client';
import type { Persona, SettingsResponse } from './types';
import { engineLabel } from './helpers';
import { Eyebrow } from '../ui';

interface PersonaHeroProps {
  // What the live strip describes; distinct from the default below.
  onAirPersona: Persona | undefined;
  // Shown only when a show has overridden it, so the operator can see who would be
  // on air without the show.
  defaultPersona: Persona | undefined;
  // The show reassigning the hour, or null when the default is on air.
  onAirShow: { id: string; name: string } | null;
  defaultEngine: string;
  onAirCloudIssue: string | null;
  // Needed only so engineLabel can resolve a persona on the station default.
  data: SettingsResponse | null;
}

export function PersonaHero({
  onAirPersona, defaultPersona, onAirShow, defaultEngine, onAirCloudIssue, data,
}: PersonaHeroProps) {
  const overridden = !!onAirShow && defaultPersona?.id !== onAirPersona?.id;
  return (
    <section className="card">
      <div className="border-b border-ink p-4">
        <Eyebrow className="text-vermilion">personas</Eyebrow>
        <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
          The voices on your station.
        </div>
        <div className="mt-1 text-[11px] leading-[1.6] text-muted">
          One persona is on air at a time. A scheduled show can hand the hour to a different one.
          Every change applies live; no mixer restart.
        </div>
      </div>

      {/* Describes the persona actually broadcasting now, which
          a scheduled show can make different from the default selection. */}
      <div className="flex flex-wrap items-center gap-3 bg-[var(--ink-softer)] p-3.5">
        <span className="caption text-vermilion">● on air</span>
        <span className="text-[13px] font-bold">
          {onAirPersona ? (onAirPersona.name.trim() || 'Persona') : '—'}
        </span>
        {onAirPersona?.tagline.trim() && (
          <span className="text-[11px] text-muted">— {onAirPersona.tagline.trim()}</span>
        )}
        {/* The extra gap is a desktop separator between the name block and the
            settings block; on a phone this chip starts a wrapped line, where a
            leading indent just reads as a misalignment. */}
        <span className="caption sm:ml-4">
          frequency · {onAirPersona ? onAirPersona.frequency : '—'}
        </span>
        <span className="caption">voice · {onAirPersona ? engineLabel(onAirPersona, data) : '—'}</span>
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
