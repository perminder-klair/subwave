'use client';

import { eventTurnSummary, turnText } from '../../../lib/sessionFeed';
import type { SessionTurn } from '../../../lib/types';
import { Toggle } from '../ui';
import { type LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/cn';
import type { SortKey, SortState } from './types';

export function SortableTh({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string;
  col: SortKey;
  sort: SortState;
  onSort: (s: SortState) => void;
  className?: string;
}) {
  const active = sort.key === col;
  const arrow = active ? (sort.dir === 'asc' ? '↑' : '↓') : '';
  return (
    <th className={cn('py-1.5 font-bold', className)}>
      <button
        type="button"
        className={cn('uppercase hover:text-ink', active && 'text-ink')}
        onClick={() =>
          onSort(
            active
              ? { key: col, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: col, dir: col === 'connectedSeconds' ? 'desc' : 'asc' },
          )
        }
      >
        {label}
        {arrow ? <span className="ml-1">{arrow}</span> : null}
      </button>
    </th>
  );
}

interface SegmentButtonProps {
  label: string;
  icon: LucideIcon;
  busyHere: boolean;
  anyBusy: boolean;
  onFire: () => void;
  busyLabel?: string;
  title?: string;
}

// All visual states live in .seg-pad (globals.css).
export function SegmentButton({ label, icon: Icon, busyHere, anyBusy, onFire, busyLabel = 'on air', title }: SegmentButtonProps) {
  return (
    <button
      type="button"
      disabled={anyBusy}
      title={title}
      onClick={onFire}
      className={cn('seg-pad', busyHere && 'is-firing')}
    >
      <span className="seg-led" aria-hidden />
      <Icon className="seg-glyph" strokeWidth={1.5} aria-hidden />
      <span className="seg-label">{label}</span>
      <span className="seg-cta">{busyHere ? busyLabel : 'fire'}</span>
    </button>
  );
}

interface ToggleRowProps {
  label: string;
  desc: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export function ToggleRow({ label, desc, on, disabled, onToggle }: ToggleRowProps) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1">
        <div className="text-[12px] font-bold">{label}</div>
        <div className="text-[10px] text-muted">{desc}</div>
      </div>
      <Toggle on={on} disabled={disabled} onClick={onToggle} ariaLabel={label} />
    </div>
  );
}

export function classTone(cls: string): string {
  switch (cls) {
    case 'voice':
    case 'track':
      return 'accent';
    default:
      return 'muted';
  }
}

// Long `event` turns render as a one-line summary; the raw pick prompt never shows
// here (it lives in the session JSON).
export function BoothTurnText({ turn }: { turn: SessionTurn }) {
  // Deliberately not markdown-rendered — booth turns are speech scripts.
  return <span className="break-words text-ink">{eventTurnSummary(turn) ?? turnText(turn)}</span>;
}

export function oneLine(s: unknown, n = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

