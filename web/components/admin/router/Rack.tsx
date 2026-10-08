'use client';

// The rack hardware shared by Admin → Music sources' Monitor and Plugins tabs:
// a screwed-on panel with a mono header and an action slot.

import type { ReactNode } from 'react';
import s from './router.module.css';

export function Screws() {
  return (
    <>
      <span className={s.screw} data-at="tl" aria-hidden="true" />
      <span className={s.screw} data-at="tr" aria-hidden="true" />
    </>
  );
}

export function RackPanel({
  title,
  description,
  action,
  flush,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={s.rack} aria-label={title}>
      <Screws />
      <div className={s.rackHeader}>
        <div className="min-w-0">
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action && <div className={s.rackActions}>{action}</div>}
      </div>
      <div className={flush ? s.rackBodyFlush : s.rackBody}>{children}</div>
    </section>
  );
}

