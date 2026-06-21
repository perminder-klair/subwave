'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import SignInForm from '@/components/admin/SignInForm';
import { useWizard, STEP_ORDER, STEP_LABELS } from './useWizard';
import { DjStep, LlmStep, NavidromeStep, ReviewStep, TtsStep } from './steps';

// Outer chrome for the first-run wizard. Sign-in gate (admin creds from .env),
// step indicator, body, and back/next buttons. The Review step calls `onDone`
// which redirects to /admin so the operator lands in the place they'll spend
// their actual time.
export default function WizardShell() {
  const router = useRouter();
  const w = useWizard();
  const [done, setDone] = useState(false);

  if (!w.auth.hydrated) {
    return <div className="p-8 text-sm text-ink/60">Loading…</div>;
  }
  if (!w.auth.auth) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-ink">Finish setting up SUB/WAVE</h1>
        <p className="mt-2 mb-6 text-sm text-ink/70">
          Sign in with the <code>ADMIN_USER</code> + <code>ADMIN_PASS</code> you set in your
          <code> .env</code>.
        </p>
        <SignInForm onSubmit={w.auth.signIn} />
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-2xl font-semibold text-ink">You&apos;re on air.</h1>
        <p className="mt-2 text-sm text-ink/70">
          Setup is complete. You can tweak everything later from the admin panel.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={() => router.push('/admin')}
            className="rounded border border-ink bg-ink px-4 py-2 text-sm font-medium tracking-wide text-bg uppercase hover:opacity-90"
          >
            Go to admin
          </button>
          <Link
            href="/listen"
            className="rounded border border-ink px-4 py-2 text-sm font-medium tracking-wide text-ink uppercase hover:bg-ink/10"
          >
            Open the player
          </Link>
        </div>
      </div>
    );
  }

  const body =
    w.step === 'navidrome' ? <NavidromeStep w={w} /> :
    w.step === 'llm' ? <LlmStep w={w} /> :
    w.step === 'tts' ? <TtsStep w={w} /> :
    w.step === 'dj' ? <DjStep w={w} /> :
    <ReviewStep w={w} onDone={() => setDone(true)} />;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-6">
        <p className="text-xs font-medium tracking-[0.18em] text-ink/50 uppercase">
          SUB/WAVE — first-run setup
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">
          Step {w.stepIdx + 1} of {STEP_ORDER.length}
        </h1>
      </div>

      <ol className="mb-8 flex flex-wrap gap-2">
        {STEP_ORDER.map((id, i) => (
          <li
            key={id}
            className={
              'rounded border px-2 py-1 text-xs tracking-wide uppercase ' +
              (i === w.stepIdx
                ? 'border-ink bg-ink text-bg'
                : i < w.stepIdx
                  ? 'border-ink/40 bg-ink/10 text-ink/70'
                  : 'border-ink/20 text-ink/40')
            }
          >
            {i + 1}. {STEP_LABELS[id]}
          </li>
        ))}
      </ol>

      <div className="rounded border border-ink/20 bg-bg p-6">{body}</div>

      <div className="mt-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={w.back}
            disabled={w.stepIdx === 0}
            className="rounded border border-ink/40 px-3 py-1.5 text-sm hover:bg-ink/10 disabled:cursor-not-allowed disabled:opacity-30"
          >
            ← Back
          </button>
          {/* Escape hatch lives next to Back so it can't be confused with the
              primary CTA on the right. Only shown on the review step — earlier
              steps have a Next button there. */}
          {w.step === 'review' && (
            <Link href="/setup" className="bs-link text-xs text-ink/50">
              read the docs instead
            </Link>
          )}
        </div>
        {w.step !== 'review' && (
          <button
            type="button"
            onClick={w.next}
            className="rounded border border-ink bg-ink px-3 py-1.5 text-sm font-medium tracking-wide text-bg uppercase hover:opacity-90"
          >
            Next →
          </button>
        )}
      </div>
    </div>
  );
}
