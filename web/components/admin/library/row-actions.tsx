'use client';

// The heart and the never-play menu, lifted out of TrackTable so the Play
// history rows offer the same two actions (#1600). Both are pure presentational
// pieces taking an explicit Track: history rows are PlayEntry, so their caller
// composes one from the air-time snapshot before rendering these.

import { useRef, useState } from 'react';
import { Ban, Heart, ListPlus } from 'lucide-react';
import { Btn } from '../ui';
import { cn } from '../../../lib/cn';
import type { BlockType, LikeIndex, QueueBlockKind, Track } from './types';
import { useDismissOnOutside } from './bits';

// Capped for the Browse grid, where the actions column is a FIXED track (.lib-row
// in globals.css): uncapped, a heavily-liked track widens the cluster until the
// actions overlap mood/energy. History rows are a plain flex row and would survive
// a wider count, but one cap keeps the heart the same size on both.
const countLabel = (n: number) => (n > 99 ? '99+' : String(n));

// Inline `likedByOperator`/`likeCount` if the row has them, else the shared index.
// A history row never has them, so it always reads the index — which is what makes
// a heart set on the Browse tab show up here without a refetch.
export function likeStateFor(t: Track, index: LikeIndex): { liked: boolean; count: number } {
  if (t.likedByOperator != null || t.likeCount != null) {
    return { liked: !!t.likedByOperator, count: t.likeCount ?? 0 };
  }
  const hit = index[t.id];
  return { liked: !!hit?.operator, count: hit?.count ?? 0 };
}

export function HeartButton({ track, like, busy, onToggle, className }: {
  track: Track;
  like: { liked: boolean; count: number };
  busy: boolean;
  onToggle: (t: Track, liked: boolean) => void;
  className?: string;
}) {
  return (
    <Btn
      sm
      className={className}
      onClick={() => onToggle(track, like.liked)}
      disabled={busy}
      title={like.liked ? 'Remove your heart' : 'Heart this track'}
      aria-pressed={like.liked}
      aria-label={like.liked ? `unlike ${track.title || 'track'}` : `like ${track.title || 'track'}`}
    >
      {busy ? '…' : (
        <span className="inline-flex items-center gap-1">
          <Heart size={12} className={cn(like.liked && 'fill-vermilion text-vermilion')} />
          {/* Count is every like on the song; the fill is the operator's own. */}
          {like.count > 0 && <span className="mono-num text-[10px]">{countLabel(like.count)}</span>}
        </span>
      )}
    </Btn>
  );
}

// The server resolves album/artist ids from the track id, so the row only needs t.id.
// No confirm dialog: blocking is one-click reversible from the Blocked tab.
export function BlockMenu({ track, busy, disabled, onBlock, className }: {
  track: Track;
  busy: boolean;
  disabled: boolean;
  onBlock: (t: Track, type: BlockType) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pick = (type: BlockType) => { setOpen(false); onBlock(track, type); };
  useDismissOnOutside(open, () => setOpen(false), rootRef, triggerRef);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Btn
        ref={triggerRef}
        sm
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Never play this on air"
        aria-expanded={open}
        aria-haspopup="true"
      >
        {busy ? '…' : <Ban size={12} />}
      </Btn>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 max-w-[calc(100vw-2rem)] min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('track')}>
            Never play this track
          </button>
          {track.album && (
            <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('album')}>
              Never play this album
            </button>
          )}
          {track.artist && (
            <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => pick('artist')}>
              Never play this artist
              <span className="block text-[10px] text-muted">also blocks tracks they're only featured on — acts joined by & or , stay separate</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Queue on air, or queue the whole record / a run of the artist (#1622 FR 4).
//
// Deliberately the same shape as BlockMenu above — one button, a menu, the
// server resolving the album/artist off the track id, because the row never
// sees either id. The single-track action is the first item rather than the
// button itself: two clicks for it matches how blocking a track already works,
// and the actions column is a fixed grid track with no room for a fifth button.
export function QueueMenu({ track, busy, disabled, onQueue, onQueueBlock, className }: {
  track: Track;
  busy: boolean;
  disabled: boolean;
  onQueue: (t: Track) => void;
  onQueueBlock: (t: Track, kind: QueueBlockKind) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismissOnOutside(open, () => setOpen(false), rootRef, triggerRef);
  const run = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Btn
        ref={triggerRef}
        sm
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Queue on air"
        aria-expanded={open}
        aria-haspopup="true"
      >
        {busy ? '…' : <ListPlus size={12} />}
      </Btn>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 max-w-[calc(100vw-2rem)] min-w-[220px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => run(() => onQueue(track))}>
            Queue this track
          </button>
          {track.album && (
            <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => run(() => onQueueBlock(track, 'album'))}>
              Queue the whole album
              <span className="block text-[10px] text-muted">plays in its own running order, never shuffled</span>
            </button>
          )}
          {track.artist && (
            <button type="button" className="block w-full rounded px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--ink-soft)] hover:text-ink" onClick={() => run(() => onQueueBlock(track, 'artist'))}>
              Queue a set by this artist
              <span className="block text-[10px] text-muted">their best-known tracks, back to back</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
