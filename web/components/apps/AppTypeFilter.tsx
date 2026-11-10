'use client';

import { useState, type ReactNode } from 'react';
import { APP_TYPE_LABELS, type AppType } from '@/lib/apps';

// Wraps the server-rendered grid rather than rendering the cards: it sets
// data-filter and CSS hides non-matching data-type (.bs-apps-filterwrap in
// globals.css), which keeps AppCard a server component. `types` holds only the
// types present in the catalog, so no chip can produce an empty grid.
export default function AppTypeFilter({
  types,
  children,
}: {
  types: AppType[];
  children: ReactNode;
}) {
  const [active, setActive] = useState<AppType | 'all'>('all');

  // One chip is no choice at all — render the grid bare.
  if (types.length < 2) return <>{children}</>;

  const chips: Array<{ key: AppType | 'all'; label: string }> = [
    { key: 'all', label: 'All' },
    ...types.map((t) => ({ key: t, label: APP_TYPE_LABELS[t] })),
  ];

  return (
    <div className="bs-apps-filterwrap" data-filter={active}>
      <div className="bs-apps-filter" role="group" aria-label="Filter apps by type">
        {chips.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className="bs-apps-chip"
            aria-pressed={active === key}
            onClick={() => setActive(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
