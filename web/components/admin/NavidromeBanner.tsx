'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAdminQuery, type AdminFetch } from '../../lib/admin-query';
import { dashKeys, fetchNavidromeStatus } from './dash/queries';

// Polls the same Navidrome ping the DJ Doc reads, so the two never disagree.
// Renders nothing until a failing result arrives.
export default function NavidromeBanner({
  adminFetch,
  onStatus,
}: {
  adminFetch: AdminFetch;
  // Lets the shell suppress the broader starve banner while this more specific
  // one is up — a Navidrome outage raises both, and two stacked red bars
  // saying overlapping things is worse than one.
  onStatus?: (ok: boolean) => void;
}) {
  const statusQuery = useAdminQuery({
    key: dashKeys.navidrome(),
    adminFetch,
    staleTime: 0,
    refetchInterval: () => 30_000,
    request: fetchNavidromeStatus,
  });
  const status = statusQuery.data ?? null;

  useEffect(() => {
    if (status) onStatus?.(status.ok);
  }, [onStatus, status]);

  if (!status || status.ok) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-5 py-2 text-[11px] text-ink sm:px-7"
    >
      <AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" aria-hidden="true" />
      <span>
        <b>Can&rsquo;t reach Navidrome.</b> The DJ has no music source
        {status.reason ? <> — {status.reason}</> : null}. Check the connection in Settings &rarr;
        Music source and that Navidrome is running.
      </span>
      <Link
        href="/admin/settings?section=music"
        className="ml-auto inline-flex min-h-9 items-center font-bold text-[var(--danger)] underline-offset-2 hover:underline sm:min-h-0"
      >
        Music source &rarr;
      </Link>
    </div>
  );
}
