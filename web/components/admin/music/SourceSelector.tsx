'use client';
// Radio-card grid for picking the active music source. Mirrors the LLM
// ProviderSelector: server-authoritative id list, one selectable card each with
// name + one-line blurb + kind badge. Tailwind-only, no inline styles.
import { cn } from '../../../lib/cn';
import { SOURCE_META } from './sourceMeta';

interface SourceSelectorProps {
  value: string;
  // Pass SettingsResponse.music.sources so the grid stays server-authoritative.
  sourceIds: string[];
  onChange: (id: string) => void;
  className?: string;
}

export function SourceSelector({ value, sourceIds, onChange, className }: SourceSelectorProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Music source"
      className={cn('grid grid-cols-2 gap-2.5', className)}
    >
      {sourceIds.map(id => {
        const meta = SOURCE_META[id];
        const active = value === id;
        const kindLabel = meta?.kind === 'local' ? 'local' : 'server';
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
            <span className="text-[11px] leading-[1.4] text-muted">{meta?.blurb || ''}</span>
            <span className="text-[9px] font-bold tracking-[0.16em] text-muted uppercase">{kindLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
