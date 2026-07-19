'use client';

// Sub-station channel discovery for the listener UI. The install's enabled
// channels ride GET /state (`channels: [{id, name}]`); this hook fetches them
// lazily — the palette menu only needs the list once it's actually open — and
// derives which channel the current page is tuned to from the pathname
// (/ch/<id>/…). Install-level by design: the list always comes from THIS
// deployment's controller (defaultStationClient), never a showcase station.

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { defaultStationClient } from '@/lib/stationClient';

export interface ChannelInfo {
  id: string;
  name: string;
}

export function currentChannelId(pathname: string | null): string | null {
  const m = (pathname || '').match(/^\/ch\/([^/]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export function useChannelList(enabled: boolean): {
  channels: ChannelInfo[] | null;
  currentId: string | null;
} {
  const pathname = usePathname();
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);

  useEffect(() => {
    if (!enabled || channels !== null) return;
    let cancelled = false;
    defaultStationClient
      .state()
      .then(s => {
        if (cancelled) return;
        setChannels(Array.isArray(s.channels) ? s.channels : []);
      })
      .catch(() => {
        if (!cancelled) setChannels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, channels]);

  return { channels, currentId: currentChannelId(pathname) };
}
