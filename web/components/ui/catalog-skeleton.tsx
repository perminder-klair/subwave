// Suspense fallbacks for the catalog-backed broadsheet pages (/stations,
// /shows). Those routes are force-dynamic and await a remote catalog before
// they can render, so the data-dependent regions sit behind boundaries and the
// static shell — hero, CTA, footer note — flushes first. These placeholders
// reserve the real layout's footprint so the stream-in doesn't shift anything.
//
// Server components: no state, no effects, nothing to hydrate. Styles live with
// the rest of the bs- broadsheet vocabulary in app/globals.css.

/** Placeholder for the "12 stations · 7 countries" tally row. */
export function CatalogStatSkeleton() {
  return (
    <p className="bs-stat-strip" role="status" aria-label="Loading catalog">
      <span className="bs-skeleton bs-skeleton-stat" />
    </p>
  );
}

/** Placeholder for the dotted world chart on /stations. */
export function CatalogMapSkeleton() {
  return (
    <div className="bs-station-map" aria-hidden="true">
      <span className="bs-skeleton bs-skeleton-map" />
    </div>
  );
}

/**
 * Placeholder run of cards in the newspaper-column grid. `count` should be
 * roughly a screenful — enough to hold the scroll height steady, not so many
 * that a short catalog collapses noticeably when the real list arrives.
 */
export function CatalogGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="bs-stations-grid" role="status" aria-label="Loading catalog">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="bs-skeleton-card" aria-hidden="true">
          <span className="bs-skeleton bs-skeleton-line-title" />
          <span className="bs-skeleton bs-skeleton-line" />
          <span className="bs-skeleton bs-skeleton-line bs-skeleton-line-wide" />
          <span className="bs-skeleton bs-skeleton-line bs-skeleton-line-short" />
        </li>
      ))}
    </ul>
  );
}
