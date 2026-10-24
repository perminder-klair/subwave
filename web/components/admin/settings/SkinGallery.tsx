'use client';

import { DEFAULT_SKIN_ID, SKINS } from '../../skins';
import SkinPreview from '../../skins/SkinPreview';
import { Pill } from '../ui';
import { cn } from '../../../lib/cn';

// Each card frames the skin's miniature (components/skins/SkinPreview, shared
// with the listener's Appearance menu); the card is the `group` its motion gates on.

interface SkinGalleryProps {
  activeSkinId?: string;
  busy: boolean;
  onChoose: (id: string) => void;
}

export function SkinGallery({ activeSkinId, busy, onChoose }: SkinGalleryProps) {
  const active = SKINS.some(s => s.id === activeSkinId) ? activeSkinId : DEFAULT_SKIN_ID;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {SKINS.map((s, i) => {
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={isActive}
            aria-label={`Set station skin to ${s.name}`}
            disabled={busy || isActive}
            onClick={() => { if (!busy && !isActive) onChoose(s.id); }}
            className={cn(
              'group relative flex flex-col overflow-hidden border text-left transition-all duration-200',
              'focus-visible:ring-2 focus-visible:ring-vermilion focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-none',
              isActive
                ? 'border-vermilion shadow-[0_0_0_1px_var(--accent)]'
                : 'cursor-pointer border-ink hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--ink)]',
            )}
          >
            <div
              className={cn(
                'relative aspect-[16/10] w-full overflow-hidden border-b',
                isActive ? 'border-vermilion bg-[var(--accent-soft)]' : 'border-ink bg-field',
              )}
            >
              <SkinPreview id={s.id} />
              <span className="absolute top-1.5 left-1.5 font-mono text-[9px] leading-none font-bold tracking-[0.14em] text-muted">
                {String(i + 1).padStart(2, '0')}
              </span>
              {!isActive && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-full bg-ink px-2 py-1 text-center text-[9px] font-bold tracking-[0.2em] text-bg uppercase transition-transform duration-200 group-hover:translate-y-0">
                  Set as station skin
                </span>
              )}
            </div>
            <div className="flex items-start justify-between gap-2 p-3">
              <div className="grid min-w-0 gap-0.5">
                <span className="text-[12px] font-bold tracking-[0.14em] text-ink uppercase">
                  {s.name}
                </span>
                {s.description && (
                  <span className="text-[10.5px] leading-[1.45] text-muted">{s.description}</span>
                )}
              </div>
              {isActive && <Pill tone="accent" dot>on air</Pill>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
