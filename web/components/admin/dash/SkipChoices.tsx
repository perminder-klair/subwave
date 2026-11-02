'use client';

import { cn } from '../../../lib/cn';
import { skipChoices, type SkipChoice, type SkipTarget } from './never-play';

/* The Skip dialog's choice: skip only, or never play the track, its album or
   its artist. Controlled: the Dash resets it to a plain skip on every open, so
   a block is never the choice a stray Enter confirms. */
export function SkipChoices({
  target,
  value,
  onChange,
}: {
  target: SkipTarget;
  value: SkipChoice;
  onChange: (choice: SkipChoice) => void;
}) {
  return (
    <div className="mt-3.5 grid gap-2">
      <div role="radiogroup" aria-label="What the skip does" className="grid gap-1.5">
        {skipChoices(target).map(o => {
          const on = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!!o.disabled}
              onClick={() => onChange(o.id)}
              className={cn(
                'v3-focus cursor-pointer px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
                on ? 'border border-ink bg-ink-soft' : 'border border-separator-strong',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="inline-flex size-3.5 flex-none items-center justify-center border border-ink">
                  <span className={cn('size-1.5', on && 'bg-vermilion')} />
                </span>
                <span className="font-mono text-[11px] font-bold tracking-[0.16em] text-ink uppercase">
                  {o.label}
                </span>
              </span>
              <span className="mt-1 block pl-[22px] text-xs leading-normal text-muted">
                {o.disabled ?? o.detail}
              </span>
            </button>
          );
        })}
      </div>
      <p className="m-0 text-xs leading-normal text-muted">
        A block is absolute, listener requests included. Lift it from Library → Blocked.
      </p>
    </div>
  );
}
