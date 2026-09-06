'use client';

// The first-run wizard; once setup is complete it falls through to an "already
// set up" card. Force-dynamic so the controller's /onboarding/status is checked
// per request and a stale "needs setup" view is never served.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import WizardShell from '@/components/onboarding/WizardShell';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

type Status = { needsSetup: boolean; setupCompletedAt: string | null };

// `?rerun=1` re-opens the wizard on a station that is already set up — the
// "already set up" card below links to it. Nothing is bypassed by the flag:
// WizardShell still gates on ADMIN_USER/ADMIN_PASS exactly as it does on a
// first run, and POST /onboarding/save is admin-gated on the controller. It
// only decides which of the two views this page renders, so a re-run is worth
// no more than reloading the page.
function SetupPageInner() {
  const rerun = useSearchParams().get('rerun') === '1';
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
  if (status.needsSetup || rerun) return <WizardShell />;

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
      <p className="mt-6 text-sm text-ink/70">
        Changing music server, or switching the DJ to a hosted brain?{' '}
        <Link href="/onboarding?rerun=1" className="bs-link">Run the wizard again</Link>{' '}
        — it walks the same steps and overwrites what you confirm.
      </p>
    </div>
  );
}

// useSearchParams needs a Suspense boundary in the App Router.
export default function SetupPage() {
  return (
    <Suspense fallback={<div role="status" className="p-8 text-sm text-ink/60">Loading…</div>}>
      <SetupPageInner />
    </Suspense>
  );
}
