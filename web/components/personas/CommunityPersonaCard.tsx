import type { CommunityPersona } from '@/lib/communityPersonas';

// One card in the /personas showcase grid. Browse-only: it presents a
// community persona's soul and provenance — installation happens in a
// station's admin console, not here. Reuses the bs-skill-* broadsheet card
// styles from the /skills showcase; the content shape is near-identical.
export default function CommunityPersonaCard({ persona }: { persona: CommunityPersona }) {
  // Behaviour tags — only the non-default knobs, so a plain persona shows a
  // clean card and a characterful one wears its settings.
  const tags: string[] = [];
  if (persona.frequency !== 'moderate') tags.push(persona.frequency);
  if (persona.scriptLength !== 'concise') tags.push(persona.scriptLength);
  if (persona.djMode) tags.push('dj mode');
  if (persona.language) tags.push(persona.language);

  return (
    <li className="bs-skill-card">
      <div className="bs-skill-head">
        <h3 className="bs-skill-name">{persona.displayName}</h3>
      </div>

      {persona.tagline && <p className="bs-skill-cadence">{persona.tagline}</p>}

      <p className="bs-skill-brief">{persona.soul}</p>

      {tags.length > 0 && (
        <ul className="bs-skill-tags" aria-label="Behaviour">
          {tags.map((t) => (
            <li key={t} className="bs-skill-tag">
              {t}
            </li>
          ))}
        </ul>
      )}

      {(persona.submittedBy || persona.dateAdded) && (
        <p className="bs-skill-credit">
          {persona.submittedBy && (
            <>
              by{' '}
              <a
                href={`https://github.com/${persona.submittedBy}`}
                target="_blank"
                rel="noreferrer"
                className="bs-skill-credit-link"
              >
                @{persona.submittedBy}
              </a>
            </>
          )}
          {persona.submittedBy && persona.dateAdded && ' · '}
          {persona.dateAdded && <>added {persona.dateAdded}</>}
          {persona.dateAdded && persona.dateModified && persona.dateModified !== persona.dateAdded && (
            <> · updated {persona.dateModified}</>
          )}
        </p>
      )}
    </li>
  );
}
