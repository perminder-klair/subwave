'use client';


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
        // The min-height gives the icon-only tab a comfortable phone tap target
        // (the Seg item's own padding leaves it ~30px); `sm:` puts it back.
        {
          id: 'cards',
          title: 'Card view',
          label: (
            <span className="flex min-h-[22px] items-center sm:min-h-0">
              <LayoutList size={15} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">Cards</span>
            </span>
          ),
        },
        {
          id: 'list',
          title: 'List view',
          label: (
            <span className="flex min-h-[22px] items-center sm:min-h-0">
              <Rows3 size={15} strokeWidth={1.75} aria-hidden />
              <span className="sr-only">List</span>
            </span>
          ),
        },
      ]}
    />
  );
}

export default RosterViewToggle;
