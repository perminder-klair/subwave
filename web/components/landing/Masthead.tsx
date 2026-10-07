'use client';

import Link from 'next/link';
import { AnimatedLink } from '@/components/ui/animated-link';
import CommunityMenu from './CommunityMenu';
import { useClock } from '../../lib/hooks';

const LAUNCH_DATE = new Date('2026-01-01T00:00:00Z');

function issueNo(d: Date): number {
  return Math.max(1, Math.floor((d.getTime() - LAUNCH_DATE.getTime()) / 86400000));
}

// NEXT_PUBLIC_APP_VERSION can arrive as `git describe` output
// ("1.2.0-33-geae57592"), so keep only the semver head. Falls back to the roman
// numeral so the masthead never renders a bare "VOL. ".
const VERSION = (process.env.NEXT_PUBLIC_APP_VERSION || '').split('-')[0] || 'I';

export default function Masthead() {
  const now = useClock();

  return (
    // The dropdown needs an unlayered bs- rule to override .bs-paper stacking; Tailwind z-*
    // utilities lose to globals.css.
    <header className="bs-paper bs-masthead-lift pt-7 !pb-4">
      <div className="bs-rule-double" />

      <div className="bs-masthead-head">
        <div className="bs-caption bs-masthead-meta flex items-center gap-[10px] text-muted">
          <span className="bs-masthead-issue text-[10px] tracking-[0.3em] uppercase">
            VOL.&nbsp;{VERSION} &nbsp;·&nbsp; NO.&nbsp;{now ? issueNo(now) : '—'}
          </span>
        </div>

        <Link
          href="/"
          aria-label="SUB/WAVE home"
          className="bs-wordmark bs-wordmark-plate bs-masthead-mark text-ink no-underline"
        >
          SUB
          <span className="bs-wordmark-slash">
            <span className="bs-wordmark-slash-glyph text-vermilion">/</span>
            <span className="bs-wordmark-disc" aria-hidden="true">
              <span className="bs-wordmark-disc-face" />
            </span>
          </span>
          WAVE
        </Link>

        <div className="bs-masthead-status flex items-center gap-2 text-[11px] font-bold tracking-[0.3em] uppercase">
          <span className="bs-live-dot" aria-hidden="true" />
          <span className="text-vermilion">ON&nbsp;AIR</span>
        </div>
      </div>

      <div className="bs-masthead-motto">
        <span aria-hidden="true">✦</span>
        <span className="bs-masthead-motto-text">
          No skips&nbsp;·&nbsp;No shuffle&nbsp;·&nbsp;Just radio
        </span>
        <span aria-hidden="true">✦</span>
      </div>

      {/* Attach separators to items so wrapped rows cannot start with a dot. Keep them outside
          links to avoid underlining them. */}
      <nav aria-label="Primary" className="bs-masthead-nav">
        <span className="bs-masthead-item">
          <AnimatedLink href="/listen" className="bs-masthead-link">
            Listen
          </AnimatedLink>
        </span>
        <span className="bs-masthead-item">
          <AnimatedLink href="/manual" className="bs-masthead-link">
            Manual
          </AnimatedLink>
        </span>
        <span className="bs-masthead-item">
          <AnimatedLink href="/setup" className="bs-masthead-link">
            Setup
          </AnimatedLink>
        </span>
        <span className="bs-masthead-item bs-masthead-community">
          <CommunityMenu />
        </span>
        <span className="bs-masthead-item">
          <AnimatedLink href="/news" className="bs-masthead-link">
            News
          </AnimatedLink>
        </span>
        <span className="bs-masthead-item">
          <AnimatedLink
            href="https://github.com/perminder-klair/subwave"
            variant="arrow"
            className="bs-masthead-link"
          >
            GitHub
          </AnimatedLink>
        </span>
      </nav>

      <div className="bs-rule-double" />
    </header>
  );
}
