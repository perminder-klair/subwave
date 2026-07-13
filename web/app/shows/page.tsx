import { AnimatedLink } from '@/components/ui/animated-link';
import CommunityShowCard from '@/components/shows/CommunityShowCard';
import { fetchCommunityShows } from '@/lib/communityShows';
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

export default async function CommunityShowsIndex() {
  const shows = await fetchCommunityShows();
  const count = shows.length;

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

      {count > 0 ? (
        <p className="bs-stat-strip">
          <span>
            <strong>{count}</strong> {count === 1 ? 'show' : 'shows'} in the catalog
          </span>
        </p>
      ) : null}

      <div className="bs-station-cta">
        <p className="bs-station-cta-copy">Built a show worth sharing? Add it to the catalog.</p>
        <AnimatedLink href={SUBMIT_URL} variant="arrow" className="bs-station-cta-link">
          Share a show
        </AnimatedLink>
        <AnimatedLink href={DOCS_URL} className="bs-station-cta-help">
          How it works
        </AnimatedLink>
      </div>

      {count > 0 ? (
        <ul className="bs-stations-grid">
          {shows.map((s) => (
            <CommunityShowCard key={s.slug} show={s} />
          ))}
        </ul>
      ) : (
        <p className="bs-news-empty">
          No community shows to show yet — the catalog may still be loading, or this station
          hasn&rsquo;t shipped one. Be the first to{' '}
          <AnimatedLink href={SUBMIT_URL} className="bs-link">
            share a show
          </AnimatedLink>
          .
        </p>
      )}

      <p className="bs-stations-report">
        Installing is a two-tap job in your station&rsquo;s admin: open{' '}
        <strong>Shows → Community</strong>, then <strong>Install</strong>. Every show arrives
        ready to place on your grid — bind it to a persona and a time slot on your own terms.
      </p>
    </article>
  );
}
