import CatalogBrief from '@/components/ui/catalog-brief';
import type { CommunitySkill } from '@/lib/communitySkills';
import { feedHost } from '@/lib/feed-host';

// One card in the /skills showcase grid. Browse-only: it presents a community
// skill's brief and provenance — installation happens in a station's admin
// console, not here. Mirrors the admin community-modal entry (SkillsPanel) but
// styled for the public broadsheet.
export default function CommunitySkillCard({ skill }: { skill: CommunitySkill }) {
  const contexts = (skill.context || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const source = feedHost(skill.feed);

  return (
    <li className="bs-skill-card">
      <div className="bs-skill-head">
        <h3 className="bs-skill-name">{skill.label}</h3>
        {skill.cooldown && <span className="bs-skill-cadence">{skill.cooldown} cooldown</span>}
      </div>

      <CatalogBrief text={skill.brief} />

      {source && <p className="bs-skill-credit">reads {source} before it speaks</p>}

      {contexts.length > 0 && (
        <ul className="bs-skill-tags" aria-label="Uses live context">
          {contexts.map((c) => (
            <li key={c} className="bs-skill-tag">
              {c}
            </li>
          ))}
        </ul>
      )}

      {(skill.submittedBy || skill.dateAdded) && (
        <p className="bs-skill-credit">
          {skill.submittedBy && (
            <>
              by{' '}
              <a
                href={`https://github.com/${skill.submittedBy}`}
                target="_blank"
                rel="noreferrer"
                className="bs-skill-credit-link"
              >
                @{skill.submittedBy}
              </a>
            </>
          )}
          {skill.submittedBy && skill.dateAdded && ' · '}
          {skill.dateAdded && <>added {skill.dateAdded}</>}
          {skill.dateAdded && skill.dateModified && skill.dateModified !== skill.dateAdded && (
            <> · updated {skill.dateModified}</>
          )}
        </p>
      )}
    </li>
  );
}
