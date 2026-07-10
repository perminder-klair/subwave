'use client';

import { AUDIO_FORMATS, type AudioFormat, type FormatAvailability } from '@/lib/audioFormat';
import { cn } from '@/lib/cn';

export interface AudioDrawerProps {
  format: AudioFormat;
  availability: FormatAvailability;
  failure: AudioFormat | null;
  onSelect: (format: AudioFormat) => void;
}

export default function AudioDrawer({ format, availability, failure, onSelect }: AudioDrawerProps) {
  const failedLabel = failure == null
    ? null
    : AUDIO_FORMATS.find(entry => entry.id === failure)?.label ?? failure.toUpperCase();

  return (
    <div className="space-y-4 text-ink">
      {failedLabel && (
        <div
          role="status"
          className="border-l-2 border-ink bg-bg px-4 py-3 text-sm text-ink"
        >
          Couldn&apos;t load {failedLabel}; playback fell back to MP3.
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="sr-only">Audio format</legend>
        {AUDIO_FORMATS.map(entry => {
          const selected = format === entry.id;
          const option = availability[entry.id];

          return (
            <label
              key={entry.id}
              className={cn(
                'flex items-start gap-3 border border-ink bg-bg px-4 py-3',
                option.available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name="audio-format"
                value={entry.id}
                checked={selected}
                disabled={!option.available}
                onChange={() => onSelect(entry.id)}
                className="v3-focus mt-1 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold">{entry.label}</span>
                  {selected && (
                    <span className="text-xs font-semibold tracking-wider text-vermilion uppercase">
                      Selected
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-sm text-muted">{entry.description}</span>
                {option.reason && (
                  <span className="mt-1 block text-xs font-medium text-ink">{option.reason}</span>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}
