'use client';

import Link from 'next/link';

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
          <a
            href="https://github.com/perminder-klair/subwave"
            target="_blank"
            rel="noreferrer"
            className="bs-link tracking-[inherit]"
          >
            GitHub →
          </a>
        </span>
      </div>
      <div className="pb-[6px] text-center text-[10px] tracking-[0.3em] text-muted uppercase">
        — End of broadcast page · <Link href="/news" className="bs-link tracking-[inherit]">read the dispatches</Link> · <Link href="/listen" className="bs-link tracking-[inherit]">open the player</Link> —
      </div>
      <div className="pb-[6px] text-center text-[10px] tracking-[0.3em] text-balance text-muted uppercase">
        Set in type &amp; sent to press by{' '}
        <a
          href="https://www.klair.co"
          target="_blank"
          rel="noreferrer"
          className="bs-link tracking-[inherit] whitespace-nowrap"
        >
          the Klair works ✦ klair.co
        </a>
      </div>
    </footer>
  );
}
