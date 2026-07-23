// Route-level loading UI for the force-dynamic /landing broadsheet.
//
// The page renders per-request (`dynamic = 'force-dynamic'`) and awaits the
// showcase-station catalog before it can return, so without this boundary the
// whole app shell blanks while that request is in flight. This gives Next a
// Suspense fallback for the segment: a lightweight paper-toned placeholder that
// keeps the broadsheet frame present — and announces itself to assistive tech
// via role="status" — until the real page paints.
export default function LandingLoading() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <main className="bs-paper" aria-busy="true">
        <div className="bs-rule-double" />
        <div role="status" className="px-4 py-24 text-center text-sm text-muted">
          Loading the broadsheet…
        </div>
      </main>
    </div>
  );
}
