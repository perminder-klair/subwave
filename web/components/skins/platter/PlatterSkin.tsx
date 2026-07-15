'use client';

// Platter — the flagship vinyl face: a reference turntable IS the interface.
// Flagship · warm · hi-fi. Design ref: Skins Canvas 3a.
//
// The record spins at 33⅓ while a light-catch sheen sweeps on its own slower
// cycle and the strobe rim ticks; the tonearm swings from its rest onto the
// lead-in when the listener drops the needle (tunes in). The plinth holds the
// transport (START = tune in/out), while the sleeve, metadata, up-next stack,
// booth quote and request slip live in the right-hand column. Everything that
// moves is a co-located keyframe (Platter.module.css) so playback churn never
// touches React.

import { useCallback, useRef } from 'react';
import styles from './Platter.module.css';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useElapsed } from '@/hooks/useElapsed';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/cn';
import { fmtTime, normalizeStationLocale } from '@/lib/format';
import { useStationClient } from '@/lib/stationClient';
import {
  contextLine,
  entryTime,
  lastVoiceLine,
  listenerCountOf,
  progressRatio,
  stationIdentity,
  trackMeta,
  turnClock,
} from '../shared';
import { useRequestSlip, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';

/** The spinning platter itself — rim, vinyl + printed label, light sheen,
 *  spindle cap and the tonearm. Sized to fill its square container so it
 *  scales fluidly; reused (parked, not playing) inside the tune-in gate. */
function Deck({
  playing,
  stationName,
  title,
  artist,
}: {
  playing: boolean;
  stationName: string;
  title: string;
  artist: string;
}) {
  return (
    <div className="[container-type:inline-size] relative aspect-square w-[min(52vw,29vh,210px)] lg:w-[min(42vw,72vh,520px)]">
      {/* pitch strobe rim */}
      <div
        className={cn(
          'pointer-events-none absolute inset-[2%] rounded-full border-2 border-dotted border-[var(--muted)] opacity-50',
          styles.rim,
          playing && styles.playing,
        )}
        aria-hidden="true"
      />

      {/* the record — grooves, accent ring, printed paper label */}
      <div
        className={cn('absolute inset-[6%] rounded-full', styles.vinyl, styles.record, playing && styles.playing)}
        aria-hidden="true"
      >
        <div className="absolute inset-[30.5%] rounded-full border-2 border-[var(--accent)]" />
        <div className="absolute inset-[32%] flex flex-col items-center justify-center gap-[2%] rounded-full border border-[#0c0a09] bg-[#ece5d6] px-[6%] text-center text-[#161412]">
          <span className="font-mono text-[clamp(6px,1.3cqw,9px)] font-bold tracking-[0.26em] text-[var(--accent)]">
            {stationName}
          </span>
          <span className="line-clamp-2 font-display text-[clamp(13px,3.1cqw,22px)] leading-[0.95] font-extrabold italic">
            {title}
          </span>
          <span className="truncate font-mono text-[clamp(5px,1.1cqw,8px)] tracking-[0.2em] text-[#7a736a] uppercase">
            {artist}
          </span>
          <span className="my-[2%] size-[6%] rounded-full bg-[#0c0a09]" />
          <span className="font-mono text-[clamp(5px,0.95cqw,7px)] tracking-[0.22em] text-[#7a736a]">
            SIDE A · 33⅓ RPM
          </span>
        </div>
      </div>

      {/* light-catch sheen — independent slower sweep */}
      <div
        className={cn('pointer-events-none absolute inset-[6%] rounded-full', styles.sheen, playing && styles.playing)}
        aria-hidden="true"
      />

      {/* centre spindle cap */}
      <div
        className="absolute top-1/2 left-1/2 size-[2.3%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#0c0a09] bg-[#b9b1a1]"
        aria-hidden="true"
      />

      {/* tonearm — one SVG in the deck's own coordinate space, so the headshell
          stays welded to the tube end and the stylus lands on the groove. The
          pivot sits rear-right (86% 19%) like a real deck; the arm reaches down
          onto the RIGHT-hand grooves (never crossing the label) so the record's
          clockwise spin draws the stylus along the groove instead of shoving it.
          The whole arm swings up off the record when tuned out (see .arm). */}
      <svg
        viewBox="0 0 100 100"
        className={cn(
          'pointer-events-none absolute inset-0 h-full w-full overflow-visible',
          styles.arm,
          playing ? styles.armLive : styles.armRest,
        )}
        aria-hidden="true"
      >
        {/* arm tube — dark outline under a light-metal core */}
        <line x1="86" y1="19" x2="72.8" y2="58.5" strokeWidth={2.3} strokeLinecap="round" className="stroke-ink" />
        <line x1="86" y1="19" x2="72.8" y2="58.5" strokeWidth={1.1} strokeLinecap="round" className="stroke-[#e6e0d2]" />
        {/* counterweight past the pivot */}
        <rect x="83.1" y="11.8" width="9" height="5" rx="1" strokeWidth={0.6} transform="rotate(108.4 87.6 14.3)" className="fill-[#22201d] stroke-ink" />
        {/* pivot mount */}
        <circle cx="86" cy="19" r="3.6" strokeWidth={0.8} className="fill-[#d9d2c4] stroke-ink" />
        <circle cx="86" cy="19" r="1.2" className="fill-ink" />
        {/* headshell + cartridge at the tip */}
        <rect x="67.3" y="60.5" width="8" height="5.4" rx="0.8" strokeWidth={0.6} transform="rotate(130.4 71.3 63.2)" className="fill-[#22201d] stroke-ink" />
        {/* stylus dropped onto the groove */}
        <line x1="70" y1="67" x2="69.4" y2="69.7" strokeWidth={1.1} strokeLinecap="round" className="stroke-[var(--accent)]" />
      </svg>
    </div>
  );
}

export default function PlatterSkin(_props: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume } = usePlayerActions();
  const { showTuneIn, showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const meta = trackMeta(nowPlaying);
  const ratio = progressRatio(elapsed, nowPlaying?.duration);
  const voice = lastVoiceLine(session.messages);
  const upNext = (state.upcoming ?? []).slice(0, 2);
  const history = (state.history ?? []).slice(0, 24);
  const stationLocale = normalizeStationLocale(locale);
  const playing = tunedIn && status === 'playing' && !offline;

  const title = offline ? '— off air —' : (nowPlaying?.title ?? 'Scanning the dial…');
  const artist = offline ? '' : (nowPlaying?.artist ?? '');

  const adjustVolume = useVolumeNudge();

  // The vertical fader doubles as the volume control — map pointer Y to level.
  const faderRef = useRef<HTMLDivElement | null>(null);
  const setVolFromPointer = useCallback(
    (clientY: number) => {
      const el = faderRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const frac = 1 - (clientY - r.top) / r.height;
      setVolume(Math.min(1, Math.max(0, Math.round(frac * 100) / 100)));
    },
    [setVolume],
  );

  // Drive the progress + volume fills through CSS vars (no inline style attr).
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(rootRef, { '--pf': ratio ?? 0, '--vf': volume });

  const slip = useRequestSlip({
    sent: 'Slip on the platter — the booth has your note.',
    refused: 'The booth waved this one off.',
    failed: 'The booth line is down — try again in a moment.',
  });
  const reqInputRef = useRef<HTMLInputElement | null>(null);

  useKeyboardShortcuts({
    space: handleTune,
    k: handleTune,
    arrowup: () => adjustVolume(0.05),
    arrowdown: () => adjustVolume(-0.05),
    m: toggleMute,
    r: () => { if (!showTuneIn) reqInputRef.current?.focus(); },
  });

  return (
    <div ref={rootRef} className="absolute inset-0 flex flex-col overflow-hidden bg-bg font-sans text-ink">
      {/* masthead */}
      <div className="flex flex-none items-center justify-between gap-x-6 border-b border-ink px-5 py-3 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex-none text-[15px] font-extrabold tracking-[0.14em]">{stationName.toUpperCase()}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden items-center gap-3 font-mono text-[11px] tracking-[0.16em] uppercase md:flex">
            {showName && <span className="max-w-[22vw] truncate">▸ {showName}</span>}
            <span className="text-[var(--accent)]">with {djName}</span>
            <span className="max-w-[24vw] truncate border-l border-soft-border pl-3 text-muted">
              {contextLine(context) || (offline ? 'off air' : 'on air')}
            </span>
          </div>
          <ThemeSwitcher />
        </div>
      </div>

      {/* body — turntable over metadata on phones (the body scrolls if the
          content is taller than the screen); two side-by-side columns on lg. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* ===== the plinth ===== */}
        <div className="relative flex flex-none flex-col items-center gap-3 border-b border-ink bg-linear-to-br from-[var(--field)] to-[color-mix(in_oklab,var(--field)_82%,var(--bg))] px-6 py-3 lg:w-[46%] lg:max-w-[680px] lg:flex-1 lg:flex-row lg:justify-center lg:gap-0 lg:border-r lg:border-b-0 lg:py-10">
          <span className="absolute top-5 left-6 font-mono text-[9px] tracking-[0.24em] text-muted uppercase">
            direct drive · quartz lock
          </span>

          {/* deck-area: on phones this flex-1 wrapper centres the platter in the
              space above the controls (breathing room above it, not stuck to
              the top); on lg it collapses (display:contents) so the deck centres
              in the whole plinth. */}
          <div className="flex w-full items-center justify-center pt-8 lg:contents">
            <Deck playing={playing} stationName={stationName} title={title} artist={artist} />
          </div>

          {/* the deck IS the control surface: START/STOP drops or lifts the
              needle, MUTE sits beside it, and the fader is the volume. Laid out
              as a row beneath the deck on phones (clear of the vinyl); mounted
              in the plinth corners from lg up (the wrapper goes display:contents
              so each cluster positions itself absolutely). */}
          <div className="flex w-full items-end justify-between gap-4 lg:contents">
            <div className="flex items-end gap-3 lg:absolute lg:bottom-6 lg:left-6">
              <button
                type="button"
                onClick={handleTune}
                aria-label={tunedIn ? 'Tune out' : 'Tune in'}
                className={cn(
                  'v3-focus flex size-20 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-full border border-ink',
                  tunedIn ? 'bg-[var(--accent)] text-bg' : 'bg-bg text-ink hover:bg-[var(--field)]',
                )}
              >
                <span className="text-[30px] leading-none">{tunedIn ? '■' : '▶'}</span>
                <span className="font-mono text-[8px] font-bold tracking-[0.22em]">{tunedIn ? 'STOP' : 'START'}</span>
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={muted}
                aria-label={muted ? 'Unmute' : 'Mute'}
                className={cn(
                  'v3-focus grid size-14 cursor-pointer place-items-center rounded-full border border-ink font-mono text-[9px] font-bold tracking-[0.1em]',
                  muted ? 'bg-ink text-bg' : 'bg-bg hover:bg-[var(--field)]',
                )}
              >
                {muted ? 'MUTED' : 'MUTE'}
              </button>
            </div>

            {/* volume fader — the pitch-slider hardware, now the volume control */}
            <div className="flex flex-col items-center gap-2 lg:absolute lg:right-6 lg:bottom-6">
              <div
                ref={faderRef}
                role="slider"
                aria-label="Volume"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(volume * 100)}
                tabIndex={0}
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setVolFromPointer(e.clientY); }}
                onPointerMove={e => { if (e.buttons) setVolFromPointer(e.clientY); }}
                onKeyDown={e => {
                  if (e.key === 'ArrowUp') { e.preventDefault(); adjustVolume(0.05); }
                  else if (e.key === 'ArrowDown') { e.preventDefault(); adjustVolume(-0.05); }
                }}
                className="v3-focus relative h-16 w-7 cursor-pointer touch-none border border-ink bg-bg lg:h-36"
              >
                <span className="pointer-events-none absolute top-2 bottom-2 left-1/2 w-px -translate-x-1/2 bg-soft-border" aria-hidden="true" />
                <span className="pointer-events-none absolute top-2 left-1 h-px w-[3px] bg-[var(--accent)]" aria-hidden="true" />
                <span className="pointer-events-none absolute bottom-2 left-1 h-px w-[3px] bg-[var(--accent)]" aria-hidden="true" />
                <span className={cn('pointer-events-none absolute inset-x-0 bottom-0 bg-[var(--muted)]', styles.faderFill)} aria-hidden="true" />
                <span className={cn('pointer-events-none absolute -right-[3px] -left-[3px] h-3 -translate-y-1/2 border border-ink bg-ink', styles.faderThumb)} aria-hidden="true" />
              </div>
              <span className="font-mono text-[8px] font-bold tracking-[0.2em] text-muted uppercase">vol {Math.round(volume * 100)}</span>
            </div>
          </div>
        </div>

        {/* ===== metadata column ===== */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 overflow-hidden p-4 lg:gap-4 lg:overflow-hidden lg:p-6">
          {/* now playing */}
          <div className="flex items-start gap-5">
            <div className="size-[84px] flex-none border border-ink bg-[var(--field)] sm:size-[104px]">
              {nowPlaying?.subsonic_id && !offline ? (
                <img src={client.coverUrl(nowPlaying.subsonic_id)} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center font-mono text-[9px] text-muted">Sleeve</div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-mono text-[10px] font-bold tracking-[0.22em] text-[var(--accent)] uppercase">
                now spinning
              </span>
              <span className="truncate font-display text-[clamp(30px,5vw,54px)] leading-[0.98] font-extrabold italic">
                {title}
              </span>
              {artist && (
                <span className="truncate font-mono text-[14px] tracking-[0.14em] uppercase">{artist}</span>
              )}
              {!offline && (nowPlaying?.album || nowPlaying?.year) && (
                <span className="truncate font-mono text-[11px] tracking-[0.12em] text-muted uppercase">
                  {[nowPlaying.album, nowPlaying.year].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
          </div>

          {/* chips */}
          {(meta.facts.length > 0 || meta.moods.length > 0) && !offline && (
            <div className={cn('flex gap-[7px] overflow-x-auto lg:flex-wrap lg:overflow-visible', styles.chipRow)}>
              {meta.facts.map(f => (
                <span key={f} className="shrink-0 border border-ink px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] whitespace-nowrap">{f}</span>
              ))}
              {meta.moods.map(m => (
                <span key={m} className="shrink-0 border border-[var(--accent)] px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] whitespace-nowrap text-[var(--accent)] uppercase">
                  {m}
                </span>
              ))}
            </div>
          )}

          {/* progress */}
          <div className="flex items-center gap-3">
            <span className="font-mono text-[13px] font-bold tabular-nums">{fmtTime(elapsed)}</span>
            <div className="relative h-1 flex-1 bg-soft-border">
              <div className={cn('absolute inset-y-0 left-0 bg-[var(--accent)]', ratio == null ? 'w-full opacity-40' : styles.progFill)} />
              {ratio != null && <div className={cn('absolute top-[-5px] h-[13px] w-[3px] bg-ink', styles.progHead)} />}
            </div>
            <span className="font-mono text-[13px] text-muted tabular-nums">
              {nowPlaying?.duration ? fmtTime(nowPlaying.duration) : 'live'}
            </span>
          </div>

          <div className="h-px bg-soft-border" />

          {/* up next */}
          <div className="flex flex-col border border-ink bg-[var(--field)]">
            <div className="border-b border-soft-border px-3.5 py-2.5 font-mono text-[9px] font-bold tracking-[0.22em] text-muted uppercase">
              next on the platter
            </div>
            {upNext.length > 0 ? (
              upNext.map((t, i) => (
                <div
                  key={`${t.title ?? i}-${i}`}
                  className={cn(
                    'flex items-center gap-3 px-3.5 py-2.5',
                    i < upNext.length - 1 && 'border-b border-soft-border max-lg:border-b-0',
                    i > 0 && 'hidden lg:flex',
                  )}
                >
                  <span className={cn('font-mono text-[9px] tracking-[0.18em]', i === 0 ? 'text-[var(--accent)]' : 'text-muted')}>
                    {i === 0 ? 'CUED' : 'THEN'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-bold">{t.title ?? '—'}</div>
                    {t.artist && <div className="truncate text-[11px] text-muted">{t.artist}</div>}
                  </div>
                </div>
              ))
            ) : (
              <div className="px-3.5 py-2.5 font-mono text-[11px] text-muted">
                nothing cued — {djName} decides at the run-out
              </div>
            )}
          </div>

          {/* booth quote — the DJ's voice. Hidden in the single-column (phone /
              narrow) layout so the deck fits one screen without scrolling; it
              returns in the two-column layout (lg) where the column scrolls. */}
          {voice && (
            <div className="hidden flex-none flex-col gap-2 border border-ink bg-bg px-4 py-3.5 lg:flex">
              <span className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
                <span className={cn('size-[7px] rounded-full bg-[var(--accent)]', styles.pulse, playing && styles.playing)} />
                on air — {djName}
              </span>
              <span className="text-[15px] leading-relaxed italic">“{voice.text}”</span>
            </div>
          )}

          {/* recently spun — the flip side of the up-next stack, and what fills
              the tall right column. Desktop only: the phone layout drops it (as
              the booth quote is) so the deck + metadata fit one screen. The panel
              takes the leftover height (flex-1) and ONLY its list scrolls (shadcn
              ScrollArea) — the surrounding column never scrolls (lg:overflow-hidden),
              so the deck, transport and request slip stay put. */}
          <div className="hidden min-h-0 flex-1 flex-col border border-ink bg-[var(--field)] lg:flex">
            <div className="flex-none border-b border-soft-border px-3.5 py-2.5 font-mono text-[9px] font-bold tracking-[0.22em] text-muted uppercase">
              recently spun
            </div>
            <ScrollArea type="auto" className="min-h-0 flex-1">
              {history.length > 0 ? (
                history.map((h, i) => (
                  <div
                    key={`${entryTime(h) ?? ''}-${h.title ?? i}`}
                    className="flex items-center gap-3 border-b border-soft-border px-3.5 py-2 last:border-b-0"
                  >
                    <span className="size-1.5 flex-none rounded-full border border-[var(--muted)]" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-bold">{h.title ?? '—'}</div>
                      {h.artist && <div className="truncate text-[11px] text-muted">{h.artist}</div>}
                    </div>
                    <span className="flex-none font-mono text-[10px] text-muted tabular-nums">
                      {turnClock(entryTime(h), timezone, stationLocale)}
                    </span>
                  </div>
                ))
              ) : (
                <div className="px-3.5 py-2.5 font-mono text-[11px] text-muted">
                  the platter's been quiet — nothing spun yet this session
                </div>
              )}
            </ScrollArea>
          </div>

          {/* request slip */}
          <form
            className="border border-ink bg-[var(--field)] px-4 py-3"
            onSubmit={e => { e.preventDefault(); void slip.send(); }}
          >
            {slip.ack ? (
              <div className="flex flex-col gap-2">
                <div className="text-[13px] leading-relaxed italic">{slip.ack}</div>
                <button
                  type="button"
                  onClick={slip.reset}
                  className="v3-focus cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[10px] font-bold tracking-[0.14em] text-muted uppercase hover:text-ink"
                >
                  new slip
                </button>
              </div>
            ) : (
              <div className="flex items-baseline gap-3">
                <span className="flex-none font-mono text-[10px] font-bold tracking-[0.16em] text-muted uppercase">Dear DJ —</span>
                <input
                  ref={reqInputRef}
                  value={slip.text}
                  onChange={e => slip.setText(e.target.value)}
                  placeholder="a song, an artist, a feeling…"
                  className="v3-focus min-w-0 flex-1 border-0 border-b border-soft-border bg-transparent pb-1 text-[13px] text-ink italic outline-none placeholder:text-muted"
                />
                <button
                  type="submit"
                  disabled={slip.sending || !slip.text.trim()}
                  className={cn(
                    'v3-focus flex-none border-0 bg-transparent p-0 font-mono text-[10px] font-bold tracking-[0.14em] uppercase',
                    slip.sending || !slip.text.trim()
                      ? 'cursor-default text-muted opacity-60'
                      : 'cursor-pointer text-[var(--accent)] hover:opacity-80',
                  )}
                >
                  {slip.sending ? 'sending…' : 'send ↗'}
                </button>
              </div>
            )}
          </form>
        </div>
      </div>

      {/* footer status strip */}
      <div className="flex flex-none items-center gap-4 border-t border-ink bg-[var(--field)] px-6 py-3 font-mono text-[10px] tracking-[0.16em] uppercase">
        <span className={cn('flex items-center gap-2 font-bold', offline ? 'text-muted' : 'text-[var(--accent)]')}>
          <span className={cn('size-2 rounded-full', offline ? 'bg-[var(--muted)]' : cn('bg-[var(--accent)]', styles.pulse, playing && styles.playing))} />
          {offline ? 'off air' : playing ? 'tuned · locked' : 'standby'}
        </span>
        {listenerCount != null && (
          <span className="flex items-center gap-1.5 border-l border-soft-border pl-4 text-muted">
            <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current" strokeWidth={2} aria-hidden="true">
              <path d="M4 14v-2a8 8 0 0 1 16 0v2" strokeLinecap="round" />
              <rect x="2.5" y="13" width="4" height="7.5" rx="1.5" />
              <rect x="17.5" y="13" width="4" height="7.5" rx="1.5" />
            </svg>
            {listenerCount}
            <span className="sr-only">listening</span>
          </span>
        )}
        {signal.latencyMs != null && tunedIn && !offline && (
          <span className="text-muted">sig {signal.latencyMs} ms · {signal.quality}</span>
        )}
        <span className="ml-auto hidden text-muted sm:inline">stereo · 96 kHz</span>
      </div>

      {/* tune-in gate — the deck sits at rest with the arm parked; one tap
          drops the needle and the platter spins up. */}
      {showOverlay && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 grid w-full cursor-pointer place-items-center border-0 bg-[var(--bg)]/95 p-6"
        >
          <span className="grid justify-items-center gap-6">
            <Deck playing={false} stationName={stationName} title={nowPlaying?.title ?? 'one live stream'} artist={artist} />
            <span className="grid justify-items-center gap-1.5 text-center">
              <span className="font-mono text-[11px] font-bold tracking-[0.24em] text-[var(--accent)] uppercase">
                ▶ drop the needle
              </span>
              <span className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">tap to tune in</span>
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
