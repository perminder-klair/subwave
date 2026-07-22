import { Suspense } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import CommunityShowCard from '@/components/shows/CommunityShowCard';
import { CatalogGridSkeleton, CatalogStatSkeleton } from '@/components/ui/catalog-skeleton';
import { fetchCommunityShows, type CommunityShow } from '@/lib/communityShows';
import { pageMeta } from '@/lib/seo';
import { showSubmitUrl } from '@/lib/repo';

export const metadata = pageMeta({
  title: 'SUB/WAVE — Community Shows',
  description:
    'The community show catalog — produced-show templates shared by other stations. Browse them here, then install any from your station&rsquo;s admin console.',
  path: '/shows',
});

// The catalog is baked into the controller image and refreshed on update, so
// read it live from the local controller at request time rather than at build.
export const dynamic = 'force-dynamic';

// Submission opens a GitHub Issue Form (no fork, no YAML). A workflow turns the
// issue into a one-file pull request automatically. Mirrors the /skills +
// /personas share flows.
const SUBMIT_URL = showSubmitUrl();
const DOCS_URL = 'https://github.com/perminder-klair/subwave/blob/main/docs/community.md';

// The two catalog-backed regions. Each takes the in-flight promise rather than
// calling fetchCommunityShows() itself, so the page issues exactly one request
// no matter how many boundaries read it — no reliance on framework-level fetch
// memoisation, which fetchCommunityShows opts out of with `cache: 'no-store'`.

async function ShowsStat({ shows }: { shows: Promise<CommunityShow[]> }) {
  const count = (await shows).length;
  if (count === 0) return null;
  return (
    <p className="bs-stat-strip">
      <span>
        <strong>{count}</strong> {count === 1 ? 'show' : 'shows'} in the catalog
      </span>
    </p>
  );
}

async function ShowsGrid({ shows }: { shows: Promise<CommunityShow[]> }) {
  const list = await shows;
  if (list.length === 0) {
    return (
      <p className="bs-news-empty">
        No community shows to show yet — the catalog may still be loading, or this station
        hasn&rsquo;t shipped one. Be the first to{' '}
        <AnimatedLink href={SUBMIT_URL} className="bs-link">
          share a show
        </AnimatedLink>
        .
      </p>
    );
  }
  return (
    <ul className="bs-stations-grid">
      {list.map((s) => (
        <CommunityShowCard key={s.slug} show={s} />
      ))}
    </ul>
  );
}

export default function CommunityShowsIndex() {
  // Kick the controller call off but don't await it here: keeping this
  // component synchronous is what lets the hero, the CTA and the closing note
  // flush immediately while the catalog streams in behind the boundaries.
  // fetchCommunityShows never rejects (it resolves to [] on any failure), so
  // holding the promise unawaited can't produce an unhandled rejection.
  const shows = fetchCommunityShows();

  return (
    <article>
      <header className="bs-news-hero">
        <p className="bs-eyebrow">THE PROGRAMME GUIDE</p>
        <h1>Community Shows.</h1>
        <p>
          A show is a produced slot — a topic brief plus the music filters that steer what
          plays under it, and a few mode knobs like banter and produced episodes. These are
          shared by the community and ship with every station. Browse them here, then install
          the ones you like from your own admin console.
        </p>
      </header>

      <Suspense fallback={<CatalogStatSkeleton />}>
        <ShowsStat shows={shows} />
      </Suspense>

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Built a show worth sharing? Add it to the catalog.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a show
        </AnimatedLink>
        <AnimatedLink href={DOCS_URL} className="bs-station-cta-help">
          How it works
        </AnimatedLink>
      </div>

      <Suspense fallback={<CatalogGridSkeleton />}>
        <ShowsGrid shows={shows} />
      </Suspense>

      <p className="bs-stations-report">
        Installing is a two-tap job in your station&rsquo;s admin: open{' '}
        <strong>Shows → Community</strong>, then <strong>Install</strong>. Every show arrives
        ready to place on your grid — bind it to a persona and a time slot on your own terms.
      </p>
    </article>
  );
}
