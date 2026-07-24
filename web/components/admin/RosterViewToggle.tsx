'use client';

// The Cards/List switch that sits above each roster (/admin/skills,
// /admin/shows, /admin/personas). Icon-only: LayoutList is the slate card's
// own shape (a face beside stacked lines), Rows3 is the dense table. Each
// carries a visually-hidden label, so the accessible name is still
// "Cards"/"List" for screen readers and tests.

import { LayoutList, Rows3 } from 'lucide-react';
import { Seg } from './ui';
import type { RosterView } from '../../lib/adminView';

interface RosterViewToggleProps {
  view: RosterView;
  onChange: (v: RosterView) => void;
}

export function RosterViewToggle({ view, onChange }: RosterViewToggleProps) {
  return (
    <Seg
      value={view}
      onChange={v => onChange(v === 'list' ? 'list' : 'cards')}
      options={[
        {
          id: 'cards',
          title: 'Card view',
          label: (
            <>
              <LayoutList size={15} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">Cards</span>
            </>
          ),
        },
        {
          id: 'list',
          title: 'List view',
          label: (
            <>
              <Rows3 size={15} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">List</span>
            </>
          ),
        },
      ]}
    />
  );
}

export default RosterViewToggle;
