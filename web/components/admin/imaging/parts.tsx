'use client';

/* Presentational helpers for the redesigned Imaging page (Imaging.dc.html).
   The editorial "newsprint broadsheet" treatment: bare bordered panels with
   mono uppercase headers, Fraunces display headlines, right-aligned mono
   metrics. Every static style is a Tailwind utility — inline `style` is
   eslint-forbidden here (issue #50) — dynamic bar heights ride the shared
   `Wave` component's DOM-mutation path instead. These are pure layout; all
   state + controller wiring stays in ImagingPanel and the section files. */

import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn';

/** Zero-pad a count to two digits, the way the metrics read in the design. */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The mono micro-label used on every panel header (10px / 700 / 0.2em). */
export function MonoLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[10px] font-bold tracking-[0.2em] uppercase', className)}>
      {children}
    </span>
  );
}

/** A bordered editorial panel. Sharp corners, 1px ink border, no shadow, on
    the lifted card surface (--card-bg) so sections read as cards over the page
    background — matching the rest of the admin (Moods / Skills / Shows). */
export function PanelBox({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('border border-ink bg-[var(--card-bg)]', className)}>{children}</div>;
}

/** Panel header row: mono label on the left, an optional actions cluster on
    the right, hairline underline. */
export function PanelHead({ label, right }: { label: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-separator-strong px-[18px] py-[13px]">
      <MonoLabel>{label}</MonoLabel>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

/** Right-aligned metric: a big mono figure over a tiny uppercase caption. */
export function TabMetric({
  n, l, accent, big,
}: { n: ReactNode; l: ReactNode; accent?: boolean; big?: boolean }) {
  return (
    <div className="text-right">
      <div
        className={cn(
          'font-mono leading-none font-bold',
          big ? 'text-[26px]' : 'text-[22px]',
          accent && 'text-[var(--accent)]',
        )}
      >
        {n}
      </div>
      <div className="mt-[5px] font-mono text-[9px] tracking-[0.18em] text-muted uppercase">{l}</div>
    </div>
  );
}

/** Per-tab masthead: Fraunces headline + description on the left, metrics on
    the right. Replaces the boxed SectionHeader inside the imaging tabs. */
export function SectionMasthead({
  title, sub, metrics,
}: { title: ReactNode; sub: ReactNode; metrics: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div>
        <h2 className="font-display text-[34px] leading-[1.1] font-semibold">{title}</h2>
        <p className="mt-2 max-w-[58ch] text-[13px] leading-[1.6] [text-wrap:pretty] text-muted">
          {sub}
        </p>
      </div>
      <div className="flex flex-none gap-7">{metrics}</div>
    </div>
  );
}

/** Empty-library state: a display-italic "None yet." over a mono caption. */
export function EmptyState({ caption }: { caption: ReactNode }) {
  return (
    <div className="px-[18px] py-11 text-center">
      <div className="font-display text-[22px] text-muted italic">None yet.</div>
      <div className="mt-2 font-mono text-[11px] tracking-[0.12em] text-muted uppercase">{caption}</div>
    </div>
  );
}

/** Dashed drop-zone that triggers a hidden file input in the import modals. */
export function DropZone({
  label, hint, onClick, disabled,
}: { label: ReactNode; hint: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block w-full cursor-pointer border border-dashed border-ink px-4 py-[18px] text-center transition-colors hover:bg-[var(--ink-soft)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <div className="font-mono text-[12px] font-bold tracking-[0.12em] uppercase">{label}</div>
      <div className="mt-1.5 font-mono text-[10px] text-muted">{hint}</div>
    </button>
  );
}

/** The shared asset-row metadata line: mono, muted, dot-separated facets. */
export function MetaLine({ children }: { children: ReactNode }) {
  return (
    <div className="mt-[7px] flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-muted">
      {children}
    </div>
  );
}
