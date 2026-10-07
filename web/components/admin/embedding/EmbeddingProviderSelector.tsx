'use client';
import { cn } from '../../../lib/cn';
import { PROVIDER_META, providerStatus, type ProviderStatus } from '../llm/providerMeta';

interface EmbeddingProviderSelectorProps {
  // The parent resolves a blank stored value to the DJ's provider before passing it
  // here, so one card is always active.
  value: string;
  // SettingsResponse.embedding.providers, possibly with a stale explicit choice prepended.
  providerIds: string[];
  // SettingsResponse.env — which cloud key vars are present; drives the badge.
  env?: Record<string, unknown>;
  onChange: (id: string) => void;
  className?: string;
}

export function EmbeddingProviderSelector({
  value,
  providerIds,
  env,
  onChange,
  className,
}: EmbeddingProviderSelectorProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Embedding provider"
      className={cn('grid grid-cols-2 gap-2.5 md:grid-cols-3', className)}
    >
      {providerIds.map(id => {
        const meta = PROVIDER_META[id];
        return (
          <ProviderCard
            key={id}
            active={value === id}
            label={meta?.label || id}
            blurb={meta?.blurb}
            status={providerStatus(id, env)}
            onClick={() => onChange(id)}
          />
        );
      })}
    </div>
  );
}

function ProviderCard({
  active,
  label,
  blurb,
  status,
  onClick,
}: {
  active: boolean;
  label: string;
  blurb?: string;
  status: ProviderStatus;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'grid cursor-pointer content-start gap-1.5 border p-3 text-left font-[inherit]',
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
          {label}
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="min-w-0 text-[9px] leading-[1.4] text-muted">{blurb}</span>
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
}
