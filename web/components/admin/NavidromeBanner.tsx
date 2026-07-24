'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface NavidromeStatus {
  ok: boolean;
  reason?: string;
  url?: string;
}

// Always-on connectivity banner. Polls the live-config Navidrome ping (cached
// server-side) every 30s and, when it fails, warns on every admin page that the
// DJ has no music source. Uses the same ping the DJ Doc reads, so the two never
// disagree. Renders nothing until the first failing result arrives — a healthy
// or not-yet-known station shows no chrome.
export default function NavidromeBanner({
  adminFetch,
}: {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
}) {
  const [status, setStatus] = useState<NavidromeStatus | null>(null);
  // adminFetch's identity changes as auth state ticks; hold the latest in a ref
  // so the poll interval mounts once instead of tearing down every render.
  const fetchRef = useRef(adminFetch);
  fetchRef.current = adminFetch;

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetchRef.current('/doctor/navidrome');
        if (!r.ok) return; // 401 / 5xx — don't flip the banner on an auth blip
        const j = (await r.json()) as NavidromeStatus;
        if (!cancelled) setStatus(j);
      } catch {
        // Controller unreachable — leave the last known state rather than
        // flapping; a dead controller has its own, louder failure modes.
      }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!status || status.ok) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-7 py-2 text-[11px] text-ink"
    >
      <AlertTriangle size={14} className="shrink-0 text-[var(--danger)]" aria-hidden="true" />
      <span>
        <b>Can&rsquo;t reach Navidrome.</b> The DJ has no music source
        {status.reason ? <> — {status.reason}</> : null}. Check the connection in Settings &rarr;
        Music source and that Navidrome is running.
      </span>
      <Link
        href="/admin/settings?section=music"
        className="ml-auto font-bold text-[var(--danger)] underline-offset-2 hover:underline"
      >
        Music source &rarr;
      </Link>
    </div>
  );
}
