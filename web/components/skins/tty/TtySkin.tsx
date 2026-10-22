'use client';

// TTY — the station as a live process. Panes and an htop-style key bar by
// default; focus mode (F, or the status line's toggle, remembered as
// `subwave:tty-focus`) hands the window to an ANSI landscape that plays along
// with the music, chosen for the station's hour and weather unless the
// listener picks one ([ and ]). Every drawing here — the scenes, the scope,
// the cover — is characters on one grid (term/), in the theme's own colours.

import { useEffect, useMemo, useRef, useState } from 'react';
import { m, steps } from 'motion/react';
import styles from './Tty.module.css';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useElapsed } from '@/hooks/useElapsed';
import { useClock } from '@/lib/hooks';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { cn } from '@/lib/cn';
import { REQUEST_NAME_MAX } from '@/lib/schemas.generated';
import { fmtTime, normalizeStationLocale } from '@/lib/format';
import { useStationClient } from '@/lib/stationClient';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  boothLines,
  contextLine,
  entryTime,
  lastVoiceLine,
  listenerCountOf,
  progressRatio,
  stationIdentity,
  trackMeta,
  turnClock,
} from '../shared';
import {
  useDjOnAir, useRequestSlip, useSkinCalm, useSkinMotion, useTrackLike, useVolumeNudge,
} from '../sharedHooks';
import type { SkinProps } from '../types';
import { CAP_CENTRE_16 } from '../capCentre';
import AsciiCover from './AsciiCover';
import BannerArt from './BannerArt';
import FocusStage from './FocusStage';
import Scope from './Scope';
import type { StageInfo } from './focus';
import { INSTRUMENTS, isInstrument, type InstrumentId } from './instruments';
import { useStoredPref } from './prefs';
import {
  SCENES, autoSceneId, isScenePick, periodForHour, sceneById, weatherOf, type ScenePick,
} from './scenes';
import { useSignal } from './term/useSignal';

const PROGRESS_CELLS = 16;
const VOL_CELLS = 8;

/* Print cadence: 14ms a cell, compressed past ~32 cells so even a very long
   title lands inside the cap rather than holding the pane for a second. */
const PRINT_STEP_MS = 14;
const PRINT_CAP_MS = 450;

const isFlag = (v: unknown): v is '1' | '0' => v === '1' || v === '0';
const SCENE_ORDER: readonly ScenePick[] = ['auto', ...SCENES.map(s => s.id)];

/** The hour on the station's clock, for picking a scene when the feed hasn't
 *  named the day period. */
function stationHour(d: Date, timeZone: string | null | undefined): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timeZone ?? undefined }).format(d));
  } catch {
    return d.getHours();
  }
}

/** The reveal is a clip-path wipe stepped to the character count, not an
 *  opacity ramp. Keyed on its own text, so changing the text remounts and
 *  reprints. No exit animation, deliberately — which is also why this needs no
 *  AnimatePresence. */
function Printed({
  text, printing, delay = 0, className, children,
}: {
  /** The line's plain text — sets the cadence, and keys the reprint. */
  text: string;
  printing: boolean;
  delay?: number;
  className?: string;
  /** What to render when the line carries markup. Defaults to `text`. */
  children?: React.ReactNode;
}) {
  const cells = Math.max(text.length, 1);
  // Lite mode means no motion element at all: a zero-duration transition would
  // still paint `initial` for a frame, and here `initial` is a full-width clip
  // — a blank line flashing on every track change.
  if (!printing) {
    return <span className={cn('inline-block', className)}>{children ?? text}</span>;
  }
  const duration = Math.min(cells * PRINT_STEP_MS, PRINT_CAP_MS) / 1000;
  return (
    <m.span
      key={text}
      // Units match across both keyframes (all four values percent) so motion
      // interpolates the inset rather than snapping between two strings it
      // can't line up.
      initial={{ clipPath: 'inset(0% 100% 0% 0%)' }}
      animate={{ clipPath: 'inset(0% 0% 0% 0%)' }}
      transition={{ duration, delay, ease: steps(cells) }}
      className={cn('inline-block', className)}
    >
      {children ?? text}
    </m.span>
  );
}

/** A TUI window: a ruled frame with its title set into the top border, the
 *  way lazygit and btop label theirs. */
function Pane({
  title, hint, right, className, bodyClassName, children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  /** Controls set into the top border's right end. */
  right?: React.ReactNode;
  /** The frame itself: size and placement. */
  className?: string;
  /** The body inside it: padding, gaps, scrolling. A frame that scrolled
   *  would clip the title sitting on its border. */
  bodyClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className={cn('relative flex min-h-0 min-w-0 flex-col border border-[var(--line)]', className)}>
      <h2 className="absolute -top-[0.6em] left-3 m-0 flex max-w-[calc(100%-1.5rem)] items-baseline gap-2 bg-bg px-1.5 text-[11px] leading-none font-normal tracking-[0.14em] whitespace-nowrap select-none">
        <span className="font-bold text-ink uppercase">{title}</span>
        {hint && <span className="truncate text-muted">{hint}</span>}
      </h2>
      {right && (
        <div className="absolute -top-[0.6em] right-3 flex items-baseline gap-1 bg-bg px-1.5 text-[11px] leading-none tracking-[0.1em]">
          {right}
        </div>
      )}
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', bodyClassName)}>{children}</div>
    </section>
  );
}

/** One key on the htop-style bar: the key itself, then its action on a
 *  filled label. `pressed` inverts the label for toggles that are on. */
function FnKey({
  k, label, onClick, pressed, disabled, ariaLabel, className,
}: {
  k: string;
  label: React.ReactNode;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      className={cn(
        'v3-focus group inline-flex cursor-pointer items-stretch border-0 bg-transparent p-0 font-mono text-[11px] leading-[1.6] tracking-[0.06em] uppercase disabled:cursor-default',
        className,
      )}
    >
      <span className="pr-1 font-bold text-ink">{k}</span>
      <span
        className={cn(
          'px-1.5',
          pressed
            ? 'bg-ink text-bg'
            : 'bg-[var(--accent)] text-bg group-hover:bg-ink group-disabled:bg-[var(--accent)]',
        )}
      >
        {label}
      </span>
    </button>
  );
}

export default function TtySkin(_props: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute } = usePlayerActions();
  const { showTuneIn, showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const clock = useClock();
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const meta = trackMeta(nowPlaying);
  const ratio = progressRatio(elapsed, nowPlaying?.duration);
  const booth = boothLines(session.messages, 24);
  const upNext = state.upcoming?.[0];
  const playing = tunedIn && status === 'playing' && !offline;

  const adjustVolume = useVolumeNudge();
  const like = useTrackLike();
  const calm = useSkinCalm();

  // The panes' pictures wait for this (every stored pref lands in the same
  // commit): with focus saved, they'd mount canvases and atlases only for
  // the stage to replace them a commit later.
  const [focusPref, setFocusPref, prefsLoaded] = useStoredPref('subwave:tty-focus', '0', isFlag);
  const focus = focusPref === '1';
  const toggleFocus = () => setFocusPref(focus ? '0' : '1');
  const [scenePick, setScenePick] = useStoredPref<ScenePick>('subwave:tty-scene', 'auto', isScenePick);
  const cycleScene = (dir: 1 | -1) => {
    const i = SCENE_ORDER.indexOf(scenePick);
    setScenePick(SCENE_ORDER[(i + dir + SCENE_ORDER.length) % SCENE_ORDER.length]!);
  };
  const [instrument, setInstrument] = useStoredPref<InstrumentId>('subwave:tty-scope', 'spectrum', isInstrument);
  const cycleInstrument = () => {
    const i = INSTRUMENTS.findIndex(x => x.id === instrument);
    setInstrument(INSTRUMENTS[(i + 1) % INSTRUMENTS.length]!.id);
  };

  const period = context?.time?.period ?? (clock ? periodForHour(stationHour(clock, timezone)) : undefined);
  const weather = weatherOf(context?.weather?.condition);
  const sceneId = scenePick === 'auto' ? autoSceneId(period, weather) : scenePick;
  const scene = sceneById(sceneId);

  const sample = useSignal({ active: playing, calm, bpm: nowPlaying?.bpm, trackStartedAt });

  const onMic = useDjOnAir();
  const voice = useMemo(() => lastVoiceLine(session.messages), [session.messages]);

  const [reqOpen, setReqOpen] = useState(false);
  const [logDeep, setLogDeep] = useState(false);
  const [rawCover, setRawCover] = useState(false);
  const slip = useRequestSlip({
    sent: 'request received — the DJ is on it.',
    refused: 'request refused.',
    failed: 'network error — request not sent.',
  });
  const reqInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (reqOpen) reqInputRef.current?.focus(); }, [reqOpen]);

  useKeyboardShortcuts(
    {
      space: handleTune,
      k: handleTune,
      arrowup: () => adjustVolume(0.1),
      arrowdown: () => adjustVolume(-0.1),
      m: toggleMute,
      r: () => setReqOpen(true),
      f: toggleFocus,
      l: focus ? undefined : () => setLogDeep(d => !d),
      v: focus ? undefined : cycleInstrument,
      '[': focus ? () => cycleScene(-1) : undefined,
      ']': focus ? () => cycleScene(1) : undefined,
      // Only while focus is on, so Escape still reaches menus otherwise.
      escape: focus ? toggleFocus : undefined,
    },
    { disabled: showTuneIn || reqOpen },
  );

  // A printable key or Enter tunes in — deliberately NOT literally any key:
  // Tab keeps focus traversal (keyboard users must still be able to leave the
  // gate) and F-keys/Escape/arrows stay with the browser. A press another
  // shortcut map already claimed is ceded to it, and this handler
  // preventDefaults its own accepts, so one keypress can't do both.
  useEffect(() => {
    if (!showTuneIn || offline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented) return;
      if (e.key.length !== 1 && e.key !== 'Enter') return;
      e.preventDefault();
      tuneInFromOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTuneIn, offline]);

  const history = (state.history ?? []).slice(0, logDeep ? 40 : 12);
  const filled = ratio == null ? 0 : Math.round(ratio * PROGRESS_CELLS);
  const volFilled = Math.round(volume * VOL_CELLS);
  const coverId = nowPlaying?.subsonic_id;
  const coverUrl = coverId && !offline ? client.coverUrl(coverId) : null;
  useEffect(() => { setRawCover(false); }, [coverUrl]);

  // Lite mode's CSS kill can't reach motion — gate the print ourselves. The
  // first paint doesn't print either, because the boot log already animates.
  const mayPrint = useSkinMotion();
  const painted = useRef(false);
  useEffect(() => { painted.current = true; }, []);
  const printing = mayPrint && painted.current;

  const albumLine = [nowPlaying?.album, nowPlaying?.year].filter(Boolean).join(' · ');
  const stage: StageInfo = {
    title: offline ? 'off air' : nowPlaying?.title ?? 'scanning…',
    byline: offline
      ? 'nothing on the stream'
      : [nowPlaying?.artist, albumLine].filter(Boolean).join(' — '),
    facts: offline ? '' : [...meta.facts, ...meta.moods].join(' · '),
    elapsed: fmtTime(elapsed),
    duration: fmtTime(nowPlaying?.duration),
    ratio: offline ? null : ratio,
    status: offline ? 'off air' : playing ? 'on air' : tunedIn ? 'tuning' : 'standby',
    live: playing,
  };
  const caption = playing && onMic && voice ? { who: djName, text: voice.text } : null;
  // The boot screen is opaque: nothing under it needs to animate.
  const covered = showOverlay && !offline;

  const tuneLabel = offline
    ? 'off air'
    : tunedIn
      ? (status === 'playing' ? 'tuned ●' : 'tuning…')
      : 'tune in';

  return (
    <div className="absolute inset-0 overflow-hidden bg-bg p-3 font-mono text-[13px] leading-relaxed text-ink sm:p-6">
      <div className="flex h-full w-full flex-col gap-4">

        {/* The status line. */}
        <div className="flex flex-none items-center justify-between gap-x-4 border border-ink px-4 py-2.5">
          <div className="min-w-0 truncate text-[13px] tracking-[0.1em]">
            <span className={cn(offline ? 'text-muted' : 'text-[var(--accent)]')}>●</span>{' '}
            <span className="font-bold">{stationName.toUpperCase()}</span>
            {showName ? <> ▸ {showName.toUpperCase()}</> : null}
            <span className="text-[var(--accent)]"> — WITH {djName.toUpperCase()}</span>
          </div>
          {/* Baseline-aligned so the palette can sit on the run's cap centre
              (CAP_CENTRE_16). The focus toggle is text at every width, so the
              nudge applies at every width too. */}
          <div className="flex shrink-0 items-baseline gap-3 text-[12px]">
            <span className="hidden max-w-[40vw] truncate tracking-[0.1em] text-muted uppercase sm:inline">
              {[contextLine(context), clock ? turnClock(clock.getTime(), timezone, stationLocale) : '']
                .filter(Boolean).join(' · ')}
            </span>
            <button
              type="button"
              onClick={toggleFocus}
              aria-pressed={focus}
              aria-label="Focus mode"
              title={focus ? 'Back to the panes (F)' : 'Focus — the window becomes a scene (F)'}
              className={cn(
                'v3-focus shrink-0 cursor-pointer border-0 bg-transparent p-0 tracking-[0.1em] uppercase',
                focus ? 'font-bold text-[var(--accent)]' : 'text-muted hover:text-ink',
              )}
            >
              {focus ? '[▣ focus]' : '[▢ focus]'}
            </button>
            <ThemeSwitcher className={CAP_CENTRE_16} />
          </div>
        </div>

        {focus ? (
          <Pane
            title={scene.file}
            hint={scenePick === 'auto' ? `auto · ${period?.replace('-', ' ') ?? 'station clock'}${weather !== 'clear' ? ` · ${weather}` : ''}` : 'pinned'}
            right={(
              <>
                <button type="button" aria-label="Previous scene" onClick={() => cycleScene(-1)}
                  className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">[</button>
                <span className="text-muted">scene</span>
                <button type="button" aria-label="Next scene" onClick={() => cycleScene(1)}
                  className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">]</button>
              </>
            )}
            className="flex-1"
            bodyClassName="relative overflow-hidden"
          >
            <FocusStage sceneId={sceneId} weather={weather} info={stage} caption={caption} sample={sample} calm={calm} paused={covered} />
            <p className="sr-only">
              {offline
                ? 'Off air.'
                : `Now playing: ${nowPlaying?.title ?? 'unknown'}${nowPlaying?.artist ? ` by ${nowPlaying.artist}` : ''}.`}
              {caption ? ` ${caption.who} on the mic: ${caption.text}` : ''}
            </p>
          </Pane>
        ) : (
          <>
            <div className="grid min-h-0 flex-[2] grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-4 lg:grid-cols-[1fr_380px] lg:grid-rows-1">
              <Pane
                title="now playing"
                hint={stage.status}
                bodyClassName="gap-4 overflow-y-auto px-5 pt-5 pb-4 sm:px-6"
              >
                <div className="flex min-w-0 flex-row items-start gap-4 sm:gap-6">
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <div className="text-[clamp(22px,4vw,46px)] leading-[1.05] font-extrabold tracking-[0.06em] uppercase">
                      {offline ? (
                        <span className="text-muted">— OFF AIR —</span>
                      ) : (
                        <Printed text={nowPlaying?.title ?? 'SCANNING…'} printing={printing} />
                      )}
                    </div>
                    {!offline && nowPlaying?.artist && (
                      <div className="text-[15px] tracking-[0.08em] uppercase">
                        <Printed
                          text={nowPlaying.artist + (albumLine ? ` — ${albumLine}` : '')}
                          printing={printing}
                          delay={0.12}
                        >
                          {nowPlaying.artist}
                          {albumLine && <span className="text-muted"> — {albumLine}</span>}
                        </Printed>
                      </div>
                    )}
                    {!offline && (meta.facts.length > 0 || meta.moods.length > 0) && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tracking-[0.1em] uppercase">
                        {meta.facts.map(f => (
                          <span key={f}><span className="text-muted">[</span>{f}<span className="text-muted">]</span></span>
                        ))}
                        {meta.moods.map(mood => (
                          <span key={mood} className="text-[var(--accent)]">#{mood.replace(/\s+/g, '-')}</span>
                        ))}
                      </div>
                    )}
                    {!offline && (
                      <div className="mt-1 text-[14px] tracking-[0.06em]">
                        {fmtTime(elapsed)}{' '}
                        {ratio != null ? (
                          <>
                            <span className="text-[var(--accent)]">{'▓'.repeat(filled)}</span>
                            <span className="text-muted">{'░'.repeat(PROGRESS_CELLS - filled)}</span>
                            {' '}{fmtTime(nowPlaying?.duration)}
                          </>
                        ) : (
                          <span className="text-muted">▸ live — duration unknown</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="hidden flex-none flex-col items-center gap-1.5 sm:flex">
                    <div className="h-[150px] w-[150px] border border-[var(--line)] lg:h-[176px] lg:w-[176px]">
                      {rawCover && coverUrl ? (
                        <img src={coverUrl} alt="" className="h-full w-full object-cover" />
                      ) : prefsLoaded && (
                        <AsciiCover url={coverUrl} onTainted={() => setRawCover(true)} />
                      )}
                    </div>
                    {coverUrl ? (
                      <button
                        type="button"
                        onClick={() => setRawCover(v => !v)}
                        aria-pressed={rawCover}
                        className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-[10px] tracking-[0.14em] text-muted hover:text-ink"
                      >
                        {rawCover ? 'cover.raw ⇄ txt' : 'cover.txt ⇄ raw'}
                      </button>
                    ) : (
                      <span className="text-[10px] tracking-[0.14em] text-muted">cover.txt</span>
                    )}
                  </div>
                </div>
                <Pane
                  title={`scope · ${instrument}`}
                  hint={playing ? undefined : 'idle'}
                  right={(
                    <button type="button" onClick={cycleInstrument}
                      className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted uppercase hover:text-ink">
                      [v] next
                    </button>
                  )}
                  className="mt-1 h-[84px] flex-none sm:h-auto sm:min-h-[104px] sm:flex-1"
                  bodyClassName="px-2 pt-3 pb-1.5"
                >
                  {prefsLoaded && <Scope id={instrument} sample={sample} calm={calm} paused={covered} />}
                </Pane>
              </Pane>

              <Pane title="booth" hint="tail -f" bodyClassName="gap-3 px-5 pt-5 pb-4">
                <ScrollArea className="-mx-5 min-h-0 flex-1">
                  <div className="flex flex-col gap-3 px-5">
                    {booth.length === 0 && (
                      <div className="text-[12px] text-muted">▸ waiting for the booth…</div>
                    )}
                    {/* After a show boundary the previous show's tail is dimmed and
                        voiced under its own host, below a rule (#1690). */}
                    {booth.map((line, i) => line.boundary ? (
                      <div key={`${line.t ?? i}-${i}`} role="separator" className="truncate text-[12px] leading-relaxed text-muted">
                        ──── {line.text} ────
                      </div>
                    ) : (
                      <div key={`${line.t ?? i}-${i}`} className={cn('text-[12px] leading-relaxed break-words', line.carried && 'opacity-60')}>
                        <span className="text-muted">{turnClock(line.t, timezone, stationLocale)}</span>{' '}
                        {line.kind === 'voice' ? (
                          <>
                            <span className="font-bold text-[var(--accent)]">{(line.speaker ?? djName).toUpperCase()} ●</span>{' '}
                            <span>“{line.text}”</span>
                          </>
                        ) : (
                          <span className="text-muted">{line.kind === 'dj' ? 'dj' : 'sys'} ▸ {line.text}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                <div className={cn('text-[12px] text-muted', styles.cursor)}>▊</div>
              </Pane>
            </div>

            <div className="grid min-h-0 flex-none grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-4 sm:flex-[1] sm:grid-cols-2 sm:grid-rows-1">
              <Pane title="up next" hint="queue" bodyClassName="gap-2.5 px-5 pt-5 pb-4">
                {upNext?.title ? (
                  <>
                    <div className="truncate text-[14px] font-bold tracking-[0.06em] uppercase">
                      {upNext.title}
                      {upNext.artist && <span className="font-normal text-muted"> — {upNext.artist}</span>}
                    </div>
                    <div className="text-[11px] tracking-[0.1em] text-muted">
                      queued{upNext.requestedBy ? ` · wire request — ${upNext.requestedBy}` : ''}
                    </div>
                  </>
                ) : (
                  <div className="text-[12px] text-muted">queue empty — the DJ decides at the wire</div>
                )}
              </Pane>
              <Pane title="last" hint={logDeep ? 'history | head -40' : 'history | head'} className="hidden sm:flex" bodyClassName="gap-2 px-5 pt-5 pb-4">
                <ScrollArea className="-mx-5 min-h-0 flex-1">
                  <div className="flex flex-col gap-2 px-5">
                    {history.length === 0 && <div className="text-[12px] text-muted">nothing yet this session</div>}
                    {history.map((h, i) => (
                      <div key={`${h.t ?? i}-${h.title ?? i}`} className="truncate text-[12px] uppercase">
                        <span className="text-muted">{turnClock(entryTime(h), timezone, stationLocale)}</span>{' '}
                        {h.title ?? '?'}
                        {h.artist && <span className="text-muted"> — {h.artist}</span>}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </Pane>
            </div>
          </>
        )}

        {reqOpen ? (
          <div className="flex flex-none flex-col gap-1.5 border border-[var(--accent)] bg-[var(--field)] px-4 py-2.5 text-[12px]">
            <div className="flex items-baseline gap-3">
              <span className="font-bold text-[var(--accent)] select-none">listener@{stationName.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'subwave'}:~$ req</span>
              {slip.ack ? (
                <>
                  <span className="min-w-0 flex-1 truncate">{slip.ack}</span>
                  <button
                    type="button"
                    className="v3-focus cursor-pointer border-0 bg-transparent p-0 tracking-[0.1em] text-muted uppercase hover:text-ink"
                    onClick={() => { slip.reset(); setReqOpen(false); }}
                  >
                    [esc] close
                  </button>
                </>
              ) : (
                <>
                  <input
                    ref={reqInputRef}
                    value={slip.text}
                    onChange={e => slip.setText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void slip.send();
                      if (e.key === 'Escape') setReqOpen(false);
                    }}
                    aria-label="Request a song"
                    placeholder="artist, song, or a vibe… [enter] send · [esc] cancel"
                    className="v3-focus min-w-0 flex-1 border-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-muted"
                  />
                  <span className={cn('text-muted select-none', slip.sending && 'text-[var(--accent)]')}>
                    {slip.sending ? 'sending…' : '▊'}
                  </span>
                </>
              )}
            </div>
            {!slip.ack && (
              <div className="flex items-baseline gap-3">
                <span className="text-muted select-none">  --from</span>
                <input
                  value={slip.name}
                  onChange={e => slip.setName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void slip.send();
                    if (e.key === 'Escape') setReqOpen(false);
                  }}
                  aria-label="Your name (optional)"
                  placeholder="your name (optional)"
                  maxLength={REQUEST_NAME_MAX}
                  className="v3-focus min-w-0 flex-1 border-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-muted/70"
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--line)] pt-2.5">
            <FnKey
              k="␣"
              label={tuneLabel}
              onClick={handleTune}
              pressed={tunedIn && !offline}
              disabled={offline}
              ariaLabel={offline ? 'Off air' : tunedIn ? 'Stop listening' : 'Tune in'}
            />
            <FnKey k="M" label={muted ? 'muted' : 'mute'} onClick={toggleMute} pressed={muted} />
            {like.available && (
              <FnKey
                k="♥"
                label={`${like.liked ? 'liked' : 'like'}${like.count > 0 ? ` ${like.count}` : ''}`}
                onClick={() => void like.like()}
                pressed={like.liked}
                disabled={like.pending || like.liked}
                ariaLabel={like.liked ? 'Liked' : 'Like this track'}
                className={cn(like.pending && 'opacity-60')}
              />
            )}
            <FnKey k="R" label="request" onClick={() => setReqOpen(true)} />
            {focus ? (
              <FnKey k="[]" label="scene" onClick={() => cycleScene(1)} />
            ) : (
              <>
                <FnKey k="V" label="scope" onClick={cycleInstrument} />
                <FnKey k="L" label={logDeep ? 'short log' : 'full log'} onClick={() => setLogDeep(d => !d)} pressed={logDeep} className="hidden sm:inline-flex" />
              </>
            )}
            <FnKey k="F" label="focus" onClick={toggleFocus} pressed={focus} />
            <span className="ml-auto flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] tracking-[0.08em] uppercase">
              {signal.latencyMs != null && tunedIn && (
                <span className="hidden text-muted lg:inline">sig {signal.latencyMs}ms · {signal.quality}</span>
              )}
              {listenerCount != null && (
                <span className="hidden text-muted sm:inline">{listenerCount} listening</span>
              )}
              <span className="inline-flex items-baseline gap-1.5">
                <span className="font-bold text-ink">↑↓</span>
                <button type="button" aria-label="Volume down" onClick={() => adjustVolume(-0.125)}
                  className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">−</button>
                <span aria-label={`Volume ${Math.round(volume * 100)}%`}>
                  vol <span className="text-ink">{'█'.repeat(volFilled)}</span>
                  <span className="text-muted">{'░'.repeat(VOL_CELLS - volFilled)}</span>{' '}
                  {Math.round(volume * 100)}
                </span>
                <button type="button" aria-label="Volume up" onClick={() => adjustVolume(0.125)}
                  className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">+</button>
              </span>
            </span>
          </div>
        )}
      </div>

      {/* The tap/keypress is the browser's audio-unblock gesture. */}
      {covered && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 block w-full cursor-pointer bg-[var(--bg)] p-8 text-left font-mono text-[13px] leading-loose text-ink sm:p-14"
        >
          <span className="grid gap-1">
            <BannerArt text={stationName} className={cn('mb-4 h-[84px] w-full max-w-[760px]', styles.bootline)} />
            <span className={styles.bootline}>{stationName.toLowerCase()} tty — broadcast console</span>
            <span className={cn(styles.bootline, 'text-muted')}>▸ resolving station ............ ok</span>
            <span className={cn(styles.bootline, 'text-muted')}>▸ icecast mount /stream.mp3 .... ok</span>
            <span className={cn(styles.bootline, 'text-muted')}>▸ dj session ................... live</span>
            <span className={cn(styles.bootline, 'text-muted')}>▸ audio pipeline ............... locked</span>
            <span className={cn(styles.bootline, 'font-bold')}>
              audio locked — press any key to tune in <span className={styles.cursor}>▊</span>
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
