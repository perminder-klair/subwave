'use client';
// Radio-card grid for picking a TTS engine. Replaces the cramped 6-button
// segmented control on both the Personas voice card and the Settings voice tab:
// every engine is a selectable card showing its name, a one-line blurb and a
// live status badge (ready / sidecar off / no key) so availability is visible
// before you select. Unavailable engines are visually muted but always remain
// clickable — disabling them would hide the inline setup guidance (#238) behind
// a grayed-out card the operator can't reach. Selecting an unavailable engine
// shows a persistent accessible note with the reason and enable step instead.
// Styled on the newsprint RadioOption pattern. Tailwind-only (no inline
// styles — issue #50).
import { cn } from '../../../lib/cn';
import { ENGINE_META, engineStatus, engineEnableHint, type TtsAvailable } from './engineMeta';

interface EngineSelectorProps {
  // Currently selected engine id.
  value: string;
  // Which engines to show as cards (Personas: all 6; Settings: data.tts.engines).
  engineIds: string[];
  // SettingsResponse.tts.available — drives the per-card status badge and muted
  // state. A missing/undefined key means "assumed up" (no badge, not muted).
  // Only `=== false` gates.
  available?: TtsAvailable;
  onChange: (id: string) => void;
  className?: string;
}

export function EngineSelector({ value, engineIds, available, onChange, className }: EngineSelectorProps) {
  const hint = engineEnableHint(value, available);
  return (
    <div className={cn('grid gap-2.5', className)}>
      <div role="radiogroup" aria-label="Voice engine" className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        {engineIds.map(id => {
          const meta = ENGINE_META[id];
          const status = engineStatus(id, available);
          const active = value === id;
          // Mute the card when the engine is unavailable, but keep it clickable
          // so the operator can select it and read the enable hint below the grid.
          const isDead = available?.[id as keyof TtsAvailable] === false;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(id)}
              className={cn(
                'grid cursor-pointer content-start gap-1.5 border p-3 text-left font-[inherit]',
                isDead && !active && 'opacity-60',
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
      {/* Persistent accessible note when the selected engine is unavailable.
          Shown as a real DOM element (not a hover title) so it's visible on
          touch and readable by screen readers. The existing post-selection
          callouts (#238) remain unchanged — this note is pre-selection
          guidance that appears as soon as the operator picks a dead engine. */}
      {hint && (
        <p role="status" className="border border-[var(--danger)] px-3 py-2 text-[11px] leading-[1.55] text-[var(--danger)]">
          {hint.reason}.
          {hint.action && (
            <> To enable: <code>{hint.action}</code>.</>
          )}
          {' '}Until then this persona falls back to the default engine.
        </p>
      )}
    </div>
  );
}
