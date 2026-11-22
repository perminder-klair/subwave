'use client';

import { useState, type ReactNode } from 'react';
import { APP_TYPE_LABELS, type AppType } from '@/lib/apps';
import s from './apps.module.css';

// The band switch: a row of push keys, one per kind of app, with how many of
// each are on the shelf. It wraps the server-rendered grid rather than
// rendering the cards: it sets data-filter and CSS hides non-matching data-type
// (.filterWrap in apps.module.css), which keeps AppCard a server component.
// `bands` holds only the types present in the catalog, so no key can produce an
// empty grid.
export default function AppTypeFilter({
  bands,
  total,
  children,
}: {
  bands: Array<{ type: AppType; count: number }>;
  total: number;
  children: ReactNode;
}) {
  const [active, setActive] = useState<AppType | 'all'>('all');

  // One key is no choice at all — render the grid bare.
  if (bands.length < 2) return <>{children}</>;

  const keys: Array<{ key: AppType | 'all'; label: string; count: number }> = [
    { key: 'all', label: 'All', count: total },
    ...bands.map((b) => ({ key: b.type, label: APP_TYPE_LABELS[b.type], count: b.count })),
  ];

  return (
    <div className={s.filterWrap} data-filter={active}>
      <div className={s.band}>
        <span className={s.bandTag} aria-hidden="true">
          Band
        </span>
        <div className={s.bandKeys} role="group" aria-label="Filter apps by type">
          {keys.map(({ key, label, count }) => (
            <button
              key={key}
              type="button"
              className={s.key}
              aria-pressed={active === key}
              onClick={() => setActive(key)}
            >
              <span className={s.keyLabel}>
                <span className={s.lamp} aria-hidden="true" />
                {label}
              </span>
              <span className={s.keyCount}>{count}</span>
            </button>
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}
