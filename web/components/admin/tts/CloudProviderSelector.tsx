'use client';
// Radio-card grid for picking a Cloud TTS provider, shared by the Settings voice
// tab and the per-persona voice slot. Same affordance as EngineSelector one
// level up; the badge shows "this one has no key" before the click.
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn';
import {
  CLOUD_PROVIDER_META, cloudProviderStatus,
  type CloudProviderAvailability, type CloudProviderStatusOpts,
} from './cloudProviderMeta';

interface CloudProviderSelectorProps {
  value: string;
  // The controller's data.tts.cloudProviders — never hardcoded here, so a
  // provider added server-side shows up without a UI change.
  providerIds: string[];
  availability?: CloudProviderAvailability;
  statusOpts?: CloudProviderStatusOpts;
  onChange: (id: string) => void;
  // Shown under the grid whatever the selection, above the enable hint.
  hint?: ReactNode;
  // The "how to fix it" note for a provider that can't speak. Off where the fix
  // is the very next field.
  enableHint?: boolean;
  className?: string;
  gridClassName?: string;
}

export function CloudProviderSelector({
  value, providerIds, availability, statusOpts, onChange, hint,
  enableHint = true, className, gridClassName,
}: CloudProviderSelectorProps) {
  const selected = cloudProviderStatus(value, availability, statusOpts);
  return (
    <div className={cn('grid gap-2.5', className)}>
      <div
        role="radiogroup"
        aria-label="Cloud TTS provider"
        // Two-up by default (the persona voice card is half-width); full-width
        // callers widen it themselves.
        className={cn('grid grid-cols-2 gap-2.5', gridClassName)}
      >
        {providerIds.map(id => {
          const meta = CLOUD_PROVIDER_META[id];
          const status = cloudProviderStatus(id, availability, statusOpts);
          const active = value === id;
          const muted = status.state === 'off';
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(id)}
              className={cn(
                'grid cursor-pointer content-start gap-1.5 border p-3 text-left font-[inherit]',
                muted && !active && 'opacity-60',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-ink bg-transparent hover:bg-[var(--ink-softer)]',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'size-2 flex-none rounded-full border',
                    active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-ink bg-transparent',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 text-[10px] font-bold tracking-[0.16em] break-words uppercase',
                    active ? 'text-vermilion' : 'text-ink',
                  )}
                >
                  {meta?.label || id}
                </span>
              </div>
              <div className="flex items-end justify-between gap-2">
                <span className="min-w-0 text-[9px] leading-[1.4] text-muted">{meta?.blurb}</span>
                {status.label && (
                  <span
                    className={cn(
                      'flex-none border px-1 py-[1px] text-[8px] font-bold tracking-[0.1em] uppercase',
                      status.tone === 'warn'
                        ? 'border-[var(--danger)] text-[var(--danger)]'
                        : 'border-[color:var(--separator-strong)] text-muted',
                    )}
                  >
                    {status.label}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {hint && <div className="field-hint max-w-[70ch]">{hint}</div>}
      {/* Enable hint for the selected provider. The live region stays mounted
          (content toggles) so screen readers reliably announce it — a region
          inserted on demand can miss its first announcement. Same pattern as
          EngineSelector. */}
      {enableHint && (
        <p
          role="status"
          className={cn(
            'text-[11px] leading-[1.55] text-muted',
            selected.hint && 'border border-[var(--separator-strong)] bg-[var(--ink-softer)] px-3 py-2',
          )}
        >
          {selected.hint && (
            <>
              {selected.hint.reason}.
              {selected.hint.action && <> Next step: <code>{selected.hint.action}</code>.</>}
            </>
          )}
        </p>
      )}
    </div>
  );
}
