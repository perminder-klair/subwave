import Image from 'next/image';
import CatalogBrief from '@/components/ui/catalog-brief';
import Credit from '@/components/community/Credit';
import { hashString, lotNo } from '@/components/community/kit';
import { APP_TYPE_LABELS, type CommunityApp } from '@/lib/apps';
import s from './apps.module.css';

// The /apps showcase, drawn as the Receivers: each app is a set on the shelf,
// with a model strip, its screen (the submitter's screenshot) or a speaker
// grille where there is none, and a spec underneath. Images are optional and
// host-allowlisted. AppTypeFilter reads data-type to filter in CSS, which keeps
// this a server component with no client JS.

// Screenshots are decorative — the name and description carry the meaning, and
// a submitter-written alt would be another untrusted string on the page.
const PLATE_SIZES = '(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 360px';

/** A tuning knob for a set with no art, its pointer turned by the slug so each
 *  one rests somewhere different and the same one never moves. */
function Knob({ seed }: { seed: string }) {
  // Sweep the pointer over the upper 270°, like a real dial's travel.
  const angle = -135 + (hashString(seed) % 271);
  return (
    <svg viewBox="0 0 64 64" className={s.knob} aria-hidden="true" focusable="false">
      {Array.from({ length: 13 }, (_, i) => {
        const a = ((-135 + i * 22.5 - 90) * Math.PI) / 180;
        return (
          <line
            key={i}
            x1={32 + Math.cos(a) * 26}
            y1={32 + Math.sin(a) * 26}
            x2={32 + Math.cos(a) * 30}
            y2={32 + Math.sin(a) * 30}
            stroke="var(--ink)"
            strokeOpacity={i % 3 === 0 ? 1 : 0.4}
            strokeWidth={i % 3 === 0 ? 1.8 : 1.2}
            strokeLinecap="round"
          />
        );
      })}
      <circle cx="32" cy="32" r="20" fill="var(--bg)" stroke="var(--ink)" strokeWidth="2" />
      <g transform={`rotate(${angle} 32 32)`}>
        <line x1="32" y1="30" x2="32" y2="15" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
      </g>
      <circle cx="32" cy="32" r="3" fill="var(--ink)" />
    </svg>
  );
}

export default function AppCard({ app, index }: { app: CommunityApp; index: number }) {
  return (
    <li className={s.card} id={`app-${app.slug}`} data-type={app.type}>
      <div className={s.cardStrip}>
        <span>Model {lotNo(index)}</span>
        <span className={s.badge}>{APP_TYPE_LABELS[app.type]}</span>
      </div>

      {app.screenshot ? (
        <div className={s.plate}>
          <Image src={app.screenshot} alt="" fill sizes={PLATE_SIZES} className={s.plateImg} />
        </div>
      ) : (
        <div className={`${s.plate} ${s.grille}`}>
          {app.icon ? (
            <Image src={app.icon} alt="" width={84} height={84} className={s.grilleBadge} />
          ) : (
            <Knob seed={app.slug} />
          )}
        </div>
      )}

      <div className={s.body}>
        <div className={s.head}>
          {/* Without a screenshot the icon is already the badge on the grille. */}
          {app.screenshot && app.icon && (
            <Image src={app.icon} alt="" width={44} height={44} className={s.icon} />
          )}
          <h3 className={s.name}>
            <a href={app.url} target="_blank" rel="noreferrer noopener" className={s.nameLink}>
              {app.name}
            </a>
          </h3>
        </div>

        <CatalogBrief text={app.description} />

        {app.platforms && app.platforms.length > 0 && (
          <dl className={s.runs}>
            <dt>Runs on</dt>
            <dd>
              <ul className={s.chips}>
                {app.platforms.map((p) => (
                  <li key={p} className={s.chip}>
                    {p}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        )}

        <div className={s.foot}>
          <p className={s.links}>
            <a href={app.url} target="_blank" rel="noreferrer noopener" className={s.get}>
              Get it<span className="sr-only"> — {app.name}</span> <span aria-hidden="true">→</span>
            </a>
            {app.repo && (
              <a href={app.repo} target="_blank" rel="noreferrer noopener" className={s.source}>
                Source<span className="sr-only"> code for {app.name}</span>
              </a>
            )}
          </p>

          {/* Only a leading @ marks a GitHub handle; a bare name is just a name. */}
          <Credit
            by={app.author}
            added={app.submitted}
            linkHandle={app.author?.startsWith('@') ?? false}
            className={s.credit}
          />
        </div>
      </div>
    </li>
  );
}
