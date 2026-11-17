'use client';

import type { ReactNode } from 'react';
import { Search, Ban, Music, LayoutGrid, History, CalendarClock } from 'lucide-react';
import { cn } from '../../../lib/cn';
 
import type { Tab } from './types';

export function Tabs({ tab, setTab }: {
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const items: { id: Tab; name: string; sub: string; icon: ReactNode }[] = [
    { id: 'tracks', name: 'Tracks', sub: 'newest & needs tags', icon: <Music size={17} /> },
    { id: 'browse', name: 'Browse', sub: 'tagged index', icon: <LayoutGrid size={17} /> },
    { id: 'search', name: 'Search', sub: 'navidrome', icon: <Search size={17} /> },
    { id: 'era', name: 'Era', sub: 'suspect albums', icon: <CalendarClock size={17} /> },
    { id: 'history', name: 'History', sub: 'what aired', icon: <History size={17} /> },
    { id: 'blocked', name: 'Blocked', sub: 'never plays', icon: <Ban size={17} /> },
  ];
  return (
    // The strip is a nowrap `overflow-x:auto` scroller (globals.css), and at 390px the
    // five tabs run ~700px, so below sm: it wraps instead and the subtitles drop.
    // `!` because `.admin-root .lib-*` outranks a bare utility.
    <div className="lib-tabs !flex-wrap sm:!flex-nowrap">
      {items.map(it => (
        // sm:!basis-0: equal widths from sm: up (each still never below its
        // content), instead of widths that follow each subtitle's length.
        <button key={it.id} type="button" className={cn('lib-tab !px-2.5 sm:!basis-0 sm:!px-[18px]', tab === it.id && 'on')} onClick={() => setTab(it.id)}>
          {it.icon}
          <span className="min-w-0">
            <span className="lib-tab-name">{it.name}</span>
            <span className="lib-tab-sub !hidden sm:!block">{it.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

