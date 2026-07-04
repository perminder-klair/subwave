'use client';

import Link from 'next/link';

import { AnimatedLink } from '@/components/ui/animated-link';

// The Back Pages — the footer as a broadsheet back-page index. Three ruled
// section panels give the station's secondary destinations (dispatches,
// stations, skills) real front-of-house billing, then a single colophon
// strip carries the small print. Copy ends with the press-room "-30-" mark.
const BACK_PAGES = [
  {
    no: '01',
    tag: 'The Wire',
    title: 'Dispatches',
    teaser: 'Field notes, release wires & tales from the press desk.',
    cta: 'Read the dispatches',
    href: '/news',
  },
  {
    no: '02',
    tag: 'The Dial',
    title: 'Stations',
    teaser: 'Other SUB/WAVEs broadcasting right now. Spin the dial.',
    cta: 'Browse the stations',
    href: '/stations',
  },
  {
    no: '03',
    tag: 'The Exchange',
    title: 'Community Skills',
    teaser: 'Segments operators taught their DJs — take one home.',
    cta: 'Explore the skills',
    href: '/skills',
  },
] as const;

export default function StationFooter({ djName }: { djName?: string }) {
  return (
    <footer className="mt-16 flex flex-col">
      <div className="bs-rule-double" />

      <div className="flex items-baseline justify-between gap-4 py-[7px] text-[10px] tracking-[0.3em] text-muted uppercase">
        <span className="font-bold text-ink">The Back Pages</span>
        <span className="hidden sm:inline">Reader services · §§ 01–03</span>
      </div>

      <div className="bs-rule" />

      <nav
        aria-label="Back pages"
        className="grid divide-y divide-ink/20 sm:grid-cols-3 sm:divide-x sm:divide-y-0"
      >
        {BACK_PAGES.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            className="group relative flex flex-col gap-[10px] overflow-hidden px-5 py-6 no-underline transition-colors duration-300 hover:bg-ink/[0.04] sm:first:pl-1 sm:last:pr-1"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-4 right-1 [font-family:var(--font-display),Georgia,serif] text-[92px] leading-none font-black text-ink/[0.05] transition-colors duration-300 select-none group-hover:text-vermilion/10"
            >
              {page.no}
            </span>

            <span className="flex items-baseline justify-between gap-3 text-[10px] tracking-[0.25em] text-muted uppercase">
              <span className="font-mono transition-colors duration-300 group-hover:text-vermilion">
                № {page.no}
              </span>
              <span>{page.tag}</span>
            </span>

            <span className="[font-family:var(--font-display),Georgia,serif] text-[26px] leading-none font-black text-ink italic">
              {page.title}
            </span>

            <span className="max-w-[26ch] text-[12.5px] leading-relaxed text-muted">
              {page.teaser}
            </span>

            <span className="mt-auto flex items-center gap-[6px] pt-1 text-[10px] font-bold tracking-[0.25em] text-ink uppercase transition-colors duration-300 group-hover:text-vermilion">
              {page.cta}
              <span
                aria-hidden="true"
                className="transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] group-hover:translate-x-[5px]"
              >
                →
              </span>
            </span>
          </Link>
        ))}
      </nav>

      <div className="bs-rule" />

      <div
        className="flex flex-col items-center gap-2 py-5 text-center text-[10px] tracking-[0.22em] text-muted uppercase
          sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-4 sm:text-left"
      >
        <span className="font-bold text-ink">SUB/WAVE · EST. 2026</span>
        <span>Navidrome · Liquidsoap · Icecast · your LLM · your voice</span>
        <span>
          {djName ? `${djName} on the desk · ` : ''}
          <AnimatedLink
            href="https://github.com/perminder-klair/subwave"
            variant="arrow"
            className="font-semibold tracking-[inherit] text-ink hover:text-vermilion"
          >
            GitHub
          </AnimatedLink>{' '}
          ·{' '}
          <AnimatedLink
            href="https://discord.gg/vjVbVKnMBa"
            variant="arrow"
            className="font-semibold tracking-[inherit] text-ink hover:text-vermilion"
          >
            Discord
          </AnimatedLink>
        </span>
      </div>

      <div className="pb-1 text-center text-[10px] tracking-[0.3em] text-muted uppercase">
        <AnimatedLink href="/listen" className="font-semibold tracking-[inherit] text-ink hover:text-vermilion">
          open the player
        </AnimatedLink>{' '}
        ·{' '}
        <AnimatedLink href="/privacy" className="font-semibold tracking-[inherit] text-ink hover:text-vermilion">
          privacy
        </AnimatedLink>{' '}
        ·{' '}
        <AnimatedLink href="/terms" className="font-semibold tracking-[inherit] text-ink hover:text-vermilion">
          terms
        </AnimatedLink>
      </div>

      <div
        className="py-3 text-center font-mono text-[11px] tracking-[0.4em] text-muted select-none"
        title="End of copy — the old press-room sign-off"
        aria-hidden="true"
      >
        — 30 —
      </div>

      <div className="pb-[6px] text-center text-[10px] tracking-[0.3em] text-balance text-muted uppercase">
        Set in type &amp; sent to press by{' '}
        <AnimatedLink
          href="https://www.klair.co"
          variant="arrow"
          className="font-semibold tracking-[inherit] whitespace-nowrap text-ink hover:text-vermilion"
        >
          the Klair works ✦ klair.co
        </AnimatedLink>
      </div>
    </footer>
  );
}
