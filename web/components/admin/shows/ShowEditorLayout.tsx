'use client';

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/cn';

const SECTIONS = [
  { id: 'identity', label: 'Show & hosts', hint: 'Name, tags and voices' },
  { id: 'episode', label: 'Episode', hint: 'Brief, preparation and speech' },
  { id: 'music', label: 'Music', hint: 'Mood, genre and era' },
  { id: 'playlists', label: 'Playlists', hint: 'Sources and exclusions' },
  { id: 'timing', label: 'Timing', hint: 'Track lengths and handoff' },
  { id: 'appearance', label: 'Appearance', hint: 'The player on air' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function ShowEditorLayout({
  editorRef,
  children,
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const jumpScrollTop = useRef<number | null>(null);
  const [active, setActive] = useState<SectionId>('identity');

  useEffect(() => {
    const row = rootRef.current?.querySelector<HTMLElement>('[data-show-navigation]');
    const button = row?.querySelector<HTMLButtonElement>('[aria-current="location"]');
    if (!row || !button || row.scrollWidth <= row.clientWidth) return;
    const rail = row.getBoundingClientRect();
    const target = button.getBoundingClientRect();
    if (target.left < rail.left + 4) row.scrollBy({ left: target.left - rail.left - 4, behavior: 'instant' });
    else if (target.right > rail.right - 4) row.scrollBy({ left: target.right - rail.right + 4, behavior: 'instant' });
  }, [active]);

  useEffect(() => {
    const root = rootRef.current;
    const scroll = root?.closest<HTMLElement>('.v3-scroll');
    if (!root || !scroll) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (jumpScrollTop.current === scroll.scrollTop) return;
      jumpScrollTop.current = null;
      const top = scroll.getBoundingClientRect().top + 110;
      let current: SectionId = 'identity';
      for (const section of SECTIONS) {
        const target = root.querySelector<HTMLElement>(`[data-show-section="${section.id}"]`);
        if (target && target.getBoundingClientRect().top <= top) current = section.id;
      }
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) current = 'appearance';
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroll.addEventListener('scroll', schedule, { passive: true });
    update();
    return () => {
      scroll.removeEventListener('scroll', schedule);
      cancelAnimationFrame(frame);
    };
  }, []);

  const jump = (id: SectionId) => {
    const section = rootRef.current?.querySelector<HTMLElement>(`[data-show-section="${id}"]`);
    const heading = section?.querySelector<HTMLElement>('h2');
    heading?.focus({ preventScroll: true });
    section?.scrollIntoView({ block: 'start', behavior: 'instant' });
    jumpScrollTop.current = section?.closest<HTMLElement>('.v3-scroll')?.scrollTop ?? null;
    setActive(id);
  };

  return (
    <div
      ref={node => {
        rootRef.current = node;
        editorRef.current = node;
      }}
      className="mx-auto grid max-w-[1360px] gap-6 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-8"
    >
      <nav
        aria-label="Show editor sections"
        className="sticky top-0 z-10 -mx-5 min-w-0 self-start border-b border-ink bg-bg px-5 py-2 sm:-mx-8 sm:px-8 lg:mx-0 lg:border-0 lg:px-0 lg:py-0"
      >
        <p className="caption mb-3 hidden text-muted lg:block">Show setup</p>
        <div data-show-navigation className="flex gap-1 overflow-x-auto pb-1 lg:grid lg:gap-1.5 lg:overflow-visible">
          {SECTIONS.map(section => (
            <button
              key={section.id}
              type="button"
              aria-current={active === section.id ? 'location' : undefined}
              onClick={() => jump(section.id)}
              className={cn(
                'v3-focus flex-none cursor-pointer border px-3 py-2.5 text-left text-xs transition-colors lg:py-3',
                active === section.id
                  ? 'border-ink bg-ink text-bg'
                  : 'border-transparent text-muted hover:bg-[var(--ink-softer)] hover:text-ink',
              )}
            >
              <span className="block font-semibold">{section.label}</span>
              <span
                className={cn(
                  'mt-1 hidden text-[10px] leading-relaxed lg:block',
                  active === section.id ? 'opacity-75' : 'text-muted',
                )}
              >
                {section.hint}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-6 hidden max-w-[24ch] text-[11px] leading-relaxed text-muted lg:block">
          Set up the show here. Choose when it airs on the schedule grid.
        </p>
      </nav>

      <div className="grid min-w-0 gap-8 lg:gap-10">{children}</div>
    </div>
  );
}

export function ShowEditorSection({
  section,
  title,
  description,
  children,
}: {
  section: SectionId;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const uid = useId();
  return (
    <section
      data-show-section={section}
      aria-labelledby={`${uid}-heading`}
      className="min-w-0 scroll-mt-24 lg:scroll-mt-6"
    >
      <div className="mb-4 grid gap-1 border-b border-separator-strong pb-3">
        <h2 id={`${uid}-heading`} tabIndex={-1} className="v3-focus w-fit text-lg font-bold tracking-[-0.02em]">
          {title}
        </h2>
        <p className="text-xs leading-relaxed text-muted">{description}</p>
      </div>
      <div className="grid gap-4 [&_[data-slot=field-description]]:text-xs [&_[data-slot=field-label]]:text-[10px] [&_[data-slot=field-label]]:font-bold [&_[data-slot=field-label]]:tracking-[0.16em] [&_[data-slot=field-label]]:uppercase">
        {children}
      </div>
    </section>
  );
}

export function ShowFieldHelp({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="text-xs">
      <summary className="v3-focus w-fit cursor-pointer font-semibold text-ink">{title}</summary>
      <div className="mt-2 max-w-[72ch] leading-relaxed text-muted">{children}</div>
    </details>
  );
}
