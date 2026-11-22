import { Suspense } from 'react';
import Link from 'next/link';
import { CatalogGridSkeleton } from '@/components/ui/catalog-skeleton';
import { PosterHero, SubmitSlip } from '@/components/community/Furniture';
import { isGithubHandle, prettyDate } from '@/components/community/kit';
import h from '@/components/community/hub.module.css';
import { fetchCommunityCatalog } from '@/lib/communityCatalog';
import { KINDS, digest, kindHref, type Digest, type Kind } from '@/lib/communityDigest';
import { COMMUNITY_REPO_URL } from '@/lib/repo';
import { pageMeta } from '@/lib/seo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community',
  description:
    'Everything SUB/WAVE operators have built and shared: DJ skills, personas, shows, apps and stations, with the newest additions and the people who sent them in.',
  path: '/community',
});

// Reads catalog.json directly (one ISR-revalidated fetch, see
// lib/communityCatalog.ts), so the hub counts every department at once.
export const dynamic = 'force-dynamic';

const DEPT: Record<Kind, { tag: string; title: string; blurb: string; noun: string }> = {
  skill: { tag: 'The Exchange', title: 'Skills', blurb: 'Segments to teach your DJ, written as a brief and spoken at air time.', noun: 'Skill' },
  persona: { tag: 'The Green Room', title: 'Personas', blurb: 'DJs to book for your booth, each one a soul and a set of dials.', noun: 'Persona' },
  show: { tag: 'The Programme Guide', title: 'Shows', blurb: 'Slots to fill your grid: a topic brief and the filters that pick the music.', noun: 'Show' },
  app: { tag: 'The Receivers', title: 'Apps', blurb: 'Players, bots and clients that tune in.', noun: 'App' },
  station: { tag: 'The Dial', title: 'Stations', blurb: 'SUB/WAVE stations on air around the world.', noun: 'Station' },
};

const KIND_ORDER: Kind[] = ['persona', 'skill', 'show', 'app', 'station'];

function Departments({ d }: { d: Digest }) {
  return (
    <section className={h.section} aria-labelledby="depts">
      <div className={h.sectionHead}>
        <h2 id="depts" className={h.sectionTitle}>
          Departments
        </h2>
        <span className={h.sectionNote}>
          {KINDS.reduce((n, k) => n + d.counts[k], 0)} entries and counting
        </span>
      </div>
      <ul className={h.depts}>
        {KIND_ORDER.map((k) => (
          <li key={k} className={h.dept}>
            <Link href={kindHref(k)} className={h.deptLink}>
              <span className={h.deptGo} aria-hidden="true">
                ↗
              </span>
              <span className={h.deptTag}>{DEPT[k].tag}</span>
              <span className={h.deptRow}>
                <span className={h.deptTitle}>{DEPT[k].title}</span>
                <span className={h.deptCount}>{d.counts[k]}</span>
              </span>
              <span className={h.deptBlurb}>{DEPT[k].blurb}</span>
              {d.previews[k].length > 0 && (
                <span className={h.deptPreview}>{d.previews[k].join(' · ')}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Wire({ d }: { d: Digest }) {
  return (
    <section aria-labelledby="wire">
      <div className={h.sectionHead}>
        <h2 id="wire" className={h.sectionTitle}>
          Off the wire
        </h2>
        <span className={h.sectionNote}>Newest first</span>
      </div>
      {d.wire.length === 0 ? (
        <p className={h.sectionNote}>Nothing dated in the catalog yet.</p>
      ) : (
        <ol className={h.wire}>
          {d.wire.map((w) => (
            <li key={`${w.kind}-${w.href}-${w.name}`} className={h.wireItem}>
              <span className={h.wireMeta}>
                <span className={h.wireKind}>{DEPT[w.kind].noun}</span>
                <time dateTime={w.date}>{prettyDate(w.date)}</time>
                {w.by && <span>by {w.by}</span>}
              </span>
              <Link href={w.href} className={h.wireName}>
                {w.name}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// Each contributor's entries as one stacked bar, split by department. SVG
// geometry rather than inline widths: segment x/width are attributes. The
// viewBox is the top contributor's total, so bar length compares across rows.
function RollBar({ c, scale }: { c: Digest['contributors'][number]; scale: number }) {
  const kinds = KIND_ORDER.filter((k) => c.byKind[k] > 0);
  // Running offsets, computed up front so render stays a pure map.
  const offsets = kinds.map((_, i) => kinds.slice(0, i).reduce((n, k) => n + c.byKind[k], 0));
  return (
    <svg
      viewBox={`0 0 ${Math.max(scale, c.total)} 1`}
      preserveAspectRatio="none"
      className={h.rollBar}
      role="img"
      aria-label={kinds.map((k) => `${c.byKind[k]} ${DEPT[k].title.toLowerCase()}`).join(', ')}
    >
      {kinds.map((k, i) => (
        <rect key={k} x={offsets[i]} y="0" width={c.byKind[k]} height="1" className={h.rollSeg} data-kind={k} />
      ))}
    </svg>
  );
}

function RollCall({ d }: { d: Digest }) {
  const top = d.contributors.slice(0, 12);
  return (
    <section aria-labelledby="roll">
      <div className={h.sectionHead}>
        <h2 id="roll" className={h.sectionTitle}>
          Roll call
        </h2>
        <span className={h.sectionNote}>{d.contributors.length} contributors</span>
      </div>
      {top.length === 0 ? (
        <p className={h.sectionNote}>No credited contributors yet.</p>
      ) : (
        <>
          <ol className={h.roll}>
            {top.map((c) => (
              <li key={c.handle} className={h.rollItem}>
                <span className={h.rollName}>
                  {isGithubHandle(c.handle) ? (
                    <a href={`https://github.com/${c.handle}`} target="_blank" rel="noreferrer">
                      @{c.handle}
                    </a>
                  ) : (
                    c.handle
                  )}
                </span>
                <span className={h.rollTotal}>{c.total}</span>
                <RollBar c={c} scale={top[0]?.total ?? c.total} />
              </li>
            ))}
          </ol>
          <ul className={h.legend} aria-hidden="true">
            {KIND_ORDER.map((k) => (
              <li key={k}>
                <span className={h.rollSeg} data-kind={k} /> {DEPT[k].title}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

async function Commons() {
  const d = digest(await fetchCommunityCatalog());
  return (
    <>
      <Departments d={d} />
      <div className={h.lower}>
        <Wire d={d} />
        <RollCall d={d} />
      </div>
    </>
  );
}

export default function CommunityIndex() {
  return (
    <article>
      <PosterHero
        eyebrow="The Commons"
        title="Built by"
        outline="Operators"
        lede={
          <>
            Every SUB/WAVE station can borrow from every other. Operators write skills, personas
            and shows, build apps that tune in, and put their stations on the map. It all lands
            in one open catalog, and every station reads it live, so a merged entry is on every
            admin console within the hour.
          </>
        }
      />

      <SubmitSlip
        copy="Made something your station can't live without? Hand it round."
        submitUrl={COMMUNITY_REPO_URL}
        submitLabel="Open the catalog"
        helpUrl="https://github.com/perminder-klair/subwave/blob/main/docs/community.md"
        helpLabel="How contributing works"
      />

      <Suspense fallback={<CatalogGridSkeleton count={5} />}>
        <Commons />
      </Suspense>
    </article>
  );
}
