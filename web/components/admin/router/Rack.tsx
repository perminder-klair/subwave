'use client';

// The rack hardware shared by Admin → Music sources: the header's status strip
// and the screwed-on panels the Monitor and Plugins tabs are built from.

import type { ReactNode } from 'react';
import type { StatusCell } from './model';
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


/**
 * The Music sources header's status strip: the lamp, then one labelled reading
 * per cell, lit by state. Cells reflow on a narrow screen — nothing is cut off.
 */
export function StatusStrip({ lamp, cells }: { lamp: 'ok' | 'idle' | 'error'; cells: StatusCell[] }) {
  return (
    <div className={s.statusStrip}>
      <div className={s.lampCell}>
        <span className={s.powerLamp} data-state={lamp} aria-hidden="true" />
      </div>
      <dl className={s.vfd} aria-live="polite">
        {cells.map((c) => (
          <div key={c.label} className={s.dcell} data-tone={c.tone}>
            <dt>{c.label}</dt>
            <dd>{c.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
