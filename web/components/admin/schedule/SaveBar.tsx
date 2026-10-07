'use client';


import { AnimatePresence, m } from 'motion/react';
import { useEffect, useState } from 'react';
import { Button } from '../../ui/button';
import { Mu } from './bits';

export interface SaveBarProps {
  /** Hours differing from the server copy. 0 hides the bar. */
  dirty: number;
  busy: boolean;
  onReview: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

/** The ⌘S / Ctrl+S hint — resolved after mount so SSR and the client agree. */
function useSaveChord(): string {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent));
  }, []);
  return mac ? '⌘S' : 'Ctrl+S';
}

export default function SaveBar({ dirty, busy, onReview, onDiscard, onSave }: SaveBarProps) {
  const chord = useSaveChord();
  return (
    <AnimatePresence>
      {dirty > 0 && (
        <m.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          // z-30 clears the board's sticky hour rail (z-10) and stays under
          // the Review / leave-guard modals (z-40+).
          className="sticky bottom-0 z-30 border-t border-ink bg-[var(--card-bg)] shadow-[0_-6px_18px_-12px_rgba(0,0,0,0.45)]"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 sm:px-[30px]">
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span aria-hidden="true" className="size-2 flex-none animate-pulse bg-[var(--accent)]" />
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="flex-none font-mono text-[11.5px] font-bold tracking-[0.06em] text-ink">
                  {dirty} unsaved edit{dirty === 1 ? '' : 's'}
                </span>
                <Mu className="min-w-0 text-[9px]">
                  nothing is on air until you save the week
                </Mu>
              </span>
            </span>
            <span className="ml-auto flex w-full flex-none items-center gap-2 sm:w-auto">
              <Button
                variant="ghost"
                size="sm"
                className="min-h-9 sm:min-h-0"
                onClick={onReview}
                disabled={busy}
              >
                Review
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-9 sm:min-h-0"
                onClick={onDiscard}
                disabled={busy}
              >
                Discard
              </Button>
              <Button
                variant="accent"
                size="sm"
                className="ml-auto min-h-9 sm:ml-0 sm:min-h-0"
                onClick={onSave}
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Save the week'}
                {!busy && (
                  <span aria-hidden="true" className="ml-1.5 hidden opacity-70 sm:inline">
                    {chord}
                  </span>
                )}
              </Button>
            </span>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
