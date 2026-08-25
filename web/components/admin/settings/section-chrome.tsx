'use client';

// The chrome SettingsPanel wraps around whichever section is on screen: the one
// sticky save bar, and the Advanced disclosure.
//
// Both need to be owned by the panel (the bar is sticky against the panel's
// scroll container; the search box has to be able to open a disclosure it is
// jumping into) while being AUTHORED inside the section, next to the fields
// they belong to. The bar solves that with a portal — SaveBar still renders in
// the section's tree, its output lands in the panel's sticky slot — so a
// section keeps its own save closure, its own note and its own error scoping,
// and no section had to hand a patch builder upwards.

import {
  Children,
  createContext,
  useContext,
  useEffect,
  useId,
  type ReactNode,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { Pill } from '../ui';

export interface SectionChromeValue {
  /**
   * Portal target for the sticky save bar's buttons, or null when the bar is
   * hidden (nothing unsaved). A SaveBar with nowhere to render renders nothing,
   * which is what makes "no changes → no save button" fall out for free.
   */
  saveSlot: HTMLElement | null;
  /**
   * Report dirtiness for a section whose editable state does NOT live in
   * FormState — the panel cannot diff what it does not hold. See
   * `SectionSpec.formKeys`.
   */
  reportDirty: (id: string, dirty: boolean) => void;
  /** Whether the active section's Advanced disclosure is open. */
  advOpen: boolean;
  setAdvOpen: (open: boolean) => void;
}

const NOOP_CHROME: SectionChromeValue = {
  saveSlot: null,
  reportDirty: () => {},
  advOpen: true,
  setAdvOpen: () => {},
};

const SectionChromeContext = createContext<SectionChromeValue>(NOOP_CHROME);

export const SectionChromeProvider = SectionChromeContext.Provider;

/**
 * Outside a provider this returns a chrome with no save slot and Advanced
 * permanently OPEN. That is the safe default in both directions: a section
 * rendered somewhere else (a dialog, a test) shows all of its fields rather
 * than hiding half of them behind a disclosure that nothing can open.
 */
export const useSectionChrome = () => useContext(SectionChromeContext);

/**
 * Register a section's dirtiness with the panel for as long as this component
 * is mounted, and withdraw it on unmount so a section left dirty and navigated
 * away from does not keep the previous section's bar alive.
 */
export function useReportDirty(dirty: boolean | undefined) {
  const { reportDirty } = useSectionChrome();
  const id = useId();
  useEffect(() => {
    if (dirty === undefined) return;
    reportDirty(id, dirty);
    return () => reportDirty(id, false);
  }, [dirty, id, reportDirty]);
}

interface AdvancedProps {
  /**
   * What the closed row says the disclosure holds. Section-specific, because
   * "thresholds and fallbacks" is right for the tagger and wrong for the
   * danger zone.
   */
  note?: string;
  children?: ReactNode;
}

/**
 * The per-section Advanced disclosure.
 *
 * Open/closed state lives in the panel, not here, so a search result can open
 * the disclosure it is scrolling into. The count on the right is the number of
 * cards inside — a straight `Children.count`, which is honest as long as
 * sections put one card per child (they do).
 */
export function Advanced({ note, children }: AdvancedProps) {
  const { advOpen, setAdvOpen } = useSectionChrome();
  const count = Children.toArray(children).filter(Boolean).length;
  if (count === 0) return null;
  return (
    <div className="grid gap-4">
      <button
        type="button"
        onClick={() => setAdvOpen(!advOpen)}
        aria-expanded={advOpen}
        className="flex w-full cursor-pointer items-center gap-3 border border-ink bg-[var(--ink-softer)] p-3.5 text-left font-[inherit] transition-colors hover:bg-[var(--ink-soft)]"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-vermilion transition-transform', advOpen && 'rotate-90')}
          strokeWidth={2.5}
          aria-hidden
        />
        <span className="text-[11px] font-bold tracking-[0.25em] text-ink uppercase">
          Advanced
        </span>
        <span className="hidden min-w-0 text-[12px] text-muted sm:inline">
          {advOpen ? 'the rest of this section' : note || 'thresholds, fallbacks and the settings you set once'}
        </span>
        <Pill className="ml-auto shrink-0">{count}</Pill>
      </button>
      {advOpen && (
        <div className="grid gap-4 border-l border-[var(--separator-strong)] pl-4">
          {children}
        </div>
      )}
    </div>
  );
}
