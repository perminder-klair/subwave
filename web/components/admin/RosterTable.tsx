'use client';


import type { ReactNode } from 'react';
import { useRef } from 'react';
import { cn } from '../../lib/cn';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';

export interface RosterColumn<R> {
  key: string;
  // Empty for the spine and face columns, which are decoration rather than data.
  label: ReactNode;
  align?: 'left' | 'right' | 'center';
  // Per-cell classes: responsive column hiding and width hints.
  className?: string;
  headClassName?: string;
  // When set, the header renders as a sort button calling `onSort(sortMode)`.
  sortMode?: string;
  // Sort modes are named presets ("enabled first"), not asc/desc toggles, so
  // 'other' is the honest default; a genuine A–Z column passes 'ascending'.
  sortAria?: 'ascending' | 'other';
  render: (row: R) => ReactNode;
}

export interface RosterTableProps<R> {
  cols: RosterColumn<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  // aria-label for the row's button role, e.g. "Edit Weather".
  rowLabel: (row: R) => string;
  // CSS colour for the row's left spine; omit for no spine.
  rowSpine?: (row: R) => string;
  onRowClick: (row: R) => void;
  sort?: string;
  onSort?: (mode: string) => void;
  // Visually-hidden <caption> naming the table for screen readers.
  caption: string;
}

interface RosterRowProps<R> {
  row: R;
  cols: RosterColumn<R>[];
  label: string;
  spine?: string;
  onClick: () => void;
}

// Its own component so it can hold the ref the spine colour needs: the `style`
// prop is lint-forbidden (issue #50), so dynamic colours go through
// useDynamicStyle. The spine is a first-cell left border because that spans the
// full row height natively.
function RosterRow<R>({ row, cols, label, spine, onClick }: RosterRowProps<R>) {
  const spineRef = useRef<HTMLTableCellElement>(null);
  useDynamicStyle(spineRef, { borderLeftColor: spine });

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onClick}
      onKeyDown={(e) => {
        // A keyboard press on an inner control must not bubble up and also open
        // the editor.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
      className={cn(
        'cursor-pointer transition-colors hover:bg-[var(--ink-softer)]',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]',
      )}
    >
      {cols.map((c, i) => (
        <td
          key={c.key}
          ref={i === 0 ? spineRef : undefined}
          className={cn(
            'border-b border-separator-soft px-2 py-1.5 text-[12px]',
            i === 0 && spine && 'border-l-4',
            c.align === 'right' && 'text-right',
            c.align === 'center' && 'text-center',
            c.className,
          )}
        >
          {c.render(row)}
        </td>
      ))}
    </tr>
  );
}

export function RosterTable<R>({
  cols, rows, rowKey, rowLabel, rowSpine, onRowClick, sort, onSort, caption,
}: RosterTableProps<R>) {
  return (
    // Horizontal scroll is the floor; responsive column hiding should mean the
    // documented breakpoints never reach it.
    <div className="card overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => {
              const sortable = !!c.sortMode && !!onSort;
              const active = sortable && sort === c.sortMode;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (c.sortAria ?? 'other') : undefined}
                  className={cn(
                    'caption border-b border-ink px-2 py-1.5 whitespace-nowrap',
                    // Sticky so the header survives a long roster scrolling
                    // under it; the card background masks the rows.
                    'sticky top-0 z-[1] bg-[var(--card-bg)]',
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                    c.className,
                    c.headClassName,
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.sortMode as string)}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase transition-colors hover:text-vermilion',
                        active && 'text-vermilion',
                      )}
                    >
                      {c.label}
                      {active && <span aria-hidden="true">▾</span>}
                    </button>
                  ) : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <RosterRow
              key={rowKey(r)}
              row={r}
              cols={cols}
              label={rowLabel(r)}
              spine={rowSpine?.(r)}
              onClick={() => onRowClick(r)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

