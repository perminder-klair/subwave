'use client';
// Radio-card grid for picking the library tagger's embedding provider. Mirrors
// the LLM ProviderSelector / TTS EngineSelector card grids, with one extra card
// up front: "Follow LLM" (value ''), the default, which routes embeddings through
// whatever provider the DJ LLM already uses. Reuses the LLM provider descriptors
// and status logic — embedding providers are a subset of the LLM list — so the
// blurbs and key badges stay in lockstep with the LLM tab. Tailwind-only, no
// inline styles (issue #50).
import { cn } from '../../../lib/cn';
import { PROVIDER_META, providerStatus, type ProviderStatus } from '../llm/providerMeta';

interface EmbeddingProviderSelectorProps {
  // Currently selected provider id; '' means "follow the LLM provider".
  value: string;
  // Embedding-capable provider ids to show as cards (SettingsResponse.embedding
  // .providers, possibly with a stale explicit choice prepended). The "Follow
  // LLM" card is always rendered first, on top of these.
  providerIds: string[];
  // The LLM provider id the "Follow LLM" card resolves to right now — shown as
  // that card's blurb so the operator sees what "follow" means before saving.
  llmProvider: string;
  // SettingsResponse.env — which cloud key vars are present; drives the badge.
  env?: Record<string, unknown>;
  // '' for the Follow card, otherwise the provider id.
  onChange: (id: string) => void;
  className?: string;
}

export function EmbeddingProviderSelector({
  value,
  providerIds,
  llmProvider,
  env,
  onChange,
  className,
}: EmbeddingProviderSelectorProps) {
  const followLabel = PROVIDER_META[llmProvider]?.label || llmProvider;
  return (
    <div
      role="radiogroup"
      aria-label="Embedding provider"
      className={cn('grid grid-cols-2 gap-2.5 md:grid-cols-3', className)}
    >
      {/* Follow-LLM card — the default. Same card chrome as the rest, but its
          blurb is the live resolved LLM provider, not a static descriptor. */}
      <ProviderCard
        active={value === ''}
        label="Follow LLM"
        blurb={`Same as DJ · ${followLabel}`}
        status={{ label: 'default', tone: 'ok' }}
        onClick={() => onChange('')}
      />
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

// One selectable card — kept private to this file; the chrome is copied from the
// LLM ProviderSelector so the two grids read identically.
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
      {/* Title row — dot + name only, full card width. */}
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
      {/* Bottom row — blurb on the left, status badge pinned bottom-right. */}
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
