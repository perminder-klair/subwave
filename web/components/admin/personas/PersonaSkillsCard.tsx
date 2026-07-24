'use client';
// Per-persona skill toggles — which autonomous segments may fire when this
// persona is on air.
import type { Persona, SkillCatalogEntry } from './types';
import { Card, Toggle } from '../ui';

interface PersonaSkillsCardProps {
  persona: Persona;
  skillCatalog: SkillCatalogEntry[];
  setSkills: (skills: string[]) => void;
}

export function PersonaSkillsCard({ persona, skillCatalog, setSkills }: PersonaSkillsCardProps) {
  // Skills switched off station-wide can never fire regardless of the ticks
  // here, so listing them only invites toggles that do nothing. Older
  // controllers omit `enabled` — treat absent as on.
  const enabledSkills = skillCatalog.filter(s => s.enabled !== false);
  return (
    <Card flat title="Skills" sub="autonomous segments this persona runs">
      <p className="mb-2.5 max-w-[70ch] text-[12px] leading-[1.6] text-muted">
        When this persona is on air, only the skills ticked here can fire. Skills
        disabled station-wide on the <strong>Skills</strong> page are not listed.
      </p>
      {enabledSkills.length === 0 ? (
        <span className="text-[12px] text-muted">
          No skills enabled station-wide — enable some on the Skills page first
        </span>
      ) : (
        <div className="grid gap-x-8 sm:grid-cols-2">
          {enabledSkills.map(s => {
            const on = persona.skills.includes(s.name);
            return (
              <div
                key={s.name}
                className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-dashed border-separator-strong py-3"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-bold">{s.label || s.name}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-muted" title={s.description || ''}>
                    {s.description}
                  </div>
                </div>
                <Toggle
                  on={on}
                  onClick={() => setSkills(
                    on
                      ? persona.skills.filter(n => n !== s.name)
                      : [...persona.skills, s.name],
                  )}
                  ariaLabel={`Allow ${s.label || s.name}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
