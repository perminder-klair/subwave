import type { ReactNode } from 'react';
import { AnimatedLink } from '@/components/ui/animated-link';
import s from './community.module.css';

// The page furniture shared by /community, /skills, /personas and /shows.
// Server components, no client JS.

export function PosterHero({
  eyebrow,
  title,
  outline,
  lede,
  stamp,
}: {
  eyebrow: string;
  /** First headline line, solid ink. */
  title: string;
  /** Second headline line, set hollow. */
  outline: string;
  lede: ReactNode;
  /** The count stamp, usually a Suspense boundary. */
  stamp?: ReactNode;
}) {
  return (
    <header className={s.hero}>
      <div className={s.heroText}>
        <p className="bs-eyebrow">{eyebrow}</p>
        <h1 className={s.heroTitle}>
          {title}
          <span className={s.heroAccent}>.</span>
          <span className={s.heroOutline}>{outline}</span>
        </h1>
        <p className={s.heroLede}>{lede}</p>
      </div>
      {stamp}
    </header>
  );
}

export function CountStamp({ count, noun, plural }: { count: number; noun: string; plural?: string }) {
  if (count === 0) return null;
  return (
    <p className={s.stamp}>
      <span>In the catalog</span>
      <span className={s.stampNum}>{count}</span>
      <span>{count === 1 ? noun : (plural ?? `${noun}s`)}</span>
    </p>
  );
}

export function CountStampSkeleton() {
  return <p className={`${s.stamp} ${s.stampSkeleton}`} role="status" aria-label="Loading catalog" />;
}

export function SubmitSlip({
  copy,
  submitUrl,
  submitLabel,
  helpUrl,
  helpLabel,
}: {
  copy: string;
  submitUrl: string;
  submitLabel: string;
  helpUrl: string;
  helpLabel: string;
}) {
  return (
    <aside className={s.slip} aria-label="Contribute">
      <span className={s.slipScissors} aria-hidden="true">
        ✂
      </span>
      <p className={s.slipCopy}>{copy}</p>
      <div className={s.slipActions}>
        <a href={submitUrl} className={s.slipPrimary}>
          {submitLabel} <span aria-hidden="true">→</span>
        </a>
        <AnimatedLink href={helpUrl} className={s.slipSecondary}>
          {helpLabel}
        </AnimatedLink>
      </div>
    </aside>
  );
}

export function InstallSteps({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className={s.steps} aria-label="How to install">
      {steps.map((step, i) => (
        <li key={i} className={s.step}>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

export function EmptyCatalog({ what, submitUrl, cta }: { what: string; submitUrl: string; cta: string }) {
  return (
    <p className={s.empty}>
      Nothing in the {what} catalog yet, or this station hasn&rsquo;t caught up with it. Be the
      first to <a href={submitUrl}>{cta}</a>.
    </p>
  );
}
