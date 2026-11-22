import { handle, isGithubHandle, prettyDate } from './kit';
import s from './community.module.css';

// "by @login · added 1 Sep 2026 · updated …": the provenance line every
// community entry carries. Fields are optional (hand-added entries predate the
// submission workflow), so an entry with none renders nothing.
export default function Credit({
  by,
  added,
  modified,
  linkHandle = true,
  className,
}: {
  by?: string;
  added?: string;
  modified?: string;
  /** False when `by` may be a plain name rather than a GitHub login (/apps). */
  linkHandle?: boolean;
  className?: string;
}) {
  const who = handle(by);
  if (!who && !added) return null;
  const updated = added && modified && modified !== added ? modified : undefined;
  return (
    <p className={`${s.credit} ${className ?? ''}`}>
      {who && (
        <span>
          by{' '}
          {linkHandle && isGithubHandle(who) ? (
            <a href={`https://github.com/${who}`} target="_blank" rel="noreferrer" className={s.creditLink}>
              @{who}
            </a>
          ) : (
            <strong>{who}</strong>
          )}
        </span>
      )}
      {added && <span>added {prettyDate(added)}</span>}
      {updated && <span>updated {prettyDate(updated)}</span>}
    </p>
  );
}
