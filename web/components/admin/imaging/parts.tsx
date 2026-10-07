'use client';


import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn';
import { EmptyState as SharedEmptyState } from '../../ui/empty-state';

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function MonoLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-[10px] font-bold tracking-[0.2em] uppercase', className)}>
      {children}
    </span>
  );
}

export function PanelBox({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('border border-ink bg-[var(--card-bg)]', className)}>{children}</div>;
}

export function PanelHead({ label, right }: { label: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-separator-strong px-[18px] py-[13px]">
      <MonoLabel>{label}</MonoLabel>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

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

export function SectionMasthead({
  title, sub, metrics, actions,
}: { title: ReactNode; sub: ReactNode; metrics?: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="p-[18px]">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h2 className="text-[22px] leading-tight font-extrabold tracking-[-0.02em]">{title}</h2>
            <p className="mt-1.5 max-w-[58ch] text-[12px] leading-[1.6] [text-wrap:pretty] text-muted">
              {sub}
            </p>
          </div>
          {metrics && <div className="flex flex-none gap-7">{metrics}</div>}
        </div>
        {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </section>
  );
}

export function EmptyState({ caption }: { caption: ReactNode }) {
  return <SharedEmptyState title="None yet." description={caption} />;
}

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

export function MetaLine({ children }: { children: ReactNode }) {
  return (
    <div className="mt-[7px] flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-muted">
      {children}
    </div>
  );
}
