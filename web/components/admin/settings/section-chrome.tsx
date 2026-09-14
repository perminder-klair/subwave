'use client';

// The chrome SettingsPanel wraps around the active section: the sticky save bar
// and the Advanced disclosure. Both are owned by the panel (the bar is sticky
// against its scroll container, search must be able to open a disclosure) but
// authored inside the section; the bar portals out of the section's tree, so a
// section keeps its own save closure, note and error scoping.

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
   * Portal target for the sticky save bar's buttons, null when nothing is
   * unsaved. A SaveBar with nowhere to render renders nothing.
   */
  saveSlot: HTMLElement | null;
  /**
   * Report dirtiness for a section whose editable state does not live in
   * FormState; the panel cannot diff what it does not hold. See
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
 * Outside a provider: no save slot, Advanced permanently OPEN, so a section
 * rendered elsewhere shows every field rather than hiding some behind a
 * disclosure nothing can open.
 */
export const useSectionChrome = () => useContext(SectionChromeContext);

/**
 * Register a section's dirtiness with the panel while mounted; withdrawn on
 * unmount so a dirty section navigated away from does not keep the bar alive.
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
  /** What the closed row says the disclosure holds; section-specific. */
  note?: string;
  children?: ReactNode;
}

/**
 * The per-section Advanced disclosure. Open/closed state lives in the panel so a
 * search result can open the one it scrolls into. The count assumes sections put
 * one card per child.
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
