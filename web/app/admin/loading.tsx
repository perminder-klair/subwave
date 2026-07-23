import { Card } from '@/components/admin/ui';

// Route-level loading state for the admin console.
//
// It nests inside app/admin/layout.tsx, so AdminShell — nav, header, sign-in
// state — stays mounted and only the panel area is replaced. That matters here
// because the panels are large client components imported statically (no
// next/dynamic anywhere in admin), so a route change has to fetch and evaluate
// that route's chunk before the panel can render its own internal "loading…"
// guard. Until now nothing at all painted in that window; the operator saw the
// previous panel frozen, then a jump.
//
// Deliberately a plain card rather than a detailed skeleton: the panels differ
// too much for one shape to be a fair prediction of any of them, and a wrong
// skeleton reads worse than an honest placeholder. Matches the wording the
// panels already use for their own pre-data guard ("loading…").
//
// Note this only shows for a signed-in operator — AdminShell renders the
// sign-in form instead of children when unauthenticated, so the boundary is
// never reached in that state.

export default function AdminLoading() {
  return (
    <div className="grid gap-4">
      <Card title="Loading" sub="fetching panel">
        <div className="text-[13px] text-muted italic">loading…</div>
      </Card>
    </div>
  );
}
