// Root-level loading UI — the app-wide Suspense fallback for the App Router.
//
// Most top-level routes render per-request (`dynamic = 'force-dynamic'`, so the
// canonical/og URLs pick up the runtime SITE_URL). Without a loading boundary
// the shell blanks while a route's server render + data fetch is in flight.
// This is the nearest fallback for any segment that doesn't ship its own
// loading.tsx (admin/, landing/ have their own); it keeps the paper frame on
// screen and announces itself to assistive tech via role="status".
export default function RootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg text-ink">
      <div role="status" className="flex items-center gap-2 text-sm text-muted">
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
        />
        Loading…
      </div>
    </div>
  );
}
