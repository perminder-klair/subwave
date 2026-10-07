'use client';

import { memo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { animate as motionAnimate, m, useAnimate } from 'motion/react';
import { ChevronDown, ChevronUp, Volume2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useIsIOS } from '@/lib/hooks';
import { SCALE_MAX, type SignalQuality } from '@/hooks/useSignal';
import type { PlayerStatus } from '@/hooks/usePlayer';

export interface TransportBarProps {
  tunedIn: boolean;
  status?: PlayerStatus;
  onTune: () => void;
  offline?: boolean;
  volume: number;
  setVolume: (v: number) => void;
  /** Increments on keyboard-only volume adjusts; knob drags don't tick it. */
  volumePulse?: number;
  muted: boolean;
  onToggleMute: () => void;
  /** Measured round-trip latency in ms (null before the first probe lands). */
  latencyMs: number | null;
  signalQuality: SignalQuality;
  /** Current station listener count — shown as text in the signal readout. */
  listeners: number | null;
}

const SCALE_NUMS = [0, 50, 100, 150, 200, 250];

// Drag distance (px) sweeping the knob across its full 0→1 range. The gesture
// is relative to the press point, so this sets the dial's resolution rather
// than the knob's ~40px footprint.
const KNOB_DRAG_RANGE_PX = 160;
// Movement (px) before a press counts as a drag, so tap jitter can't jog the
// level.
const KNOB_DRAG_DEADZONE_PX = 4;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
// Snap to whole-percent steps so the readout and rotation land on clean values.
const quantizeVolume = (n: number) => Math.round(clamp01(n) * 100) / 100;

const QUALITY_LABEL: Record<SignalQuality, string> = {
  offline: 'Offline',
  idle: 'Standby',
  acquiring: 'Acquiring',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

// Honour reduced-motion for the imperative motion pulses (the CSS transitions
// are already gated in globals.css). Read at call time so a setting change
// mid-session is respected.
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default memo(function TransportBar({
  tunedIn,
  status = 'idle',
  onTune,
  offline = false,
  volume,
  setVolume,
  volumePulse,
  muted,
  onToggleMute,
  latencyMs,
  signalQuality,
  listeners,
}: TransportBarProps) {
  // iOS Safari makes HTMLMediaElement.volume read-only and ignores a Web Audio
  // GainNode inside an installed PWA, so the on-screen knob can't actually
  // attenuate there. Swap it for a hardware-volume hint instead of shipping a
  // dead control (issue #298).
  const iosVolumeLocked = useIsIOS();

  // Surfaced on the power ring so the player doesn't claim to play while
  // still silent.
  const connecting = status === 'connecting';

  // -135° (silent) → +135° (full), matching the conic scale's `from -135deg`
  // origin in globals.css.
  const angle = -135 + volume * 270;

  // Parked at 0% before the first probe, pegged to the top when one failed.
  const needlePct =
    latencyMs != null
      ? Math.min(100, (Math.min(latencyMs, SCALE_MAX) / SCALE_MAX) * 100)
      : signalQuality === 'poor'
        ? 100
        : 0;
  const qualityLabel = QUALITY_LABEL[signalQuality];
  const latencyText = latencyMs != null ? `${latencyMs} ms` : '—';
  const qualityTone =
    signalQuality === 'idle' || signalQuality === 'offline' ? 'text-muted' : 'text-vermilion';

  // Fires on the tunedIn flip, not the click, so keyboard and media keys get
  // the same feedback.
  const [tuneScope, animateTune] = useAnimate<HTMLButtonElement>();
  const prevTunedInRef = useRef(tunedIn);
  useEffect(() => {
    if (prevTunedInRef.current === tunedIn) return;
    prevTunedInRef.current = tunedIn;
    if (!tuneScope.current || prefersReducedMotion()) return;
    animateTune(tuneScope.current, { scale: [1, 1.06, 1] }, { duration: 0.25, ease: [0.2, 0.7, 0.2, 1] });
  }, [tunedIn, animateTune, tuneScope]);

  // Scale the WRAPPER: the inner .fz-knob owns the rotate transform and
  // scaling it would clobber that. Skips the initial mount tick.
  const knobWrapRef = useRef<HTMLDivElement>(null);
  const firstPulseRef = useRef(true);
  useEffect(() => {
    if (firstPulseRef.current) {
      firstPulseRef.current = false;
      return;
    }
    if (volumePulse == null) return;
    const el = knobWrapRef.current;
    if (el && !prefersReducedMotion()) {
      motionAnimate(el, { scale: [1, 1.12, 1] }, { duration: 0.12, ease: [0.2, 0.7, 0.2, 1] });
    }
  }, [volumePulse]);

  // Throttled haptic tick on any volume change (drag or keyboard).
  const prevVolumeRef = useRef(volume);
  const lastVibrateRef = useRef(0);
  useEffect(() => {
    if (prevVolumeRef.current === volume) return;
    prevVolumeRef.current = volume;
    const now = Date.now();
    if (now - lastVibrateRef.current > 70 && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(4);
      lastVibrateRef.current = now;
    }
  }, [volume]);

  // Movement is measured relative to the press point, and pointer capture
  // keeps tracking after the finger leaves the 40px target.
  const dragRef = useRef<{ id: number; startY: number; startVolume: number; engaged: boolean } | null>(null);

  const onKnobPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return; // a drag is already live — ignore a second finger
    if (e.button !== 0 && e.pointerType === 'mouse') return; // primary button only
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus(); // tap focuses the slider for SR/keyboard, even with preventDefault
    dragRef.current = { id: e.pointerId, startY: e.clientY, startVolume: volume, engaged: false };
    e.preventDefault();
  };

  const onKnobPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const dy = drag.startY - e.clientY; // up = louder
    // Engage only once the press turns into a deliberate drag, then
    // re-baseline so the first adjustment starts there with no jump.
    if (!drag.engaged) {
      if (Math.abs(dy) < KNOB_DRAG_DEADZONE_PX) return;
      drag.engaged = true;
      drag.startY = e.clientY;
      drag.startVolume = volume;
      return;
    }
    setVolume(quantizeVolume(drag.startVolume + dy / KNOB_DRAG_RANGE_PX));
  };

  const endKnobDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // Up/Down are handled globally (PlayerApp's shortcuts) regardless of focus,
  // so binding them here too would double-step. Jump keys only.
  const onKnobKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else if (e.key === 'PageUp') next = volume + 0.1;
    else if (e.key === 'PageDown') next = volume - 0.1;
    if (next == null) return;
    e.preventDefault();
    setVolume(quantizeVolume(next));
  };

  const handleTune = () => {
    if (offline) return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
    }
    onTune();
  };

  const handleMute = () => {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(6);
    }
    onToggleMute();
  };

  return (
    <div
      // Safe-area insets live on the deck below, not here, so its background
      // fills to the screen edge with no page bg peeking through.
      className="absolute inset-x-0 bottom-0 z-20"
    >
      <div className="fz-deck relative grid grid-cols-[auto_1fr_auto] items-stretch bg-[var(--fz-panel)] pt-3 pr-[env(safe-area-inset-right)] pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)] pl-[env(safe-area-inset-left)] [border-top:1px_solid_var(--fz-edge)]">
        <div className="relative flex flex-col items-center justify-center gap-1.5 px-4 pt-1 pb-2 md:px-5 md:pt-1 md:pb-2.5 lg:gap-2 lg:px-6 lg:pt-1.5 lg:pb-3">
          <span className="v3-caption hidden text-muted lg:block">Power</span>
          <m.button
            ref={tuneScope}
            onClick={offline ? undefined : handleTune}
            disabled={offline}
            aria-disabled={offline}
            aria-pressed={tunedIn}
            aria-label={offline ? 'Stream offline' : tunedIn ? 'Tune out' : 'Tune in'}
            title={offline ? 'The station is currently off air' : tunedIn ? 'Tune out' : 'Tune in'}
            data-tuned={tunedIn ? 'true' : 'false'}
            whileTap={offline ? undefined : { scale: 0.95 }}
            transition={{ duration: 0.09, ease: [0.2, 0.7, 0.2, 1] }}
            className="fz-power v3-focus h-10 w-10 md:h-11 md:w-11 lg:h-[50px] lg:w-[50px]"
          >
            <span className={cn('fz-ring', connecting && 'v3-connecting-pulse')} />
          </m.button>
        </div>

        <div className="relative flex min-w-0 items-center justify-center px-2 [border-left:1px_solid_var(--fz-line)] md:px-5 lg:px-6">
          <div className="flex w-full flex-col justify-center gap-1 font-mono lg:gap-1.5">
            <div className="flex items-baseline justify-between gap-2 lg:gap-4">
              <span className="text-[11px] font-semibold tracking-[0.04em] whitespace-nowrap text-ink lg:text-[12px]">
                Signal · <b className={cn('font-bold', qualityTone)}>{qualityLabel}</b>
              </span>
              <span
                className="v3-tab-num text-[11px] tracking-[0.06em] whitespace-nowrap text-muted lg:text-[12px] lg:tracking-[0.08em]"
                title={listeners != null ? `${listeners} listening · ${latencyText}` : latencyText}
                aria-label={listeners != null ? `${listeners} listening, ${latencyText}` : latencyText}
              >
                {listeners != null ? `${listeners} ♪ · ${latencyText}` : latencyText}
              </span>
            </div>
            <div className="fz-scale h-8 lg:h-[42px]" aria-hidden="true">
              <div className="fz-ticks" />
              <div
                className="fz-needle"
                ref={(el) => { if (el) el.style.setProperty('--fz-needle-pos', `${needlePct}%`); }}
              >
                <div className="fz-grip" />
              </div>
              <div className="fz-nums">
                {SCALE_NUMS.map((n) => (
                  <span key={n}>{n}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="relative flex flex-col items-center justify-center gap-1.5 px-4 pt-1 pb-2 [border-left:1px_solid_var(--fz-line)] md:px-5 md:pt-1 md:pb-2.5 lg:gap-2 lg:px-6 lg:pt-1.5 lg:pb-3">
          <span className="v3-caption hidden text-muted lg:block">Volume</span>
          {iosVolumeLocked ? (
            // iOS: volume is hardware-only (see iosVolumeLocked above), so
            // echo a volume rocker rather than ship a dead knob.
            <div
              className="flex h-10 items-center gap-1.5 text-muted lg:h-[48px]"
              title="On iOS, volume is set with your device's buttons"
              aria-label="Volume is controlled by your device's hardware buttons"
            >
              <Volume2 size={20} strokeWidth={1.5} aria-hidden="true" />
              <span className="-my-0.5 flex flex-col leading-none" aria-hidden="true">
                <ChevronUp size={12} strokeWidth={2.25} />
                <ChevronDown size={12} strokeWidth={2.25} />
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-3 lg:gap-4">
              <div
                ref={knobWrapRef}
                role="slider"
                tabIndex={0}
                aria-label="Volume"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(volume * 100)}
                aria-valuetext={`${Math.round(volume * 100)}%`}
                aria-orientation="vertical"
                onPointerDown={onKnobPointerDown}
                onPointerMove={onKnobPointerMove}
                onPointerUp={endKnobDrag}
                onPointerCancel={endKnobDrag}
                onKeyDown={onKnobKeyDown}
                className="fz-knob-wrap v3-focus h-10 w-10 cursor-ns-resize touch-none rounded-full select-none lg:h-[48px] lg:w-[48px]"
              >
                <div className="fz-knob-ticks" />
                <div
                  className="fz-knob"
                  ref={(el) => { if (el) el.style.setProperty('--fz-angle', `${angle}deg`); }}
                >
                  <span className="fz-cap" />
                  <span className="fz-pointer" />
                </div>
              </div>

              <button
                type="button"
                onClick={handleMute}
                aria-pressed={muted}
                aria-label={muted ? 'Unmute' : 'Mute'}
                title={muted ? 'Unmute' : 'Mute'}
                data-muted={muted ? 'true' : 'false'}
                className="fz-grille v3-focus h-9 w-9 lg:h-10 lg:w-10"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
