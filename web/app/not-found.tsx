import Link from 'next/link';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';
import { AnimatedLink } from '@/components/ui/animated-link';

// The site-wide 404, catching unmatched URLs and any `notFound()` without a
// closer not-found.tsx. Without this file Next serves its own bare 404 inside
// the root layout, which carries no masthead of its own — so this page supplies
// the Masthead + bs-paper + StationFooter trio the other shells use.

export default function NotFound() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Masthead />
      <main className="bs-paper">
        <article>
          <header className="bs-news-hero">
            <p className="bs-eyebrow">OFF THE DIAL</p>
            <h1>Dead air.</h1>
            <p>
              There&rsquo;s nothing broadcasting on this frequency. The page you asked for
              either moved, never existed, or was pulled from the schedule.
            </p>
          </header>

          <p className="bs-news-empty">
            The stream itself is unaffected — the music keeps playing whatever this page
            does.
          </p>

          <div className="bs-station-cta">
            <p className="bs-station-cta-copy">Try one of these instead.</p>
            <AnimatedLink href="/listen" variant="arrow" className="bs-station-cta-link">
              Back to the player
            </AnimatedLink>
            <Link href="/manual" className="bs-station-cta-help">
              Read the manual
            </Link>
          </div>
        </article>
        <StationFooter />
      </main>
    </div>
  );
}
