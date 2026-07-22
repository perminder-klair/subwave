'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

// Site-wide error boundary. Wraps every page and nested layout below the root
// layout; a throw in the root layout itself falls through to global-error.tsx.
//
// Most failures here are data failures rather than code failures: the public
// pages read the local controller or the community catalog at request time, and
// a self-hosted station can perfectly well have its controller down while the
// web container is up. So the recovery path has to actually re-fetch.
//
// `reset()` alone does NOT re-fetch — it only clears the error state and
// re-renders the same children, which for a failed server fetch just reproduces
// the error. `router.refresh()` re-runs the server render, so the pair is what
// makes "Try again" mean something. (Next 16.2 adds `unstable_retry` which does
// both, but this ships to self-hosted operators and we'd rather not depend on
// an `unstable_` export that can change under them.)

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // Surfaces in the browser console and in the container logs when the throw
    // happened during SSR. Server-thrown errors arrive with their message
    // stripped in production, so `digest` is the only thing that ties this back
    // to the controller log line.
    console.error('[subwave] route error', error.digest ?? '', error);
  }, [error]);

  function retry() {
    setRetrying(true);
    router.refresh();
    reset();
  }

  return (
    <div className="min-h-screen bg-bg text-ink">
      <Masthead />
      <main className="bs-paper">
        <article>
          <header className="bs-news-hero">
            <p className="bs-eyebrow">TRANSMISSION FAULT</p>
            <h1>Something broke.</h1>
            <p>
              This page failed to render. That usually means the station&rsquo;s controller
              is unreachable or still starting up — the broadcast itself is separate, so the
              stream is probably still running.
            </p>
          </header>

          <div className="bs-station-cta">
            <p className="bs-station-cta-copy">
              {retrying ? 'Retrying…' : 'Give it another go.'}
            </p>
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              className="bs-station-cta-link"
            >
              Try again
            </button>
            <Link href="/listen" className="bs-station-cta-help">
              Back to the player
            </Link>
          </div>

          {error.digest ? (
            <p className="bs-stations-report">
              If it keeps happening, quote this reference when you report it:{' '}
              <code>{error.digest}</code>. It matches the corresponding line in the
              container logs (<code>docker compose logs web</code>).
            </p>
          ) : (
            <p className="bs-stations-report">
              If it keeps happening, check <code>docker compose logs controller</code> —
              this is most often the controller being down rather than a bug in the page.
            </p>
          )}
        </article>
        <StationFooter />
      </main>
    </div>
  );
}
