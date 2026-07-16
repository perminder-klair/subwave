import type { CommunityShow, EraWindow } from '@/lib/communityShows';

// Render an era window as a compact label: "1988–1996", a single year when the
// bounds match, or an open-ended "1988–" / "–1996" when one side is null.
function formatEra({ fromYear, toYear }: EraWindow): string | null {
  if (fromYear == null && toYear == null) return null;
  if (fromYear != null && toYear != null) {
    return fromYear === toYear ? String(fromYear) : `${fromYear}–${toYear}`;
  }
  if (fromYear != null) return `${fromYear}–`;
  return `–${toYear}`;
}

// One card in the /shows showcase grid. Browse-only: it presents a community
// show's brief and music filters — installation happens in a station's admin
// console, not here. Reuses the bs-skill-* broadsheet card styles from the
// /skills + /personas showcases; the content shape is near-identical.
export default function CommunityShowCard({ show }: { show: CommunityShow }) {
  // Music-steering filters, rendered as small tags. Only the populated ones
  // show, so a loosely-scoped show wears a clean card and a tightly-tuned one
  // wears its filters.
  const filters: string[] = [
    ...show.moods,
    ...show.genres,
    ...show.energies,
    ...show.eras.map(formatEra).filter((e): e is string => Boolean(e)),
  ];

  // Mode badges — only the on flags, matching the tag styling.
  const modes: string[] = [];
  if (show.programme) modes.push('produced');
  if (show.banter) modes.push('banter');

  return (
    <li className="bs-skill-card">
      <div className="bs-skill-head">
        <h3 className="bs-skill-name">{show.name}</h3>
        {show.filtersStrict && <span className="bs-skill-cadence">strict filters</span>}
      </div>

      <p className="bs-skill-brief">{show.topic}</p>

      {filters.length > 0 && (
        <ul className="bs-skill-tags" aria-label="Music filters">
          {filters.map((f) => (
            <li key={f} className="bs-skill-tag">
              {f}
            </li>
          ))}
        </ul>
      )}

      {modes.length > 0 && (
        <ul className="bs-skill-tags" aria-label="Modes">
          {modes.map((m) => (
            <li key={m} className="bs-skill-tag">
              {m}
            </li>
          ))}
        </ul>
      )}

      {(show.submittedBy || show.dateAdded) && (
        <p className="bs-skill-credit">
          {show.submittedBy && (
            <>
              by{' '}
              <a
                href={`https://github.com/${show.submittedBy}`}
                target="_blank"
                rel="noreferrer"
                className="bs-skill-credit-link"
              >
                @{show.submittedBy}
              </a>
            </>
          )}
          {show.submittedBy && show.dateAdded && ' · '}
          {show.dateAdded && <>added {show.dateAdded}</>}
          {show.dateAdded && show.dateModified && show.dateModified !== show.dateAdded && (
            <> · updated {show.dateModified}</>
          )}
        </p>
      )}
    </li>
  );
}
