'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/admin/ui';
import { Button } from '@/components/ui/button';
import { V3Alert } from '@/components/ui/alert';

// Admin-scoped error boundary. It nests inside app/admin/layout.tsx, which
// renders AdminShell — so when a panel throws, the console's own chrome (nav,
// sign-in state) stays mounted and only the panel area is replaced. Without
// this file the throw would bubble to app/error.tsx and take the whole console
// down to the marketing-styled error page, which is both jarring and less
// useful: the operator loses the nav they need to get to a working panel.
//
// Admin panels talk to the controller from the browser and already handle their
// own fetch failures inline; what reaches this boundary is a render-time throw,
// so the copy points at that rather than at "the controller is down".
//
// `reset()` re-renders without re-fetching; `router.refresh()` re-runs the
// server render. Panels are client components that fetch on mount, so reset()
// alone is usually enough here — refresh() is included so a stale RSC payload
// can't pin the error in place.

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    console.error('[subwave] admin panel error', error.digest ?? '', error);
  }, [error]);

  return (
    <Card>
      <V3Alert tone="error" title="Panel failed to render">
        <p>
          This panel threw while rendering. Other panels are unaffected — use the nav to
          move on, or retry below.
        </p>
        {error.digest ? (
          <p className="mt-2">
            Reference <code>{error.digest}</code>.
          </p>
        ) : null}
        {error.message ? (
          <p className="mt-2 break-words opacity-80">{error.message}</p>
        ) : null}
      </V3Alert>
      <div className="mt-3">
        <Button
          variant="accent"
          size="sm"
          onClick={() => {
            // Re-run the server render (router.refresh) *and* clear the error
            // boundary (reset) — reset alone re-renders the same failed tree.
            setRetrying(true);
            router.refresh();
            reset();
          }}
          disabled={retrying}
        >
          {retrying ? 'Retrying…' : 'Retry panel'}
        </Button>
      </div>
    </Card>
  );
}
