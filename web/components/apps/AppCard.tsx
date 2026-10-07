import Image from 'next/image';
import CatalogBrief from '@/components/ui/catalog-brief';
import { APP_TYPE_LABELS, type CommunityApp } from '@/lib/apps';

// Images are optional and host-allowlisted. AppTypeFilter uses data-type for CSS filtering without client rendering.

// Screenshots are decorative — the name and description carry the meaning, and
// a submitter-written alt would be another untrusted string on the page.
const PLATE_SIZES = '(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 360px';

export default function AppCard({ app }: { app: CommunityApp }) {
  const handle = app.author?.startsWith('@') ? app.author.slice(1) : null;

  return (
    <li className="bs-app-card" data-type={app.type}>
      {app.screenshot && (
        <div className="bs-app-plate">
          <Image
            src={app.screenshot}
            alt=""
            fill
            sizes={PLATE_SIZES}
            className="bs-app-plate-img"
          />
        </div>
      )}

      <div className="bs-app-head">
        {app.icon && (
          <Image
            src={app.icon}
            alt=""
            width={44}
            height={44}
            className="bs-app-icon"
          />
        )}
        <div className="bs-app-headtext">
          <h3 className="bs-app-name">
            <a
              href={app.url}
              target="_blank"
              rel="noreferrer noopener"
              className="bs-app-name-link"
            >
              {app.name}
            </a>
          </h3>
          <span className="bs-app-type">{APP_TYPE_LABELS[app.type]}</span>
        </div>
      </div>

      <CatalogBrief text={app.description} />

      {app.platforms && app.platforms.length > 0 && (
        <ul className="bs-skill-tags" aria-label="Runs on">
          {app.platforms.map((p) => (
            <li key={p} className="bs-skill-tag">
              {p}
            </li>
          ))}
        </ul>
      )}

      <p className="bs-app-links">
        <a href={app.url} target="_blank" rel="noreferrer noopener" className="bs-app-get">
          Get it<span className="sr-only"> — {app.name}</span>
        </a>
        {app.repo && (
          <a href={app.repo} target="_blank" rel="noreferrer noopener" className="bs-app-source">
            Source<span className="sr-only"> code for {app.name}</span>
          </a>
        )}
      </p>

      {(app.author || app.submitted) && (
        <p className="bs-skill-credit">
          {app.author && (
            <>
              by{' '}
              {handle ? (
                <a
                  href={`https://github.com/${handle}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="bs-skill-credit-link"
                >
                  @{handle}
                </a>
              ) : (
                app.author
              )}
            </>
          )}
          {app.author && app.submitted && ' · '}
          {app.submitted && <>added {app.submitted}</>}
        </p>
      )}
    </li>
  );
}
