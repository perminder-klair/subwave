'use client';

// Skills roster as a dense table — the "list" half of the cards/list toggle on
// /admin/skills. Same contract as the slate cards: the row opens the edit
// sheet, and the enable switch and Run now pad still act in place.

import { useMemo } from 'react';
import { cn } from '../../../lib/cn';
import { Pill, MetaChip, Toggle } from '../ui';
import { RosterTable } from '../RosterTable';
import type { RosterColumn } from '../RosterTable';
import { cooldownLabel, iconFor } from './shared';
import type { Skill, SortMode } from './shared';

interface SkillsTableProps {
  skills: Skill[];
  // Name of the skill currently mutating (toggle or run), or null.
  busy: string | null;
  // "All DJs" / "3 of 8 DJs" — empty string when the roster hasn't loaded.
  assignmentLabel: (s: Skill) => string;
  // True when the DJ/show filter is on a show and this is its pinned feature.
  isPinned: (s: Skill) => boolean;
  sort: SortMode;
  onSort: (mode: SortMode) => void;
  onEdit: (s: Skill) => void;
  onToggle: (name: string, on: boolean) => void;
  onRunNow: (name: string) => void;
}

export function SkillsTable({
  skills, busy, assignmentLabel, isPinned, sort, onSort, onEdit, onToggle, onRunNow,
}: SkillsTableProps) {
  const cols = useMemo<RosterColumn<Skill>[]>(() => [
    {
      key: 'face',
      label: '',
      className: 'w-9',
      render: (s) => {
        const Icon = iconFor(s);
        return (
          <span className={cn('grid place-items-center', s.enabled ? 'text-ink' : 'text-muted')}>
            <Icon size={16} strokeWidth={1.75} aria-hidden />
          </span>
        );
      },
    },
    {
      key: 'name',
      label: 'Skill',
      className: 'whitespace-nowrap',
      sortMode: 'az',
      sortAria: 'ascending',
      render: (s) => (
        // No wrapping in the row — a pill dropping to a second line would
        // inflate the row height and undo the point of the list.
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-extrabold text-ink">{s.label || s.name}</span>
          {s.custom && <Pill className="text-[8px]">custom</Pill>}
          {/* The card carries the full V3Alert; the table just flags it and the
              guidance stays one click away in the edit sheet. */}
          {s.ready === false && (
            <MetaChip className="border-[var(--danger)] text-[var(--danger)]">needs key</MetaChip>
          )}
          {isPinned(s) && <MetaChip accent>pinned</MetaChip>}
        </span>
      ),
    },
    {
      key: 'brief',
      label: 'Brief',
      // `w-full` claims the table's slack and `max-w-0` lets the inner span
      // truncate instead of widening the column — the pair is what makes
      // truncation work at all in an auto-layout table.
      className: 'hidden lg:table-cell w-full max-w-0',
      render: (s) => (
        <span className="block truncate text-muted italic" title={s.description || ''}>
          {s.description || 'No description.'}
        </span>
      ),
    },
    {
      key: 'cooldown',
      label: 'Cooldown',
      className: 'hidden md:table-cell whitespace-nowrap',
      sortMode: 'cooldown',
      render: (s) => <span className="text-muted">{cooldownLabel(s.cooldownMs)}</span>,
    },
    {
      key: 'djs',
      label: 'DJs',
      className: 'hidden md:table-cell whitespace-nowrap',
      render: (s) => <span className="text-muted">{assignmentLabel(s) || '—'}</span>,
    },
    {
      key: 'tags',
      label: 'Tags',
      className: 'hidden xl:table-cell',
      render: (s) => {
        const tags = s.tags || [];
        if (!tags.length) return <span className="text-muted">—</span>;
        return (
          <span className="flex items-center gap-1">
            {tags.slice(0, 2).map(t => <MetaChip key={t} className="whitespace-nowrap">#{t}</MetaChip>)}
            {tags.length > 2 && <MetaChip>+{tags.length - 2}</MetaChip>}
          </span>
        );
      },
    },
    {
      key: 'run',
      label: '',
      align: 'right',
      className: 'whitespace-nowrap',
      render: (s) => (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRunNow(s.name); }}
          disabled={busy === s.name}
          className={cn('seg-pad seg-pad--slim', busy === s.name && 'is-firing')}
        >
          <span className="seg-led" aria-hidden />
          <span className="seg-label">{busy === s.name ? 'Working…' : 'Run now'}</span>
        </button>
      ),
    },
    {
      key: 'enabled',
      label: 'On',
      align: 'right',
      className: 'w-12',
      sortMode: 'enabled',
      render: (s) => (
        <span onClick={e => e.stopPropagation()}>
          <Toggle
            on={s.enabled}
            disabled={busy === s.name}
            onClick={() => onToggle(s.name, !s.enabled)}
            ariaLabel={`Enable ${s.label || s.name}`}
          />
        </span>
      ),
    },
  ], [busy, assignmentLabel, isPinned, onRunNow, onToggle]);

  return (
    <RosterTable
      caption="Skills"
      cols={cols}
      rows={skills}
      rowKey={s => s.name}
      rowLabel={s => `Edit ${s.label || s.name}`}
      rowSpine={s => (s.enabled ? 'var(--accent)' : 'var(--separator-strong)')}
      onRowClick={onEdit}
      sort={sort}
      onSort={m => onSort(m as SortMode)}
    />
  );
}

export default SkillsTable;
