'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useAdminQuery, type AdminFetch } from '../../lib/admin-query';
import { dashKeys, fetchMusicStarved } from './dash/queries';

// The mixer reports its music chain starved (#1300 bug 7): nothing to play, so
// the emergency loop is on air. Broader than NavidromeBanner on purpose — a
// starve also happens with Navidrome perfectly healthy (an empty auto.m3u, an
// over-strict show whose pool resolved to nothing), and it reports what is
// actually happening ON AIR rather than which dependency is down.
//
// Renders nothing until a starved reading arrives, and stands down entirely
// while the Navidrome banner is up, which is the more specific message.
export default function MusicStarvedBanner({
  adminFetch,
  suppressed = false,
}: {
  adminFetch: AdminFetch;
  suppressed?: boolean;
}) {
  const starvedQuery = useAdminQuery({
    key: dashKeys.musicStarved(),
    adminFetch,
    staleTime: 0,
    refetchInterval: () => 30_000,
    request: fetchMusicStarved,
  });
  const starved = starvedQuery.data ?? false;

  if (!starved || suppressed) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-5 py-2 text-[11px] text-ink sm:px-7"
    >
      <AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" aria-hidden="true" />
      <span>
        <b>No music to play.</b> The station has run out of tracks and is airing the emergency
        loop. Check that your music source is reachable and that the current show isn&rsquo;t
        filtered down to nothing.
      </span>
      <Link
        href="/admin/doctor"
        className="ml-auto inline-flex min-h-9 items-center font-bold text-[var(--danger)] underline-offset-2 hover:underline sm:min-h-0"
      >
        Run the Doctor &rarr;
      </Link>
    </div>
  );
}
