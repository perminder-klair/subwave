'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Masthead from '@/components/landing/Masthead';
import StationFooter from '@/components/landing/StationFooter';

// reset() clears the boundary but does not refetch failed server data. Pair it with
// router.refresh() to retry the server render.

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
    // Server-thrown errors arrive with their message stripped in production, so
    // `digest` is the only thing tying this back to the container log line.
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
