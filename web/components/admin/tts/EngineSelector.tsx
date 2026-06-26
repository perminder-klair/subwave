'use client';
// Radio-card grid for picking a TTS engine. Replaces the cramped 5-button
// segmented control on both the Personas voice card and the Settings voice tab:
// every engine is a selectable card showing its name, a one-line blurb and a
// live status badge (ready / sidecar off / no key) so availability is visible
// before you select. Styled on the newsprint RadioOption pattern. Tailwind-only
// (no inline styles — issue #50).
import { cn } from '../../../lib/cn';
import { ENGINE_META, engineStatus } from './engineMeta';

interface EngineSelectorProps {
  // Currently selected engine id.
  value: string;
  // Which engines to show as cards (Personas: all 5; Settings: data.tts.engines).
  engineIds: string[];
  // SettingsResponse.tts.available — drives the per-card status badge.
  available?: Record<string, boolean>;
  onChange: (id: string) => void;
  className?: string;
}

export function EngineSelector({ value, engineIds, available, onChange, className }: EngineSelectorProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Voice engine"
      className={cn('grid grid-cols-2 gap-2.5 md:grid-cols-3', className)}
    >
      {engineIds.map(id => {
        const meta = ENGINE_META[id];
        const status = engineStatus(id, available);
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={cn(
              'grid cursor-pointer content-start gap-1.5 border p-3 text-left font-[inherit]',
              active
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-ink bg-transparent hover:bg-[var(--ink-softer)]',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    'size-2.5 flex-none rounded-full border',
                    active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-ink bg-transparent',
                  )}
                />
                <span
                  className={cn(
                    'truncate text-[11px] font-bold tracking-[0.18em] uppercase',
                    active ? 'text-vermilion' : 'text-ink',
                  )}
                >
                  {meta?.label || id}
                </span>
              </span>
              {status.label && (
                <span
                  className={cn(
                    'flex-none border px-1.5 py-[2px] text-[9px] font-bold tracking-[0.1em] uppercase',
                    status.tone === 'warn'
                      ? 'border-[var(--danger)] text-[var(--danger)]'
                      : 'border-[color:var(--separator-strong)] text-muted',
                  )}
                >
                  {status.label}
                </span>
              )}
            </div>
            <span className="text-[10px] leading-[1.4] text-muted">{meta?.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}
