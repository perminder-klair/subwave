'use client';

// The rack hardware shared by Admin → Music sources' Monitor and Plugins tabs:
// the master faceplate (nameplate, a display of readings, a control strip) and
// the screwed-on panels below it.

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


export interface FaceplateCell {
  label: string;
  value: ReactNode;
  /** Lights the value: ok green, warn amber, bad red. */
  tone?: 'ok' | 'warn' | 'bad';
}

/**
 * The unit's master panel. Two rows by design: the nameplate beside a display
 * of labelled readings (cells reflow on a narrow screen — nothing is cut off),
 * then the control strip, secondary keys left and the primary one right.
 */
export function Faceplate({
  title,
  subtitle,
  lamp,
  cells,
  actions,
  primary,
}: {
  title: string;
  subtitle: string;
  lamp: 'ok' | 'idle' | 'error';
  cells: FaceplateCell[];
  actions?: ReactNode;
  primary?: ReactNode;
}) {
  return (
    <header className={s.faceplate}>
      <Screws />
      <span className={s.screw} data-at="bl" aria-hidden="true" />
      <span className={s.screw} data-at="br" aria-hidden="true" />
      <div className={s.faceTop}>
        <div className={s.brand}>
          <span className={s.powerLamp} data-state={lamp} aria-hidden="true" />
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
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
      {(actions || primary) && (
        <div className={s.controls}>
          <div>{actions}</div>
          {primary && <div className={s.controlPrimary}>{primary}</div>}
        </div>
      )}
    </header>
  );
}
