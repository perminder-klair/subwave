'use client';

// /setup is the first-run wizard. Once setup is complete it falls through to
// a short "you're already set up" card with links to the player and to
// /setup for the deeper documentation.
//
// (Force-dynamic — checks the controller's /onboarding/status on every request to
// avoid serving a stale "needs setup" view after the operator finishes.)

import { useEffect, useState } from 'react';
import Link from 'next/link';
import WizardShell from '@/components/onboarding/WizardShell';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

type Status = { needsSetup: boolean; setupCompletedAt: string | null };

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/onboarding/status`)
      .then(r => (r.ok ? r.json() : Promise.reject(`${r.status}`)))
      .then(setStatus)
      .catch(err => setError(String(err)));
  }, []);

  if (error) {
    return (
      <div role="alert" className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-2xl font-semibold text-ink">Couldn&apos;t reach the controller</h1>
        <p className="mt-2 text-sm text-ink/70">
          Open <code>{API_URL}/onboarding/status</code> in another tab to confirm it&apos;s up. Error: <code>{error}</code>
        </p>
      </div>
    );
  }
  if (!status) return <div role="status" className="p-8 text-sm text-ink/60">Loading…</div>;
  if (status.needsSetup) return <WizardShell />;

  // Setup already complete.
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold text-ink">SUB/WAVE is set up.</h1>
      <p className="mt-2 text-sm text-ink/70">
        Setup was finished
        {status.setupCompletedAt
          ? ` on ${new Date(status.setupCompletedAt).toLocaleString()}.`
          : '.'}{' '}
        Manage everything from the admin panel; read <Link href="/setup" className="bs-link">the setup docs</Link> if you want
        a deeper walk-through.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/admin"
          className="rounded border border-ink bg-ink px-4 py-2 text-sm font-medium tracking-wide text-bg uppercase hover:opacity-90"
        >
          Admin
        </Link>
        <Link
          href="/listen"
          className="rounded border border-ink px-4 py-2 text-sm font-medium tracking-wide text-ink uppercase hover:bg-ink/10"
        >
          Player
        </Link>
        <Link
          href="/setup"
          className="rounded border border-ink/40 px-4 py-2 text-sm font-medium tracking-wide text-ink uppercase hover:bg-ink/10"
        >
          Docs
        </Link>
      </div>
    </div>
  );
}
