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
  return (
    <Card flat title="Skills" sub="autonomous segments this persona runs">
      <p className="mb-2.5 max-w-[70ch] text-[12px] leading-[1.6] text-muted">
        When this persona is on air, only the skills ticked here can fire. A skill must
        also be enabled station-wide on the <strong>Skills</strong> page.
      </p>
      {skillCatalog.length === 0 ? (
        <span className="text-[12px] text-muted">No skills available</span>
      ) : (
        <div className="grid gap-x-8 sm:grid-cols-2">
          {skillCatalog.map(s => {
            const on = persona.skills.includes(s.name);
            return (
              <div
                key={s.name}
                className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-dashed border-separator-strong py-3"
              >
                <div>
                  <div className="text-[13px] font-bold">{s.label || s.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted">
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
