'use client';

// One row of the deck, sortable via dnd-kit (#1370). The grip is a real
// focusable handle carrying the sensor listeners, so the same gesture works with
// a mouse, a finger (long-press) and the arrow keys. It is not `sm:`-only: it is
// the touch affordance. The up/down buttons stay as the explicit keyboard path.

import { useCallback, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import { IconBtn, energyBgClass, energyLabel } from './bits';
import type { DraftTrack } from './types';
import { API, fmtDur } from './types';

export function TrackRow({
  id, track: t, index: i, total, duplicate, hot, onMove, onRemove,
}: {
  id: string;
  track: DraftTrack;
  index: number;
  total: number;
  duplicate: boolean;
  hot: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: (i: number) => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id });

  // dnd-kit owns the node ref; useDynamicStyle needs one of its own, because
  // inline `style={...}` is lint-forbidden here (#50).
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    rowRef.current = node;
    setNodeRef(node);
  }, [setNodeRef]);
  useDynamicStyle(rowRef, {
    // Translate, not Transform: the sortable transform carries a scale factor
    // for size-mismatched neighbours, and rows here are uniform.
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 20 : null,
  });

  return (
    <div
      ref={setRefs}
      data-row={i}
      className={cn(
        'group relative grid grid-cols-[28px_24px_44px_minmax(0,1fr)_auto] items-center gap-3 border-b border-separator-soft px-4 py-[9px] transition-colors hover:bg-ink-soft sm:grid-cols-[18px_24px_44px_minmax(0,1fr)_auto] sm:px-6',
        hot && 'bg-vermilion/10',
        // Dragging: lift it off the list rather than hiding it, so the keyboard
        // user can still see what they are carrying.
        isDragging && 'bg-bg opacity-90 shadow-drawer',
      )}
    >
      {/* `touch-none` is load-bearing, not styling: without it the browser keeps
          the touch gesture and scrolls the page alongside the drag, invisibly to
          the sensor's delta. The cost is that this 28px strip no longer scrolls
          the list. */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${t.title || 'track'}`}
        className="grid h-full cursor-grab touch-none place-items-center self-stretch text-muted focus-visible:ring-1 focus-visible:ring-[var(--accent)] focus-visible:outline-none active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </button>
      <div className="text-right font-mono text-xs text-muted">{i + 1}</div>
      <img
        src={`${API}/cover/${encodeURIComponent(t.id)}`}
        alt=""
        loading="lazy"
        className="size-11 border border-ink bg-ink-soft object-cover"
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{t.title}</span>
          {duplicate && (
            <span className="flex-none border border-[var(--accent)] px-1 py-px font-mono text-[9px] font-bold tracking-[0.08em] text-vermilion">DUPLICATE</span>
          )}
        </div>
        <div className="mt-[3px] truncate font-mono text-[11px] text-muted">
          {t.artist}{t.album ? ` · ${t.album}` : ''}
        </div>
        {((t.moods && t.moods.length > 0) || t.instrumental === true) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {(t.moods || []).slice(0, 2).map(m => (
              <span key={m} className="border border-separator-soft px-[5px] py-px font-mono text-[9px] tracking-[0.04em] text-muted uppercase">{m}</span>
            ))}
            {t.instrumental === true && (
              <span className="border border-separator-soft px-[5px] py-px font-mono text-[9px] tracking-[0.04em] text-muted uppercase">instrumental</span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
        <div className="flex flex-col items-end gap-[3px]">
          <span className="font-mono text-xs text-ink">{fmtDur(t.durationSec || 0)}</span>
          <span className="flex items-center gap-[5px] font-mono text-[10px] text-muted">
            <span className={cn('inline-block size-[7px]', energyBgClass(t.energy))} />
            {energyLabel(t.energy)}{t.year ? ` · ${t.year}` : ''}
          </span>
        </div>
        {/* `group-focus-within` is not decoration: at lg the cluster is hidden
            until hover, and a keyboard user never hovers -- without it, tabbing
            lands on a fully transparent button. */}
        <div className="flex items-center gap-0.5 transition-opacity lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
          <IconBtn className="size-9 sm:size-[30px]" onClick={() => onMove(i, i - 1)} disabled={i === 0} title="Move up"><ArrowUp className="size-[15px]" /></IconBtn>
          <IconBtn className="size-9 sm:size-[30px]" onClick={() => onMove(i, i + 1)} disabled={i === total - 1} title="Move down"><ArrowDown className="size-[15px]" /></IconBtn>
          <IconBtn className="size-9 sm:size-[30px]" onClick={() => onRemove(i)} title="Remove"><X className="size-[15px]" /></IconBtn>
        </div>
      </div>
    </div>
  );
}
