'use client';

// The Stats page's contents as a tuner dial, pinned under the top bar. The
// sections sit along a slide-rule scale like stations: the needle follows the
// reader down the page, and a station is a link to its section. The sums are in
// lib/statsDial.ts.
//
// The scroll path writes the needle straight to the DOM, so a frame costs no
// render; React only hears about a change of station.

import { useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/cn';
import { dialPosition, stationAt } from '../../../lib/statsDial';
import { TickScale } from './parts';

const STATIONS = [
  { id: 'stats-glance', label: 'At a glance' },
  { id: 'stats-week', label: 'This week' },
  { id: 'stats-audience', label: 'Audience' },
  { id: 'stats-on-air', label: 'On air' },
  { id: 'stats-engine', label: 'Engine room' },
  { id: 'stats-rack', label: 'The rack' },
  { id: 'stats-diagnostics', label: 'Diagnostics' },
] as const;

// Clear air between the pinned dial and a section it jumped to.
const LANDING_GAP = 12;

export function SectionDial() {
  const navRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<HTMLSpanElement>(null);
  // A followed link holds the needle until the reader moves on: the last sections
  // can't reach the reading line, so it would name their neighbour. `landed` is
  // where its scroll came to rest, so a scrollbar drag, which fires none of the
  // events `release` hears, still lets go.
  const heldRef = useRef<{ index: number; landed?: number } | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const nav = navRef.current;
    const strip = stripRef.current;
    const needle = needleRef.current;
    const page = nav?.parentElement;
    if (!nav || !strip || !needle || !page) return;
    let frame = 0;

    const tune = () => {
      frame = 0;
      const { landed } = heldRef.current ?? {};
      if (landed != null && Math.abs(window.scrollY - landed) > 1) heldRef.current = null;
      const sections = STATIONS.flatMap(s => document.getElementById(s.id) ?? []);
      const last = sections[sections.length - 1];
      if (!last) return;
      const scroller = document.documentElement;
      const position = heldRef.current?.index ?? dialPosition({
        tops: sections.map(s => s.getBoundingClientRect().top),
        end: last.getBoundingClientRect().bottom,
        rest: nav.getBoundingClientRect().bottom + 2 * LANDING_GAP,
        viewport: window.innerHeight,
        scrolled: window.scrollY,
        remaining: scroller.scrollHeight - window.scrollY - window.innerHeight,
      });
      const along = position / STATIONS.length;
      // Travel stops a needle's width short, or the far end would clip it.
      needle.style.left = `calc((100% - 2px) * ${along})`;
      // Following the scroll stays tight; a followed link is a slow swing.
      needle.style.transitionDuration = heldRef.current == null ? '' : '600ms';
      // On a phone the scale is wider than the strip, so it slides to keep the
      // needle in view. Past a phone this is a no-op.
      strip.scrollLeft = along * strip.scrollWidth - strip.clientWidth / 3;
      setActive(stationAt(position, STATIONS.length));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(tune);
    };

    // The top bar wraps on a phone, so its height is read rather than assumed.
    // Every section's landing depends on it, hash links from the cards included.
    const measure = () => {
      const top = document.querySelector('.admin-booth-bar')?.getBoundingClientRect().height ?? 0;
      nav.style.top = `${top}px`;
      page.style.setProperty('--stats-clearance', `${top + nav.offsetHeight + LANDING_GAP}px`);
      schedule();
    };
    measure();

    // Any link to a section, on the dial or in a card. Captured, to get in ahead
    // of next/link, which would otherwise take the click for its own jump.
    const follow = (event: MouseEvent) => {
      const { hash } = (event.target as Element).closest('a') ?? {};
      const index = STATIONS.findIndex(s => `#${s.id}` === hash);
      // A new-tab click stays a plain link.
      if (index < 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      heldRef.current = { index };
      schedule();
      // A keyboard press (detail 0) keeps the link's own jump, which moves focus
      // into the section; scrollIntoView would leave it on the link.
      if (event.detail === 0) return;
      event.preventDefault();
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // A frame on, so the scroll sees whatever the link's own click just opened.
      requestAnimationFrame(() => {
        document.getElementById(STATIONS[index]!.id)?.scrollIntoView({ behavior: still ? 'auto' : 'smooth' });
      });
    };
    const release = () => {
      if (heldRef.current == null) return;
      heldRef.current = null;
      schedule();
    };
    const land = () => {
      if (heldRef.current) heldRef.current.landed ??= window.scrollY;
    };
    const resized = new ResizeObserver(measure);
    resized.observe(page);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('scrollend', land);
    window.addEventListener('resize', measure);
    window.addEventListener('click', follow, { capture: true });
    const interrupts = ['wheel', 'touchmove', 'keydown'];
    for (const type of interrupts) window.addEventListener(type, release, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('scrollend', land);
      window.removeEventListener('resize', measure);
      window.removeEventListener('click', follow, { capture: true });
      for (const type of interrupts) window.removeEventListener(type, release);
    };
  }, []);

  return (
    <nav
      ref={navRef}
      aria-label="Stats sections"
      className="sticky top-[49px] z-10 border border-ink bg-[var(--card-bg)]"
    >
      <div ref={stripRef} className="[scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden">
        <div className="relative min-w-[700px]">
          <ol className="m-0 grid list-none grid-cols-7 p-0">
            {STATIONS.map((station, i) => (
              <li key={station.id} className="min-w-0">
                <a
                  href={`#${station.id}`}
                  aria-current={i === active ? 'location' : undefined}
                  className={cn(
                    'block truncate pt-2.5 pr-1 pb-6 pl-2.5 font-mono text-[10px] tracking-[0.16em] uppercase no-underline',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]',
                    i === active ? 'font-bold text-ink' : 'text-muted hover:text-ink',
                  )}
                >
                  {station.label}
                </a>
              </li>
            ))}
          </ol>
          <TickScale
            max={STATIONS.length}
            step={1}
            minors={10}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-4 border-b-0"
          />
          <span
            ref={needleRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-vermilion transition-[left] duration-150 ease-out motion-reduce:transition-none"
          />
        </div>
      </div>
    </nav>
  );
}
