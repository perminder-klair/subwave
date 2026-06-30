'use client';
// Radio-card grid for picking a TTS engine. Replaces the cramped 6-button
// segmented control on both the Personas voice card and the Settings voice tab:
// every engine is a selectable card showing its name, a one-line blurb and a
// live status badge (ready / starting… / engine off / sidecar off / no key) so
// availability is visible before you select. Styled on the newsprint
// RadioOption pattern. Tailwind-only
// (no inline styles — issue #50).
import { cn } from '../../../lib/cn';
import { ENGINE_META, engineStatus, engineEnableHint, type EngineAvailability } from './engineMeta';

interface EngineSelectorProps {
  // Currently selected engine id.
  value: string;
  // Which engines to show as cards (Personas: all 6; Settings: data.tts.engines).
  engineIds: string[];
  // SettingsResponse.tts.available — drives the per-card status badge.
  available?: EngineAvailability;
  onChange: (id: string) => void;
  className?: string;
}

export function EngineSelector({ value, engineIds, available, onChange, className }: EngineSelectorProps) {
  const hint = engineEnableHint(value, available);
  return (
    <div className={cn('grid gap-2.5', className)}>
      <div
        role="radiogroup"
        aria-label="Voice engine"
        className="grid grid-cols-2 gap-2.5 md:grid-cols-3"
      >
        {engineIds.map(id => {
          const meta = ENGINE_META[id];
          const status = engineStatus(id, available);
          const active = value === id;
          const isUnavailable = available?.[id] === false && status.label !== 'starting…';
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(id)}
              className={cn(
                'grid cursor-pointer content-start gap-1.5 border p-3 text-left font-[inherit]',
                isUnavailable && !active && 'opacity-60',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-ink bg-transparent hover:bg-[var(--ink-softer)]',
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
      {hint && (
        <p role="status" className="border border-[var(--separator-strong)] bg-[var(--ink-softer)] px-3 py-2 text-[11px] leading-[1.55] text-muted">
          {hint.reason}.
          {hint.action && <> Next step: <code>{hint.action}</code>.</>}
        </p>
      )}
    </div>
  );
}
