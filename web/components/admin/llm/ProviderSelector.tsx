'use client';
// Radio-card grid for picking the primary LLM provider. Replaces the plain
// dropdown on the Settings LLM tab: every provider is a selectable card showing
// its name, a one-line blurb and a live status badge (local / self-host / key
// set / no key) so key availability is visible before you switch and save — the
// #1 LLM misconfiguration is routing to a cloud provider whose key isn't set.
// Styled to match the TTS EngineSelector (newsprint RadioOption pattern).
// Tailwind-only, no inline styles (issue #50). The fallback leg keeps the
// dropdown — cards there would double the tab's height for a secondary control.
import { cn } from '../../../lib/cn';
import { PROVIDER_META, providerStatus } from './providerMeta';

interface ProviderSelectorProps {
  // Currently selected provider id.
  value: string;
  // Which providers to show as cards — pass SettingsResponse.llm.providers so the
  // grid stays server-authoritative (order + future additions).
  providerIds: string[];
  // SettingsResponse.env — which cloud key vars are present; drives the badge.
  env?: Record<string, unknown>;
  // false for the onboarding wizard, where there's no live env yet — cloud
  // providers then read as a neutral "needs key" instead of a red "no key".
  keyAware?: boolean;
  onChange: (id: string) => void;
  className?: string;
}

export function ProviderSelector({ value, providerIds, env, keyAware = true, onChange, className }: ProviderSelectorProps) {
  return (
    <div
      role="radiogroup"
      aria-label="LLM provider"
      className={cn('grid grid-cols-2 gap-2.5 md:grid-cols-3', className)}
    >
      {providerIds.map(id => {
        const meta = PROVIDER_META[id];
        const status = providerStatus(id, env, keyAware);
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
            {/* Title row — dot + name only, full card width. The status badge
                moved to the bottom row so it never crowds long names
                (OPENROUTER / ANTHROPIC / OpenAI-compatible). */}
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
