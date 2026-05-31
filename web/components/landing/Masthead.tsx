'use client';

import Link from 'next/link';
import { useClock } from '../../lib/hooks';

const LAUNCH_DATE = new Date('2026-01-01T00:00:00Z');

function issueNo(d: Date): number {
  return Math.max(1, Math.floor((d.getTime() - LAUNCH_DATE.getTime()) / 86400000));
}

// Broadsheet-style header with proper landing-page navigation. Keeps the
// big SUB/WAVE wordmark and the double rules, drops the dateline/location/
// DJ-name strip that belonged on a newspaper but not a marketing site.
//
// No motion on the masthead — wordmark and meta row land static. The page's
// reference frame should feel like print, not a performance.
export default function Masthead() {
  const now = useClock();

  return (
    <header className="bs-paper pt-7 pb-0">
      <div className="bs-rule-double" />

      <div className="bs-masthead-head">
        <div className="bs-caption bs-masthead-meta flex items-center gap-[10px] text-muted">
          <span className="bs-masthead-issue text-[10px] tracking-[0.3em] uppercase">
            VOL. I &nbsp;·&nbsp; NO.&nbsp;{now ? issueNo(now) : '—'}
          </span>
        </div>

        <Link
          href="/"
          aria-label="SUB/WAVE home"
          className="bs-wordmark bs-masthead-mark text-ink no-underline"
        >
          SUB/WAVE
        </Link>

        <div className="bs-masthead-status flex items-center gap-2 text-[11px] font-bold tracking-[0.3em] uppercase">
          <span className="bs-live-dot" aria-hidden="true" />
          <span className="text-vermilion">ON&nbsp;AIR</span>
        </div>
      </div>

      <div className="bs-rule" />

      <nav
        aria-label="Primary"
        className="bs-masthead-nav"
      >
        <Link href="/listen" className="bs-masthead-link">Listen</Link>
        <span aria-hidden="true" className="bs-masthead-sep">·</span>
        <Link href="/manual" className="bs-masthead-link">Manual</Link>
        <span aria-hidden="true" className="bs-masthead-sep">·</span>
        <Link href="/setup" className="bs-masthead-link">Setup</Link>
        <span aria-hidden="true" className="bs-masthead-sep">·</span>
        <Link href="/news" className="bs-masthead-link">News</Link>
        <span aria-hidden="true" className="bs-masthead-sep">·</span>
        <a
          href="https://github.com/perminder-klair/subwave"
          target="_blank"
          rel="noreferrer"
          className="bs-masthead-link"
        >
          GitHub&nbsp;↗
        </a>
      </nav>

      <div className="bs-rule-double" />
    </header>
  );
}
