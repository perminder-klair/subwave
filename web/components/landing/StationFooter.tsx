'use client';

import { AnimatedLink } from '@/components/ui/animated-link';

export default function StationFooter({ djName }: { djName?: string }) {
  return (
    <footer className="mt-16 flex flex-col gap-[14px]">
      <div className="bs-rule-double" />
      <div
        className="flex flex-col items-center gap-2 py-5 text-center text-[11px] tracking-[0.18em] text-muted uppercase
          sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-4 sm:text-left"
      >
        <span className="font-bold text-ink">SUB/WAVE · EST. 2026</span>
        <span>
          Navidrome · Liquidsoap · Icecast · your LLM · your voice
        </span>
        <span>
          {djName ? `${djName} on the desk · ` : ''}
          <AnimatedLink
            href="https://github.com/perminder-klair/subwave"
            variant="arrow"
            className="font-semibold tracking-[inherit] text-ink hover:text-vermilion"
          >
            GitHub
          </AnimatedLink>
        </span>
      </div>
      <div className="pb-[6px] text-center text-[10px] tracking-[0.3em] text-muted uppercase">
        — End of broadcast page ·{' '}
        <AnimatedLink href="/news" className="font-semibold tracking-[inherit] text-ink hover:text-vermilion">
          read the dispatches
        </AnimatedLink>{' '}
        ·{' '}
        <AnimatedLink href="/stations" className="font-semibold tracking-[inherit] text-ink hover:text-vermilion">
          browse the stations
        </AnimatedLink>{' '}
        ·{' '}
        <AnimatedLink href="/listen" className="font-semibold tracking-[inherit] text-ink hover:text-vermilion">
          open the player
        </AnimatedLink>{' '}
        —
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
