'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import AdminQueryProvider from '@/components/admin/AdminQueryProvider';
import SignInForm from '@/components/admin/SignInForm';
import { Button } from '@/components/ui/button';
import { useWizard, STEP_ORDER, STEP_LABELS } from './useWizard';
import { DjStep, LlmStep, NavidromeStep, ReviewStep, TtsStep } from './steps';

// Outer chrome for the first-run wizard: sign-in gate (admin creds from .env),
// step indicator, body, back/next. The Review step calls `onDone`, which
// redirects to /admin.
export default function WizardShell() {
  const router = useRouter();
  const w = useWizard();
  const [done, setDone] = useState(false);

  if (!w.auth.hydrated) {
    return <div className="p-8 text-sm text-muted">Loading…</div>;
  }
  if (!w.auth.auth) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="font-display text-2xl font-bold text-ink">Finish setting up SUB/WAVE</h1>
        <p className="mt-2 mb-6 text-sm text-muted">
          Sign in with the <code>ADMIN_USER</code> + <code>ADMIN_PASS</code> you set in your
          <code> .env</code>.
        </p>
        <SignInForm onSubmit={w.auth.signIn} />
      </div>
    );
  }

  if (done) {
    return (
      <AdminQueryProvider key={w.auth.auth}>
        <div className="mx-auto max-w-2xl px-4 py-12">
          <h1 className="font-display text-2xl font-bold text-ink">You&apos;re on air.</h1>
          <p className="mt-2 text-sm text-muted">
            Setup is complete. You can tweak everything later from the admin panel.
          </p>
          <div className="mt-6 flex gap-3">
            <Button variant="solid" size="lg" onClick={() => router.push('/admin')}>
              Go to admin
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/listen">Open the player</Link>
            </Button>
          </div>
        </div>
      </AdminQueryProvider>
    );
  }

  const body =
    w.step === 'navidrome' ? <NavidromeStep w={w} /> :
    w.step === 'llm' ? <LlmStep w={w} /> :
    w.step === 'tts' ? <TtsStep w={w} /> :
    w.step === 'dj' ? <DjStep w={w} /> :
    <ReviewStep w={w} onDone={() => setDone(true)} />;

  return (
    <AdminQueryProvider key={w.auth.auth}>
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="mb-6">
          <p className="font-mono text-[11px] font-bold tracking-eyebrow text-vermilion uppercase">
            SUB/WAVE — first-run setup
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-ink">
            Step {w.stepIdx + 1} of {STEP_ORDER.length}
          </h1>
        </div>

        <ol className="mb-8 flex flex-wrap gap-2">
          {STEP_ORDER.map((id, i) => (
            <li
              key={id}
              className={
                'border px-2 py-1 text-[11px] tracking-[0.14em] uppercase ' +
                (i === w.stepIdx
                  ? 'border-ink bg-ink text-bg'
                  : i < w.stepIdx
                    ? 'border-line bg-accent-soft text-ink'
                    : 'border-soft-border text-ink-faint')
              }
            >
              {i + 1}. {STEP_LABELS[id]}
            </li>
          ))}
        </ol>

        <div className="border border-ink bg-surface p-6">{body}</div>

        {/* Back only — every non-review step now owns its own gated "Next"
            submit button inside its own form (steps.tsx), so a second,
            ungated Next here would bypass that step's validation entirely.
            Review owns its own "Save and finish" button the same way it
            always has. */}
        <div className="mt-6 flex items-center gap-3">
          <Button variant="outline" onClick={w.back} disabled={w.stepIdx === 0}>
            ← Back
          </Button>
          {w.step === 'review' && (
            <Link href="/setup" className="bs-link text-xs text-muted">
              read the docs instead
            </Link>
          )}
        </div>
      </div>
    </AdminQueryProvider>
  );
}
