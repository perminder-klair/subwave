'use client';

// What a skin's lyrics button opens: this browser's switch for lyrics, a line
// on what the track has, and the timing corrections while synced lyrics show.
// The lyrics themselves stay on the stage, untimed ones included. Classic opens
// it from the button beside the heart, Drift from its corner icon, and on a
// phone from its ··· panel. Each skin positions and frames it.

import { useEffect, type RefObject } from 'react';
import { cn } from '@/lib/cn';
import { lyricsNote, syncedLyricsReady, type TrackLyrics } from '@/components/skins/lyrics';
import LyricsTiming from '@/components/skins/LyricsTiming';

export interface LyricsSettingsProps {
  /** This browser's choice to show lyrics. */
  shown: boolean;
  onToggle: () => void;
  track: TrackLyrics;
  className?: string;
}

/** Closes a popover on Escape or a press outside both it and its trigger. */
export function usePopoverDismiss(
  open: boolean,
  close: () => void,
  popoverRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, popoverRef, triggerRef]);
}

export default function LyricsSettings({ shown, onToggle, track, className }: LyricsSettingsProps) {
  const synced = shown && syncedLyricsReady(track);
  return (
    <div className={cn('grid gap-3 text-left tracking-normal normal-case', className)}>
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[9px] tracking-[0.28em] text-muted uppercase">Lyrics</span>
          <button
            type="button"
            role="switch"
            aria-checked={shown}
            aria-label="Show lyrics"
            onClick={onToggle}
            className={cn(
              'v3-focus relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border p-0 transition-colors',
              shown ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-separator-soft bg-transparent',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'absolute top-1/2 left-[2px] size-3 -translate-y-1/2 rounded-full transition-transform',
                shown ? 'translate-x-[14px] bg-[var(--bg)]' : 'bg-muted',
              )}
            />
          </button>
        </div>
        <p className="m-0 mt-1.5 text-[11px] leading-snug text-muted" aria-live="polite">
          {lyricsNote(track, shown)}
        </p>
      </div>

      {synced && (
        <div className="border-t border-separator-soft pt-3">
          <LyricsTiming
            deviceOffsetMs={track.deviceOffsetMs}
            setDeviceOffsetMs={track.setDeviceOffsetMs}
            station={track.station}
          />
        </div>
      )}
    </div>
  );
}
