'use client';

import { Play } from 'lucide-react';
import { m } from 'motion/react';
import type { NowPlayingTrack } from '@/lib/types';

export interface TuneInOverlayProps {
  onTune: () => void;
  nowPlaying: NowPlayingTrack | null;
}

// Full-bleed first-paint gate. A new listener lands on a player that shows
// live track info but isn't actually playing — the small "Tune In" button in
// the footer is easy to miss. This overlay makes the call-to-action
// unmissable, and the tap doubles as the browser gesture that unblocks audio,
// so the stream starts on the first interaction with no second click.
//
// Entrance keeps the v3-fade-in CSS keyframe. Exit is motion-driven via
// variants: the play disc scales out while the rest washes away 80 ms later,
// so the dial "engages" rather than vanishing. AnimatePresence lives at the
// PlayerApp parent.
export default function TuneInOverlay({ onTune, nowPlaying }: TuneInOverlayProps) {
  const track = nowPlaying?.title
    ? `${nowPlaying.title}${nowPlaying.artist ? ` — ${nowPlaying.artist}` : ''}`
    : null;

  return (
    <m.button
      type="button"
      onClick={onTune}
      aria-label="Tune in to the live stream"
      variants={{
        visible: { opacity: 1 },
        hidden:  { opacity: 0, transition: { duration: 0.18, delay: 0.08 } },
      }}
      initial="visible"
      animate="visible"
      exit="hidden"
      className="v3-focus v3-fade-in absolute inset-0 z-50 flex cursor-pointer flex-col items-center justify-center gap-7 bg-[color-mix(in_oklab,var(--bg)_6%,transparent)] px-6 text-center
        text-ink
        [backdrop-filter:blur(1.5px)_saturate(1.9)_brightness(1.07)]
        [-webkit-backdrop-filter:blur(1.5px)_saturate(1.9)_brightness(1.07)]"
    >
      <span className="v3-eyebrow flex items-center gap-2 text-vermilion">
        <span className="bs-live-dot" />
        on air now
      </span>

      <m.span
        variants={{
          visible: { scale: 1, opacity: 1 },
          hidden:  { scale: 1.6, opacity: 0, transition: { duration: 0.18, ease: [0.2, 0.7, 0.2, 1] } },
        }}
        className="v3-tunein-pulse flex h-[92px] w-[92px] items-center justify-center rounded-full bg-ink text-bg"
      >
        <Play size={34} strokeWidth={1.5} fill="currentColor" className="ml-1" />
      </m.span>

      <span className="flex max-w-[34ch] flex-col items-center gap-2">
        <span className="v3-title">Tap to tune in</span>
        <span className="v3-caption text-muted">
          audio is paused — tap anywhere to start listening
        </span>
        {track && (
          <span className="mt-1 text-[13px] text-muted">
            now playing · <span className="text-ink">{track}</span>
          </span>
        )}
      </span>
    </m.button>
  );
}
