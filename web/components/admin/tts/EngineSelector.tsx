'use client';
// Radio-card grid for picking a TTS engine. Replaces the cramped 5-button
// segmented control on both the Personas voice card and the Settings voice tab:
// every engine is a selectable card showing its name, a one-line blurb and a
// live status badge (ready / sidecar off / no key) so availability is visible
// before you select. Unavailable engines (except the currently-selected one)
// are disabled with a tooltip explaining why — the operator can't pick a dead
// engine, but an existing setup isn't stranded behind a greyed-out option.
// Styled on the newsprint RadioOption pattern. Tailwind-only (no inline
// styles — issue #50).
import { cn } from '../../../lib/cn';
import { ENGINE_META, engineStatus, engineHint, type TtsAvailable } from './engineMeta';

interface EngineSelectorProps {
  // Currently selected engine id.
  value: string;
  // Which engines to show as cards (Personas: all 5; Settings: data.tts.engines).
  engineIds: string[];
  // SettingsResponse.tts.available — drives the per-card status badge and the
  // disabled state. A missing/undefined key means "assumed up" (no badge, not
  // disabled). Only `=== false` gates.
  available?: TtsAvailable;
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
        // Disable when the engine is genuinely unavailable AND it isn't the
        // currently-selected value — an existing persona/stations on a dead
        // engine keeps working (just falls back), and the operator can still
        // click it to switch away.
        const isDead = available?.[id] === false;
        const isDisabled = isDead && !active;
        const hint = isDead ? engineHint(id, available) : undefined;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={isDisabled || undefined}
            title={hint}
            onClick={() => { if (!isDisabled) onChange(id); }}
            className={cn(
              'grid content-start gap-1.5 border p-3 text-left font-[inherit]',
              isDisabled
                ? 'cursor-not-allowed opacity-40'
                : 'cursor-pointer',
              active
                ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-ink bg-transparent',
              !isDisabled && !active && 'hover:bg-[var(--ink-softer)]',
            )}
          >
            {/* Title row — dot + name only, full card width. The status badge
                moved to the bottom row so it never crowds long engine names
                (CHATTERBOX / POCKETTTS), matching the LLM ProviderSelector. */}
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
            {/* Bottom row — blurb on the left, status badge pinned bottom-right. */}
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
  );
}
