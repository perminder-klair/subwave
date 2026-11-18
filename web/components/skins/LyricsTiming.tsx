'use client';

// The two lyric timing corrections, as one compact panel: this device's nudge
// (kept in this browser) and, for a browser signed in to this station's admin
// console, the station-wide fix for the track's lyric file. Part of the lyrics
// settings (LyricsSettings) that each skin's lyrics button opens.

import { useId, type ChangeEvent } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  LYRIC_OFFSET_MAX_MS,
  LYRIC_OFFSET_MIN_MS,
  LYRIC_OFFSET_NUDGE_MS,
  LYRIC_OFFSET_STEP_MS,
  formatLyricOffset,
  type StationOffsetControl,
} from '@/components/skins/lyrics';

const ICON_BUTTON =
  'v3-focus grid h-8 w-8 shrink-0 cursor-pointer place-items-center border border-separator-soft bg-transparent text-ink disabled:cursor-default disabled:opacity-40';

export interface LyricsTimingProps {
  deviceOffsetMs: number;
  setDeviceOffsetMs: (next: number) => void;
  station: StationOffsetControl;
}

export default function LyricsTiming({ deviceOffsetMs, setDeviceOffsetMs, station }: LyricsTimingProps) {
  const deviceHintId = useId();
  const stationHintId = useId();
  return (
    <div className="grid gap-2">
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <div className="text-[9px] tracking-[0.28em] text-muted uppercase" title="Only changes what this browser shows">
            This device
            <span id={deviceHintId} className="sr-only">Only changes what this browser shows.</span>
          </div>
          <div className="v3-tab-num shrink-0 text-[11px] tracking-[0.1em] text-ink">{formatLyricOffset(deviceOffsetMs)}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={() => setDeviceOffsetMs(deviceOffsetMs - LYRIC_OFFSET_NUDGE_MS)}
            aria-label="Delay lyrics on this device"
            title="Delay lyrics"
          >
            <Minus size={14} strokeWidth={1.8} />
          </button>
          <input
            type="range"
            min={LYRIC_OFFSET_MIN_MS}
            max={LYRIC_OFFSET_MAX_MS}
            step={LYRIC_OFFSET_STEP_MS}
            value={deviceOffsetMs}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDeviceOffsetMs(Number(event.target.value))}
            aria-label="Lyrics timing on this device"
            aria-valuetext={formatLyricOffset(deviceOffsetMs)}
            aria-describedby={deviceHintId}
            className="h-8 min-w-0 flex-1 accent-[var(--accent)] opacity-70"
          />
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={() => setDeviceOffsetMs(deviceOffsetMs + LYRIC_OFFSET_NUDGE_MS)}
            aria-label="Advance lyrics on this device"
            title="Advance lyrics"
          >
            <Plus size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={cn(ICON_BUTTON, 'text-muted')}
            onClick={() => setDeviceOffsetMs(0)}
            aria-label="Reset lyrics timing on this device"
            title="Reset"
          >
            <RotateCcw size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {station.canTune && (
        <div className="border-t border-separator-soft pt-2">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div
              className="text-[9px] tracking-[0.28em] text-muted uppercase"
              title="Fixes this track's lyric file for every listener. Shown because this browser is signed in as the operator."
            >
              Station · this track
              <span id={stationHintId} className="sr-only">
                Fixes this track&apos;s lyric file for every listener, once saved.
              </span>
            </div>
            <div className="v3-tab-num shrink-0 text-[11px] tracking-[0.1em] text-ink" aria-live="polite">
              <span className="sr-only">Station timing </span>
              {formatLyricOffset(station.offsetMs)}
              {station.dirty && <span className="sr-only">, not saved</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => station.set(station.offsetMs - LYRIC_OFFSET_NUDGE_MS)}
              disabled={station.saving}
              aria-label="Delay this track's lyrics for every listener"
              aria-describedby={stationHintId}
              title="Delay lyrics"
            >
              <Minus size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              onClick={() => station.set(station.offsetMs + LYRIC_OFFSET_NUDGE_MS)}
              disabled={station.saving}
              aria-label="Advance this track's lyrics for every listener"
              aria-describedby={stationHintId}
              title="Advance lyrics"
            >
              <Plus size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={cn(ICON_BUTTON, 'text-muted')}
              onClick={() => station.set(0)}
              disabled={station.saving || station.offsetMs === 0}
              aria-label="Clear this track's station timing"
              aria-describedby={stationHintId}
              title="Clear"
            >
              <RotateCcw size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="v3-focus ml-auto h-8 cursor-pointer border border-ink bg-ink px-3 text-[10px] tracking-[0.2em] text-bg uppercase disabled:cursor-default disabled:opacity-40"
              onClick={() => void station.save()}
              disabled={!station.dirty || station.saving}
            >
              {station.saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {station.error && (
            <div className="mt-1 text-[10px] leading-snug text-vermilion" role="alert">{station.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
