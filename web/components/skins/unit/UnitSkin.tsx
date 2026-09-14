'use client';

// Everything that moves is a co-located keyframe (Unit.module.css); the one
// exception is the display's level meter, which follows the real stream spectrum
// and writes each bar's scaleY straight to the DOM. Playback churn never
// re-renders React.

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import styles from './Unit.module.css';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useElapsed } from '@/hooks/useElapsed';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { useCoverColors } from '@/hooks/useCoverColors';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { cn } from '@/lib/cn';
import { useStationClient } from '@/lib/stationClient';
import { fmtClockMinute, fmtTime, normalizeStationLocale } from '@/lib/format';
import {
  contextLine,
  entryTime,
  listenerCountOf,
  progressRatio,
  stationIdentity,
  trackMeta,
  turnClock,
} from '../shared';
import { useAnalyser } from '@/lib/hooks';
import { useLiteMode } from '@/hooks/useLiteMode';
import { useRequestSlip, useTrackLike, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';
import { BoothWindow, RequestWindow, TimelineWindow, type UnitModal } from './UnitWindows';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Must match the scaleY the `unit-bar` keyframe idles at, so the audio-driven
// meter and the CSS fallback share a floor.
const BAR_REST = 0.28;

// Swept logarithmically, equal width per octave. A linear bin split would hand
// four of seven bars to >8 kHz, where music carries almost no energy.
const BAR_FREQ_LO = 50;
const BAR_FREQ_HI = 16000;

// Minimum ms between style writes. rAF fires at display refresh; the analyser's
// own smoothing makes ~33 ms frames visually identical.
const BAR_FRAME_MS = 30;

// How long every bin may read zero before handing the bars back to the CSS
// keyframes. Desktop Safari wires the graph up then returns silence on a live
// MP3 mount (#298/#302) in ways the hook's one-shot probe can miss.
const BAR_DEAD_MS = 2000;

// Asymmetric follower: snap up on a transient, fall back slowly.
const BAR_ATTACK = 0.55;
const BAR_RELEASE = 0.16;

/** Per-bar [start, end) analyser-bin spans. With only 6-7 bars every span is
 *  many bins wide, so no fractional interpolation is needed. */
function barBinRanges(count: number, binCount: number, sampleRate: number): Array<[number, number]> {
  const nyquist = sampleRate / 2;
  const hi = Math.min(BAR_FREQ_HI, nyquist);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const f0 = BAR_FREQ_LO * Math.pow(hi / BAR_FREQ_LO, i / count);
    const f1 = BAR_FREQ_LO * Math.pow(hi / BAR_FREQ_LO, (i + 1) / count);
    const b0 = Math.min(binCount - 1, Math.max(0, Math.floor((f0 / nyquist) * binCount)));
    const b1 = Math.min(binCount, Math.max(b0 + 1, Math.ceil((f1 / nyquist) * binCount)));
    ranges.push([b0, b1]);
  }
  return ranges;
}

/** Level bars driven by the shared Web Audio analyser, written straight to each
 *  bar's `scaleY`. Where the analyser can't deliver (iOS, CORS, no Web Audio, or
 *  a graph that goes silent mid-stream) the bars fall back to the `unit-bar`
 *  keyframes; both paths idle at BAR_REST so the handover doesn't show.
 *  html.lite and prefers-reduced-motion can't reach a rAF loop, so both are
 *  checked here as well as in the CSS. */
function Bars({
  count,
  playing,
  mobile,
  className,
  audioRef,
}: {
  count: number;
  playing: boolean;
  mobile?: boolean;
  className?: string;
  /** Omitted for decorative meters, which stay on the CSS keyframes. */
  audioRef?: RefObject<HTMLAudioElement | null>;
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const { lite } = useLiteMode();

  // Read here rather than left to CSS: the rAF loop sails through both the
  // media query and lite's `animation: none`.
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const calm = lite || reduced;
  const canDrive = !!audioRef && playing && !calm;
  const { ready, read, sampleRate } = useAnalyser(audioRef ?? null, canDrive);

  // Only flips when the analyser arrives or dies.
  const [driven, setDriven] = useState(false);
  const drivenRef = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    const clear = () => {
      drivenRef.current = false;
      setDriven(false);
      for (const el of Array.from(root?.children ?? []) as HTMLElement[]) {
        el.style.transform = '';
      }
    };
    if (!canDrive || !ready || !root) {
      clear();
      return;
    }
    const bars = Array.from(root.children) as HTMLElement[];
    const levels = new Float32Array(count);
    let ranges: Array<[number, number]> | null = null;
    let rangeKey = '';
    let raf = 0;
    let last = 0;
    let deadSince: number | null = null;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < BAR_FRAME_MS) return;
      last = now;
      const bins = read();
      if (!bins) return;

      // Hand the bars back to the keyframes rather than freeze them at rest,
      // then keep reading so real data can reclaim them.
      let alive = false;
      for (let b = 0; b < bins.length; b++) {
        if (bins[b]) { alive = true; break; }
      }
      if (alive) {
        deadSince = null;
      } else {
        if (deadSince == null) deadSince = now;
        if (now - deadSince >= BAR_DEAD_MS) {
          if (drivenRef.current) clear();
          return;
        }
        if (!drivenRef.current) return;
      }
      if (!drivenRef.current) {
        drivenRef.current = true;
        setDriven(true);
      }

      const key = `${bins.length}:${sampleRate ?? 0}`;
      if (rangeKey !== key || !ranges) {
        rangeKey = key;
        ranges = barBinRanges(count, bins.length, sampleRate ?? 48000);
      }
      for (let i = 0; i < count; i++) {
        const [b0, b1] = ranges[i] ?? [0, 1];
        let sum = 0;
        let peak = 0;
        for (let b = b0; b < b1; b++) {
          const v = bins[b] ?? 0;
          sum += v;
          if (v > peak) peak = v;
        }
        // Half mean, half peak: a pure mean over a band this wide barely
        // twitches, a pure peak jitters on narrowband content.
        const raw = (sum / (b1 - b0) / 255) * 0.5 + (peak / 255) * 0.5;
        // Lift toward the top of the sweep: recorded music sheds energy with
        // frequency.
        const target = clamp01(Math.pow(clamp01(raw * (1 + 0.45 * (i / Math.max(1, count - 1)))), 0.62));
        const cur = levels[i] ?? 0;
        const next = cur + (target - cur) * (target > cur ? BAR_ATTACK : BAR_RELEASE);
        levels[i] = next;
        const bar = bars[i];
        if (bar) bar.style.transform = `scaleY(${(BAR_REST + next * (1 - BAR_REST)).toFixed(3)})`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [canDrive, ready, read, sampleRate, count]);

  return (
    <span
      ref={rootRef}
      className={cn(
        styles.bars,
        mobile && styles.barsM,
        playing && styles.playing,
        driven && styles.live,
        'flex items-end',
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={cn(styles.bar, 'h-full min-w-0 flex-1')} />
      ))}
    </span>
  );
}

/** The pointer indicator rides a root-level CSS var so the desktop and mobile
 *  instances always agree. */
function Knob({
  outerClass,
  innerClass,
  markClass,
  caption,
  label,
  valueNow,
  valueMax,
  onDrag,
  onStep,
}: {
  outerClass: string;
  innerClass: string;
  markClass: string;
  caption: string;
  label: string;
  valueNow: number;
  valueMax: number;
  /** Fraction of a full sweep dragged since pointer-down (up = positive). */
  onDrag: (startValue: number, sweptFrac: number) => void;
  onStep: (dir: 1 | -1) => void;
}) {
  const startRef = useRef<{ y: number; value: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { y: e.clientY, value: valueNow };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start || !e.buttons) return;
    onDrag(start.value, (start.y - e.clientY) / 160);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      e.preventDefault();
      onStep(1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      e.preventDefault();
      onStep(-1);
    }
  };
  return (
    <div className="flex min-w-0 flex-col items-center gap-3">
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={valueMax}
        aria-valuenow={Math.round(valueNow)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { startRef.current = null; }}
        onPointerCancel={() => { startRef.current = null; }}
        onKeyDown={onKeyDown}
        className={cn(
          styles.knobOuter,
          'v3-focus flex cursor-ns-resize touch-none items-center justify-center',
          outerClass,
        )}
      >
        <div className={cn(styles.knobInner, 'flex items-center justify-center', innerClass)}>
          <span className={markClass} />
        </div>
      </div>
      <span
        className={cn(
          styles.engravedSoft,
          'font-mono text-[9px] font-bold tracking-[0.16em] whitespace-nowrap uppercase',
        )}
      >
        {caption}
      </span>
    </div>
  );
}

/** The on-air cover rides the root's --u-cover var and paints through the
 *  perforation as a halftone. */
function Grille({ hasArt, className }: { hasArt: boolean; className?: string }) {
  return (
    <div className={cn(styles.grille, 'relative overflow-hidden', className)} aria-hidden="true">
      {hasArt && <div className={cn(styles.grilleWash, 'absolute inset-0')} />}
      {hasArt && (
        <div className={cn(styles.grilleArt, 'absolute inset-0')}>
          <div className={styles.grilleArtBox} />
        </div>
      )}
      <div className={cn(styles.grilleShade, 'pointer-events-none absolute inset-0')} />
    </div>
  );
}

/** Decorative only: the core owns mount selection, so the cap is parked on the
 *  MP3 floor every listener gets. */
function Fader({ slotClass, capClass }: { slotClass: string; capClass: string }) {
  return (
    <div className="relative flex h-[34px] w-full items-center" aria-hidden="true">
      <div className={cn(styles.faderSlot, 'w-full', slotClass)} />
      <div className={cn(styles.faderCap, 'absolute top-1/2 -translate-x-1/2 -translate-y-1/2', capClass)} />
    </div>
  );
}

const FADER_LABELS = (
  <div
    className={cn(
      styles.engravedSoft,
      'flex w-full items-baseline justify-between gap-2 font-mono text-[9px] font-bold tracking-[0.1em] whitespace-nowrap uppercase',
    )}
  >
    <span>mp3 128</span>
    <span className="tracking-[0.14em] text-[var(--ink)]">mount · mp3 320</span>
    <span>opus</span>
  </div>
);

export default function UnitSkin(_props: SkinProps) {
  const {
    nowPlaying, context, dj, activeShow, listeners, state,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { audioRef, tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume } = usePlayerActions();
  const { showOverlay, showTuneIn, tuneInFromOverlay, handleTune } = useTuneInGate();
  const client = useStationClient();

  const elapsed = useElapsed(trackStartedAt);
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const meta = trackMeta(nowPlaying);
  const ratio = progressRatio(elapsed, nowPlaying?.duration);
  const history = (state.history ?? []).slice(0, 60);
  const upNext = (state.upcoming ?? [])[0];
  const playing = tunedIn && status === 'playing' && !offline;

  const title = offline ? 'off air' : (nowPlaying?.title ?? 'scanning the dial…');
  const artist = offline ? '' : (nowPlaying?.artist ?? '');
  const trackNo = String((history.length % 99) + 1).padStart(2, '0');
  const trackLine = offline
    ? 'signal lost'
    : nowPlaying?.duration
      ? `track ${trackNo} · ${fmtTime(elapsed)} / ${fmtTime(nowPlaying.duration)}`
      : `track ${trackNo} · ${fmtTime(elapsed)} · live`;
  const nextLine = upNext?.title ? `next: ${upNext.title}` : "next: the dj's call";
  const footerRight = `${showName || 'freeform'} · ${djName}`;
  const showLine = [
    showName || 'freeform',
    `with ${djName}`,
    contextLine(context) || (offline ? 'off air' : 'on air'),
  ].join(' · ');

  // Seeded in an effect, not at render, so SSR markup can't mismatch the
  // client's clock on hydration.
  const [clockNow, setClockNow] = useState<Date | null>(null);
  useEffect(() => {
    setClockNow(new Date());
    const id = window.setInterval(() => setClockNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const clock = clockNow ? fmtClockMinute(clockNow, timezone, stationLocale) : '--:--';

  const [modal, setModal] = useState<UnitModal>(null);
  const toggleModal = (m: Exclude<UnitModal, null>) =>
    setModal(cur => (cur === m ? null : m));

  // Offset 0 shows [now, then the three most recent]; each step scrolls one
  // entry deeper. Clamped at render so a shrinking history can't strand it.
  const [logOffset, setLogOffset] = useState(0);
  const maxLogOffset = Math.max(0, history.length + 1 - 4);
  const logAt = Math.min(logOffset, maxLogOffset);

  const like = useTrackLike();
  const adjustVolume = useVolumeNudge();
  const slip = useRequestSlip({
    sent: 'Receipt logged — the booth has your request.',
    refused: 'The booth waved this one off.',
    failed: 'The booth line is down — try again in a moment.',
  });
  const reqInputRef = useRef<HTMLInputElement | null>(null);
  const openRequest = () => {
    setModal('req');
    requestAnimationFrame(() => reqInputRef.current?.focus());
  };

  useKeyboardShortcuts({
    space: handleTune,
    k: handleTune,
    arrowup: () => adjustVolume(0.05),
    arrowdown: () => adjustVolume(-0.05),
    m: toggleMute,
    t: () => toggleModal('timeline'),
    b: () => toggleModal('booth'),
    r: () => { if (!showTuneIn) openRequest(); },
    escape: () => setModal(null),
  });

  const coverUrl =
    !offline && nowPlaying?.subsonic_id ? client.coverUrl(nowPlaying.subsonic_id) : null;
  const coverColors = useCoverColors(coverUrl);

  // Progress fill, both knob pointers and the grille artwork ride root CSS vars,
  // never inline styles.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(rootRef, {
    '--pf': ratio ?? 0,
    '--vol-rot': `${(-135 + clamp01(volume) * 270).toFixed(1)}deg`,
    '--log-rot': `${24 + logAt * 18}deg`,
    '--u-cover': coverUrl ? `url("${coverUrl}")` : null,
    '--u-tint': coverUrl ? coverColors.vibrant : null,
  });

  const keyLabel = 'font-mono font-bold tracking-[0.16em] uppercase';
  const hardKey = (
    label: string,
    opts: {
      onClick: () => void;
      down?: boolean;
      accent?: boolean;
      led?: boolean;
      /** Compact LED for the short mobile keys. */
      ledSm?: boolean;
      pressed?: boolean;
      aria?: string;
      extra?: string;
      text?: string;
    },
  ) => (
    <button
      type="button"
      onClick={opts.onClick}
      aria-label={opts.aria ?? label}
      aria-pressed={opts.pressed ?? opts.down ?? false}
      className={cn(
        'v3-focus relative flex cursor-pointer items-center justify-center border-0',
        opts.accent
          ? (opts.down ? styles.keyAccentDown : styles.keyAccent)
          : (opts.down ? styles.keyDown : styles.key),
        keyLabel,
        opts.text ?? 'text-[15px]',
        opts.extra,
      )}
    >
      {label}
      {opts.led && (
        <span
          className={cn(
            styles.ledOn,
            'absolute rounded-full',
            opts.ledSm ? 'right-3 bottom-2.5 size-[7px]' : 'right-4 bottom-3.5 size-[9px]',
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );

  const volumeKnob = (outer: string, inner: string, mark: string) => (
    <Knob
      outerClass={outer}
      innerClass={cn(styles.volInner, inner)}
      markClass={cn(styles.knobMarkAccent, mark)}
      caption="volume"
      label="Volume"
      valueNow={Math.round(volume * 100)}
      valueMax={100}
      onDrag={(start, frac) => setVolume(clamp01(start / 100 + frac))}
      onStep={dir => adjustVolume(dir * 0.05)}
    />
  );

  const wordmark = (sizeClass: string) => (
    <span
      className={cn(
        styles.engraved,
        'font-display font-extrabold tracking-[0.12em]',
        sizeClass,
      )}
    >
      {stationName.toUpperCase()}
    </span>
  );

  const onAirLamp = (dot: string, textClass?: string) => (
    <span className={cn('flex items-center gap-2', textClass)}>
      <span
        className={cn(styles.lamp, offline ? styles.lampIdle : styles.lampLive, dot)}
        aria-hidden="true"
      />
      {offline ? 'off air' : 'on air'}
    </span>
  );

  const windows = (
    <>
      {modal === 'timeline' && <TimelineWindow onClose={() => setModal(null)} />}
      {modal === 'booth' && <BoothWindow onClose={() => setModal(null)} />}
      {modal === 'req' && (
        <RequestWindow onClose={() => setModal(null)} slip={slip} inputRef={reqInputRef} />
      )}
    </>
  );

  return (
    <div
      ref={rootRef}
      className={cn(styles.chassis, 'absolute inset-0 flex flex-col overflow-hidden font-sans')}
    >
      <div className={cn(styles.striation, 'pointer-events-none absolute inset-0')} aria-hidden="true" />

      <div className="relative hidden min-h-0 flex-1 flex-col gap-[18px] p-5 lg:flex">
        <div className="flex h-[30px] flex-none items-center justify-between px-1.5">
          <div className="flex min-w-0 items-baseline gap-4">
            {wordmark('text-[18px]')}
            <span
              className={cn(
                styles.engravedSoft,
                'truncate font-mono text-[10px] font-bold tracking-[0.22em] uppercase',
              )}
            >
              {showLine}
            </span>
          </div>
          <div
            className={cn(
              styles.engravedSoft,
              'flex flex-none items-center gap-[22px] font-mono text-[9px] font-bold tracking-[0.2em] uppercase',
            )}
          >
            {onAirLamp('size-[9px]')}
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  styles.lamp,
                  tunedIn && signal.latencyMs != null ? styles.lampNet : styles.lampIdle,
                  'size-[9px]',
                )}
                aria-hidden="true"
              />
              {tunedIn && signal.latencyMs != null ? `net ${signal.latencyMs} ms` : 'net standby'}
            </span>
            <span className="flex items-center gap-2">
              <span className={cn(styles.lamp, styles.lampIdle, 'size-[9px]')} aria-hidden="true" />
              {listenerCount ?? '—'} listening
            </span>
            <ThemeSwitcher />
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-[18px]">
          <div className="flex min-h-0 min-w-0 flex-col gap-4">
            <div className="grid flex-none grid-cols-4 gap-3">
              <div className="flex flex-col gap-3">
                {hardKey('timeline', {
                  onClick: () => toggleModal('timeline'),
                  down: modal === 'timeline',
                  aria: 'Open the timeline window',
                  text: 'text-[12px]',
                  extra: 'h-[clamp(52px,8vh,74px)]',
                })}
                {hardKey('booth', {
                  onClick: () => toggleModal('booth'),
                  down: modal === 'booth',
                  accent: true,
                  aria: 'Open the booth window',
                  extra: 'h-[clamp(52px,8vh,74px)]',
                })}
              </div>
              {hardKey('play', {
                onClick: handleTune,
                down: tunedIn,
                pressed: playing,
                aria: tunedIn ? 'Tune out' : 'Tune in',
                extra: 'h-[clamp(116px,17.5vh,160px)]',
              })}
              {hardKey(muted ? 'muted' : 'mute', {
                onClick: toggleMute,
                down: muted,
                aria: muted ? 'Unmute' : 'Mute',
                extra: 'h-[clamp(116px,17.5vh,160px)]',
              })}
              {hardKey('req', {
                onClick: () => (modal === 'req' ? setModal(null) : openRequest()),
                down: modal === 'req',
                led: true,
                aria: 'Open the request window',
                extra: 'h-[clamp(116px,17.5vh,160px)]',
              })}
            </div>

            <Grille hasArt={!!coverUrl} className="min-h-10 flex-1" />

            <div
              className={cn(
                styles.rail,
                'grid flex-none grid-cols-[108px_minmax(0,1fr)_108px] items-end gap-[22px] px-[22px] py-[18px]',
              )}
            >
              {volumeKnob('size-[108px]', 'size-[78px]', 'h-2 w-[54px]')}
              <div className="flex min-w-0 flex-col items-center gap-3 pb-0.5">
                <Fader slotClass="h-2" capClass="size-8" />
                {FADER_LABELS}
              </div>
              <Knob
                outerClass="size-[108px]"
                innerClass={cn(styles.logInner, 'size-[78px]')}
                markClass={cn(styles.knobMark, 'h-2 w-[54px]')}
                caption="log"
                label="Play log — turn to scroll history"
                valueNow={logAt}
                valueMax={maxLogOffset}
                onDrag={(start, frac) =>
                  setLogOffset(
                    Math.min(maxLogOffset, Math.max(0, Math.round(start + frac * 4.5))),
                  )
                }
                onStep={dir =>
                  setLogOffset(cur => Math.min(maxLogOffset, Math.max(0, cur + dir)))
                }
              />
            </div>

            <div className="grid flex-none grid-cols-4 gap-3">
              {logAt === 0 && (
                <button
                  type="button"
                  onClick={() => { if (like.available) void like.like(); }}
                  disabled={!like.available || like.pending || like.liked}
                  aria-pressed={like.liked}
                  aria-label={like.liked ? 'Saved to the log' : 'Save this track'}
                  className={cn(
                    styles.key,
                    'v3-focus relative flex flex-col gap-2 border-0 p-3.5 px-4 text-left',
                    like.available && !like.liked ? 'cursor-pointer' : 'cursor-default',
                  )}
                >
                  <span className="font-mono text-[9px] font-bold tracking-[0.16em] text-[var(--accent)] uppercase">
                    now{like.count > 0 ? ` · ${like.count} ♥` : ''}
                  </span>
                  <span className="line-clamp-2 h-[2.2em] font-display text-[clamp(15px,1.4vw,20px)] leading-[1.05] font-extrabold text-[var(--u-keytext)]">
                    {title}
                  </span>
                  <span className="truncate font-mono text-[9px] tracking-[0.12em] text-[var(--u-keytext-dim)] uppercase">
                    {artist || 'live stream'}
                  </span>
                  <span
                    className={cn(
                      like.liked ? styles.ledSaved : styles.ledOn,
                      'absolute right-3 bottom-3 size-2 rounded-full',
                    )}
                    aria-hidden="true"
                  />
                </button>
              )}
              {history.slice(Math.max(0, logAt - 1), Math.max(0, logAt - 1) + (logAt === 0 ? 3 : 4)).map((h, i) => (
                <div
                  key={`${entryTime(h) ?? i}-${h.title ?? i}`}
                  className={cn(styles.key, 'relative flex flex-col gap-2 p-3.5 px-4')}
                >
                  <span className="font-mono text-[9px] font-bold tracking-[0.16em] text-[var(--u-keytext-dim)]">
                    {turnClock(entryTime(h), timezone, stationLocale)}
                  </span>
                  <span className="line-clamp-2 h-[2.2em] font-display text-[clamp(15px,1.4vw,20px)] leading-[1.05] font-extrabold text-[var(--u-keytext)]">
                    {h.title ?? '—'}
                  </span>
                  <span className="truncate font-mono text-[9px] tracking-[0.12em] text-[var(--u-keytext-dim)] uppercase">
                    {h.artist ?? ''}
                  </span>
                  <span className={cn(styles.ledOff, 'absolute right-3 bottom-3 size-2 rounded-full')} aria-hidden="true" />
                </div>
              ))}
              {history.length === 0 && logAt === 0 && (
                <div
                  className={cn(
                    styles.key,
                    'col-span-3 flex items-center px-4 font-mono text-[10px] tracking-[0.14em] text-[var(--u-keytext-dim)] uppercase',
                  )}
                >
                  the log fills as the night plays on
                </div>
              )}
            </div>
          </div>

          <div
            className={cn(
              styles.glass,
              'relative flex min-h-0 min-w-0 flex-col gap-[clamp(12px,2vh,22px)] overflow-hidden p-[clamp(20px,2.5vw,36px)]',
            )}
          >
            <div className={cn(styles.glassSheen, 'pointer-events-none absolute inset-0')} aria-hidden="true" />
            <div
              className={cn(
                styles.doto,
                styles.dotGlow,
                'line-clamp-2 text-[clamp(40px,5.6vw,88px)] leading-[0.94] break-words text-[#f4f0e6] uppercase',
              )}
            >
              {title}
            </div>
            <div className={cn(styles.doto, 'flex flex-col gap-2 leading-[1.15]')}>
              <span className="truncate text-[clamp(19px,2.3vw,34px)] text-[#cfc9bb] uppercase">
                {artist || (offline ? 'tune back soon' : meta.facts.join(' · ') || 'one live stream')}
              </span>
              <span className="truncate text-[clamp(15px,1.75vw,26px)] text-[var(--accent)] uppercase">
                {trackLine}
              </span>
            </div>
            <div className={cn(styles.progTrack, 'relative h-1.5 flex-none')}>
              <div
                className={cn(
                  'absolute inset-y-0 left-0',
                  ratio == null ? 'w-full bg-[var(--accent)] opacity-40' : styles.progFill,
                )}
              />
            </div>
            <div className="mt-auto flex min-h-[96px] flex-1 items-end">
              <Bars
                count={7}
                playing={playing}
                audioRef={audioRef}
                className="h-full max-h-[300px] flex-1 gap-[9px]"
              />
            </div>
            <div
              className={cn(
                styles.doto,
                'flex flex-none items-baseline justify-between gap-4 text-[clamp(13px,1.3vw,19px)] tracking-[0.06em] text-[#8a8478] uppercase',
              )}
            >
              <span className="truncate">{nextLine}</span>
              <span className="truncate text-right">{footerRight}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col lg:hidden">
        <div
          className={cn(
            styles.engravedSoft,
            'flex h-8 flex-none items-center justify-between px-[18px] font-mono text-[10px] tracking-[0.12em] uppercase',
          )}
        >
          <span className="tabular-nums">{clock}</span>
          <span className="flex items-center gap-2.5">
            {onAirLamp('size-[7px]')}
            <span>{listenerCount ?? '—'} listening</span>
            <ThemeSwitcher />
          </span>
        </div>

        <div className="flex flex-none items-baseline justify-between px-4 pb-3">
          {wordmark('text-[19px]')}
          <span
            className={cn(
              styles.engravedSoft,
              'min-w-0 truncate pl-3 font-mono text-[8px] font-bold tracking-[0.2em] uppercase',
            )}
          >
            {showName || 'freeform'} · {djName}
          </span>
        </div>

        <div
          className={cn(
            styles.glass,
            'relative mx-4 flex flex-none flex-col gap-3 overflow-hidden px-[18px] pt-[18px] pb-3.5',
          )}
        >
          <div className={cn(styles.glassSheen, 'pointer-events-none absolute inset-0')} aria-hidden="true" />
          <div
            className={cn(
              styles.doto,
              styles.dotGlow,
              'line-clamp-2 text-[38px] leading-none break-words text-[#f4f0e6] uppercase',
            )}
          >
            {title}
          </div>
          <div className={cn(styles.doto, 'flex flex-col gap-1 text-[19px] leading-[1.15]')}>
            <span className="truncate text-[#cfc9bb] uppercase">
              {artist || (offline ? 'tune back soon' : 'one live stream')}
            </span>
            <span className="truncate text-[var(--accent)] uppercase">{trackLine}</span>
          </div>
          <div className="flex items-end">
            <Bars
              count={6}
              playing={playing}
              mobile
              audioRef={audioRef}
              className="h-[74px] flex-1 gap-[5px]"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className={cn(styles.doto, 'truncate text-[13px] text-[#8a8478] uppercase')}>
              {nextLine}
            </span>
            {like.available && (
              <button
                type="button"
                onClick={() => void like.like()}
                disabled={like.pending || like.liked}
                aria-pressed={like.liked}
                aria-label={like.liked ? 'Saved' : 'Save this track'}
                className={cn(
                  'v3-focus flex flex-none items-center gap-1 border-0 bg-transparent p-0 font-mono text-[12px] font-bold',
                  like.liked ? 'text-[var(--accent)]' : 'cursor-pointer text-[#8a8478]',
                  like.pending && 'opacity-60',
                )}
              >
                {like.liked ? '♥' : '♡'}
                {like.count > 0 && <span className="text-[10px] tabular-nums">{like.count}</span>}
              </button>
            )}
          </div>
        </div>

        <div
          className={cn(
            styles.rail,
            'mx-4 mt-3.5 grid flex-none grid-cols-[96px_minmax(0,1fr)] items-center gap-[18px] px-[18px] py-4',
          )}
        >
          {volumeKnob('size-24', 'size-[70px]', 'h-[7px] w-12')}
          <div className="flex min-w-0 flex-col gap-3.5">
            <Fader slotClass="h-[7px]" capClass="size-[30px]" />
            {FADER_LABELS}
            <span
              className={cn(
                styles.engravedSoft,
                'font-mono text-[8px] font-bold tracking-[0.14em] uppercase',
              )}
            >
              log · open timeline for history
            </span>
          </div>
        </div>

        <Grille hasArt={!!coverUrl} className="mx-4 mt-3.5 min-h-6 flex-1" />

        <div className="mx-4 mt-3.5 grid flex-none grid-cols-3 gap-2.5">
          {hardKey('play', {
            onClick: handleTune,
            down: tunedIn,
            pressed: playing,
            aria: tunedIn ? 'Tune out' : 'Tune in',
            text: 'text-[12px] tracking-[0.14em]',
            extra: 'h-[62px]',
          })}
          {hardKey(muted ? 'muted' : 'mute', {
            onClick: toggleMute,
            down: muted,
            aria: muted ? 'Unmute' : 'Mute',
            text: 'text-[12px] tracking-[0.14em]',
            extra: 'h-[62px]',
          })}
          {hardKey('req', {
            onClick: () => (modal === 'req' ? setModal(null) : openRequest()),
            down: modal === 'req',
            led: true,
            ledSm: true,
            aria: 'Open the request window',
            text: 'text-[12px] tracking-[0.14em]',
            extra: 'h-[62px]',
          })}
        </div>
        <div className="mx-4 mt-2.5 mb-4 grid flex-none grid-cols-2 gap-2.5">
          {hardKey('timeline', {
            onClick: () => toggleModal('timeline'),
            down: modal === 'timeline',
            aria: 'Open the timeline window',
            text: 'text-[12px] tracking-[0.14em]',
            extra: 'h-14',
          })}
          {hardKey('booth', {
            onClick: () => toggleModal('booth'),
            down: modal === 'booth',
            accent: true,
            aria: 'Open the booth window',
            text: 'text-[12px] tracking-[0.14em]',
            extra: 'h-14',
          })}
        </div>
      </div>

      {windows}

      {/* The tap is the browser's audio-unblock gesture. */}
      {showOverlay && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 grid w-full cursor-pointer place-items-center border-0 bg-[var(--bg)]/95 p-6"
        >
          <span className="grid w-full max-w-[420px] justify-items-stretch gap-4">
            <span className={cn(styles.glass, 'relative flex flex-col gap-3 overflow-hidden p-6 text-left')}>
              <span className={cn(styles.glassSheen, 'pointer-events-none absolute inset-0')} aria-hidden="true" />
              <span
                className={cn(
                  styles.doto,
                  styles.dotGlow,
                  'truncate text-[34px] leading-none text-[#f4f0e6] uppercase',
                )}
              >
                {stationName}
              </span>
              <span className={cn(styles.doto, 'truncate text-[15px] text-[var(--accent-2,var(--accent))] uppercase')}>
                {nowPlaying?.title ? `now: ${nowPlaying.title}` : 'one live broadcast'}
              </span>
              <Bars count={7} playing={false} mobile className="h-16 gap-1.5" />
            </span>
            <span
              className={cn(
                styles.engraved,
                'text-center font-mono text-[11px] font-bold tracking-[0.22em] uppercase',
              )}
            >
              ▶ power on · tune in
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
