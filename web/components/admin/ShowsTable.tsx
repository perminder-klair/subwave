'use client';

// Shows roster as a dense table — the "list" half of the cards/list toggle on
// /admin/shows. Same contract as the slate cards: the row opens the inline
// editor, and the spine carries the same per-show colour the weekly grid
// paints with.
//
// It takes a prepared view-model rather than the panel's `Show` type: the row
// is a dumb renderer, and ShowsPanel stays the only place that knows how a
// show's facets, airtime and validity are derived.

import { useMemo } from 'react';
import { Pill, MetaChip } from './ui';
import { RosterTable } from './RosterTable';
import type { RosterColumn } from './RosterTable';
import { RosterAvatar } from './RosterAvatar';

export interface ShowFace {
  key: string;
  initials: string;
  src: string | null;
}

export interface ShowFacet {
  key: string;
  label: string;
  accent?: boolean;
}

export interface ShowRow {
  id: string;
  index: number;
  name: string;
  colour: string;
  programme: boolean;
  // The pinned feature segment, shown next to the Programme pill.
  skillPin: string;
  banter: boolean;
  host: ShowFace | null;
  hostName: string;
  guests: ShowFace[];
  guestNames: string;
  facets: ShowFacet[];
  // Scheduled hours per week; 0 renders as "unscheduled".
  hrs: number;
  ok: boolean;
}

interface ShowsTableProps {
  rows: ShowRow[];
  onEdit: (row: ShowRow) => void;
}

export function ShowsTable({ rows, onEdit }: ShowsTableProps) {
  const cols = useMemo<RosterColumn<ShowRow>[]>(() => [
    {
      key: 'faces',
      label: '',
      className: 'w-14',
      render: (r) => (
        <span className="flex items-center">
          <RosterAvatar
            src={r.host?.src ?? null}
            initials={r.host?.initials ?? ''}
          />
          {r.guests.map((g, i) => (
            <RosterAvatar
              key={g.key}
              src={g.src}
              initials={g.initials}
              size="xs"
              className={i === 0 ? '-ml-1.5 ring-2 ring-[var(--card-bg)]' : '-ml-2 ring-2 ring-[var(--card-bg)]'}
            />
          ))}
        </span>
      ),
    },
    {
      key: 'name',
      label: 'Show',
      className: 'whitespace-nowrap',
      render: (r) => (
        // No wrapping anywhere in the row: a chip or pill dropping to a second
        // line would inflate the row height and undo the point of the list.
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-extrabold text-ink">{r.name || 'untitled'}</span>
          {r.programme && (
            <Pill tone="solid" dot>Programme{r.skillPin ? ` · ${r.skillPin}` : ''}</Pill>
          )}
          {r.banter && r.guests.length > 0 && <Pill>Banter</Pill>}
        </span>
      ),
    },
    {
      key: 'host',
      label: 'Host',
      // `w-full max-w-0` — see the note in SkillsTable: the pair is what lets
      // the inner span truncate instead of widening the column.
      className: 'hidden md:table-cell w-full max-w-0',
      render: (r) => (
        r.hostName
          ? (
            <span className="block truncate text-muted" title={r.hostName}>
              <span className="font-semibold text-ink">{r.hostName}</span>
              {r.guestNames && <> · with {r.guestNames}</>}
            </span>
          )
          : <span className="text-[var(--danger)]">no persona set</span>
      ),
    },
    {
      key: 'plays',
      label: 'Plays',
      className: 'hidden lg:table-cell whitespace-nowrap',
      render: (r) => {
        if (!r.facets.length) return <span className="text-muted">—</span>;
        return (
          <span className="flex items-center gap-1">
            {r.facets.slice(0, 3).map(f => (
              <MetaChip key={f.key} accent={f.accent} className="whitespace-nowrap">{f.label}</MetaChip>
            ))}
            {r.facets.length > 3 && <MetaChip>+{r.facets.length - 3}</MetaChip>}
          </span>
        );
      },
    },
    {
      key: 'hrs',
      label: 'h / wk',
      align: 'right',
      className: 'whitespace-nowrap',
      render: (r) => (
        r.hrs > 0
          ? <span className="mono-num font-extrabold text-ink">{r.hrs}</span>
          : <span className="caption">unscheduled</span>
      ),
    },
    {
      key: 'status',
      label: '',
      align: 'right',
      className: 'w-24 whitespace-nowrap',
      render: (r) => (r.ok ? null : <Pill tone="accent">incomplete</Pill>),
    },
  ], []);

  return (
    <RosterTable
      caption="Show definitions"
      cols={cols}
      rows={rows}
      rowKey={r => r.id}
      rowLabel={r => `Edit ${r.name || 'untitled show'}`}
      rowSpine={r => r.colour}
      onRowClick={onEdit}
    />
  );
}

export default ShowsTable;
