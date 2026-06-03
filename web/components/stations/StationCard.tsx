'use client';

import { useEffect, useState } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import type { Station } from '@/lib/stations';

// One station in the directory: static fields rendered server-side, plus a live
// strip that probes the station's own public now-playing API from the
// listener's browser. The SUB/WAVE controller serves /api/now-playing with
// wide-open CORS, so this works cross-origin without a proxy. Same response
// shape as web/hooks/useStationFeed.ts ({ nowPlaying: { title, artist }, ... }).
//
// The probe NEVER throws to render — any failure (down host, CORS, timeout,
// non-SUB/WAVE site) just resolves to "offline". We poll a little lazily (30s)
// since this is a directory, not the player.

type LiveStatus = 'loading' | 'on-air' | 'offline';

interface Live {
  status: LiveStatus;
  track?: string; // "Artist — Title" when known
}

const POLL_MS = 30_000;
const TIMEOUT_MS = 6_000;

function formatTrack(np: { title?: string; artist?: string } | null | undefined): string | undefined {
  if (!np) return undefined;
  const t = (np.title || '').trim();
  const a = (np.artist || '').trim();
  if (a && t) return `${a} — ${t}`;
  return t || a || undefined;
}

export default function StationCard({ station }: { station: Station }) {
  const [live, setLive] = useState<Live>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${station.url}/api/now-playing`, {
          signal: ctrl.signal,
          // directory probe — don't let a stale CDN copy mask a down station
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          nowPlaying?: { title?: string; artist?: string } | null;
          streamOnline?: boolean;
        };
        if (cancelled) return;
        const online = data.streamOnline !== false; // undefined → assume up
        const track = formatTrack(data.nowPlaying);
        setLive(online ? { status: 'on-air', track } : { status: 'offline' });
      } catch {
        if (!cancelled) setLive({ status: 'offline' });
      } finally {
        clearTimeout(timer);
      }
    };

    probe();
    const id = setInterval(probe, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [station.url]);

  return (
    <li className="bs-station-card">
      <div className="bs-station-live" data-status={live.status}>
        {live.status === 'on-air' ? (
          <>
            <span className="bs-live-dot" aria-hidden="true" />
            <span className="bs-station-live-label">ON AIR</span>
            {live.track ? <span className="bs-station-track">{live.track}</span> : null}
          </>
        ) : live.status === 'offline' ? (
          <span className="bs-station-live-label bs-station-off">Offline</span>
        ) : (
          <span className="bs-station-live-label bs-station-off">Checking…</span>
        )}
      </div>

      <h3 className="bs-station-name">
        <AnimatedLink href={station.url} variant="arrow">
          {station.name}
        </AnimatedLink>
      </h3>

      <p className="bs-station-meta">
        {station.location ? <span>{station.location}</span> : null}
        {station.genre ? <span className="bs-station-genre">{station.genre}</span> : null}
        {station.operator ? <span className="bs-station-operator">{station.operator}</span> : null}
      </p>

      {station.description ? <p className="bs-station-desc">{station.description}</p> : null}
    </li>
  );
}
