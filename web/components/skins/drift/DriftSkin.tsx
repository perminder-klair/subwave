'use client';

// Drift — ninety percent weather, ten percent type; the cover art becomes
// the room. Weightless · dim · patient. Design ref: Skins Canvas 1d.
//
// Three slow washes take their colors from the current cover (vibrant +
// average via useCoverColors, accent as the third voice) and crossfade over
// twenty seconds at a track change. Request + history live behind the ···
// chip; everything else is corners.

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Headphones, Heart } from 'lucide-react';
import styles from './Drift.module.css';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useCoverColors } from '@/hooks/useCoverColors';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { useElapsed } from '@/hooks/useElapsed';
import { useClock } from '@/lib/hooks';
import ThemeSwitcher from '@/components/ThemeSwitcher';
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
  turnClock,
} from '../shared';
import { useRequestSlip, useSkinMotion, useTrackLike, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';

/* Nothing here moves — the room already says everything with color, and the
   type's job is to wait for it (see Drift.module.css). Pure opacity, and slow:
   the washes take twenty seconds, so a 900ms dissolve still reads as the
   hurried part of the transition. mode="wait" leaves a beat of empty page
   between tracks, which suits a skin where nothing else is in a hurry. */
const TYPE_DISSOLVE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.9 },
};
/* Lite: mount straight at rest. A zero-duration transition isn't enough — motion
   still paints `initial` for a frame first, which flashes blank type. mode="wait"
   happens to hide that most of the time; initial={false} removes it outright. */
const TYPE_CUT = {
  initial: false,
  animate: { opacity: 1 },
  // Nothing on the way out either — a fade-to-zero on the outgoing
  // node is still an animation, however brief.
  exit: {},
  transition: { duration: 0 },
};
/* The cover overlaps itself instead of waiting — two stacked frames reading as
   one true dissolve, over the longest beat in the skin. */
const COVER_DISSOLVE = { ...TYPE_DISSOLVE, transition: { duration: 1.2 } };
const COVER_CUT = TYPE_CUT;

/** Lowercase weekday in the station's zone — "23:09 saturday". */
function stationWeekday(now: Date, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      timeZone: timezone ?? undefined,
    }).format(now).toLowerCase();
  } catch {
    return '';
  }
}

export default function DriftSkin(_props: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute } = usePlayerActions();
  const { showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const clock = useClock();
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const ratio = progressRatio(elapsed, nowPlaying?.duration);
  const voice = lastVoiceLine(session.messages);
  const upNext = state.upcoming?.[0];

  // The room's colors — cover-derived, accent as the third voice.
  const coverId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = coverId ? client.coverUrl(coverId) : null;
  const colors = useCoverColors(coverSrc);
  const washARef = useRef<HTMLDivElement | null>(null);
  const washBRef = useRef<HTMLDivElement | null>(null);
  const washCRef = useRef<HTMLDivElement | null>(null);
  const c1 = colors.vibrant ?? 'var(--accent)';
  const c2 = colors.average ?? 'var(--muted)';
  useDynamicStyle(washARef, { '--sw-drift-c': `color-mix(in oklab, ${c1} 29%, transparent)` });
  useDynamicStyle(washBRef, { '--sw-drift-c': `color-mix(in oklab, ${c2} 34%, transparent)` });
  useDynamicStyle(washCRef, { '--sw-drift-c': 'color-mix(in oklab, var(--accent) 10%, transparent)' });

  // Progress hairline fill.
  const fillRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(fillRef, { width: `${Math.round((ratio ?? 0) * 100)}%` });

  const adjustVolume = useVolumeNudge();
  const like = useTrackLike();

  // One key per airing — offline and the "somewhere on the dial" placeholder
  // collapse to constants (as classic/CenterStage does) so a transient null
  // from the 5s /state poll can't re-fire the dissolve mid-track.
  const trackKey = offline
    ? 'offline'
    : coverId
      ? `s:${coverId}`
      : nowPlaying?.title
        ? `t:${nowPlaying.title}`
        : 'placeholder';
  // Lite mode's CSS kill can't reach motion — gate the dissolve ourselves.
  const animates = useSkinMotion();
  const typeSwap = animates ? TYPE_DISSOLVE : TYPE_CUT;
  const coverSwap = animates ? COVER_DISSOLVE : COVER_CUT;

  // The ··· chip: request + recent history in one quiet panel.
  const [panelOpen, setPanelOpen] = useState(false);
  const slip = useRequestSlip({
    sent: 'the DJ has it.',
    refused: 'not this time.',
    failed: 'the booth line is down.',
  });
  const reqInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (panelOpen) reqInputRef.current?.focus(); }, [panelOpen]);

  useKeyboardShortcuts(
    {
      space: handleTune,
      k: handleTune,
      arrowup: () => adjustVolume(0.05),
      arrowdown: () => adjustVolume(-0.05),
      m: toggleMute,
      r: () => setPanelOpen(true),
    },
    { disabled: panelOpen },
  );

  const history = (state.history ?? []).slice(0, 3);
  const metaLine = [
    nowPlaying?.artist,
    [
      [nowPlaying?.album, nowPlaying?.year].filter(Boolean).join(' · '),
      nowPlaying?.genre?.toLowerCase(),
      nowPlaying?.energy ?? undefined,
    ].filter(Boolean).join(' · '),
  ].filter(Boolean).join(' — ');

  return (
    <div className="absolute inset-0 overflow-hidden font-sans text-ink">
      {/* the weather */}
      <div ref={washARef} className={cn(styles.wash, styles.washA, 'top-[-20%] left-[-10%] h-[70vmax] w-[70vmax]')} />
      <div ref={washBRef} className={cn(styles.wash, styles.washB, 'right-[-14%] bottom-[-28%] h-[85vmax] w-[85vmax]')} />
      <div ref={washCRef} className={cn(styles.wash, styles.washC, 'top-[-30%] left-[40%] h-[55vmax] w-[55vmax]')} />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_45%,transparent_55%,var(--overlay))]"
        aria-hidden="true"
      />

      {/* corners — on a phone the clock/context text is dropped so the station
          line and the theme icon can't collide in the middle; it returns from
          sm up where there's room for both halves. */}
      <div className="absolute top-7 left-8 max-w-[70%] truncate font-mono text-[10px] tracking-[0.24em] text-muted uppercase sm:max-w-[45%]">
        {stationName} — {showName ? `${showName} with ${djName}` : `small hours with ${djName}`}
      </div>
      <div className="absolute top-7 right-8 flex max-w-[45%] items-center gap-3">
        <span className="hidden min-w-0 truncate font-mono text-[10px] tracking-[0.24em] text-muted uppercase sm:block">
          {clock
            ? [
                `${turnClock(clock.getTime(), timezone, stationLocale)} ${stationWeekday(clock, timezone)}`,
                contextLine(context),
              ].filter(Boolean).join(' · ')
            : contextLine(context)}
        </span>
        <ThemeSwitcher />
      </div>
      <div className="absolute bottom-7 left-8 max-w-[38%] truncate font-mono text-[10px] tracking-[0.18em] text-muted uppercase">
        {upNext?.title ? `up next · ${[upNext.title, upNext.artist].filter(Boolean).join(' — ')}` : ''}
      </div>
      <div className="absolute right-8 bottom-7 flex items-baseline gap-2 font-mono text-[10px] tracking-[0.18em] text-muted uppercase">
        <span className="hidden items-center gap-1.5 sm:inline-flex">
          {listenerCount != null && (
            <span className="inline-flex items-center gap-1" aria-label={`${listenerCount} listening`}>
              <Headphones aria-hidden className="size-3" strokeWidth={1.5} />
              {listenerCount}
            </span>
          )}
          {listenerCount != null && signal.latencyMs != null && tunedIn && (
            <span aria-hidden>·</span>
          )}
          {signal.latencyMs != null && tunedIn && <span>{signal.latencyMs} ms</span>}
        </span>
        {like.available && (
          <button
            type="button"
            onClick={() => void like.like()}
            disabled={like.pending || like.liked}
            aria-pressed={like.liked}
            aria-label={like.liked ? 'Liked' : 'Like this track'}
            className={cn(
              'v3-focus inline-flex items-center gap-1 border-0 bg-transparent p-0',
              like.liked ? 'text-[var(--accent)]' : 'cursor-pointer text-muted hover:text-ink',
              like.pending && 'opacity-60',
            )}
          >
            <Heart aria-hidden className={cn('size-3', like.liked && 'fill-current')} strokeWidth={1.5} />
            {like.count > 0 && like.count}
          </button>
        )}
        <button type="button" aria-label="Volume down" onClick={() => adjustVolume(-0.05)}
          className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">−</button>
        <button
          type="button"
          onClick={toggleMute}
          className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted uppercase hover:text-ink"
        >
          {muted ? 'muted' : `vol ${Math.round(volume * 100)}`}
        </button>
        <button type="button" aria-label="Volume up" onClick={() => adjustVolume(0.05)}
          className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">+</button>
      </div>

      {/* the ten percent of type. Shown whenever the full-bleed gate isn't
          covering the screen (!showOverlay) — so when the operator disables the
          tune-in overlay, this layer is drift's tune affordance: the label reads
          "tap to listen" and the title tunes in. pointer-events-none so this
          full-screen centering layer doesn't sit over the corner controls
          (ThemeSwitcher, volume) and eat their clicks — the one interactive
          child (the title, which tunes in) re-enables events on itself. */}
      {!showOverlay && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
          {coverSrc && !offline && (
            <div className="relative h-[128px] w-[128px] border border-soft-border sm:h-[152px] sm:w-[152px]">
              <AnimatePresence mode="popLayout" initial={false}>
                <m.img
                  key={coverSrc}
                  src={coverSrc}
                  alt=""
                  {...coverSwap}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </AnimatePresence>
            </div>
          )}
          <div className="mt-2 font-mono text-[9px] tracking-[0.32em] text-muted uppercase">
            {offline ? 'off air' : tunedIn ? 'now playing' : 'now playing — tap to listen'}
          </div>
          {!offline && (
            <AnimatePresence mode="wait" initial={false}>
              <m.button
                key={trackKey}
                type="button"
                onClick={handleTune}
                {...typeSwap}
                className="v3-focus pointer-events-auto max-w-full cursor-pointer border-0 bg-transparent p-0 font-display text-[clamp(26px,5vw,46px)] leading-[1.1] font-semibold text-ink"
              >
                {nowPlaying?.title ?? 'somewhere on the dial'}
              </m.button>
            </AnimatePresence>
          )}
          {!offline && metaLine && (
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={trackKey}
                {...typeSwap}
                className="max-w-full truncate font-mono text-[12px] tracking-[0.2em] text-muted uppercase"
              >
                {metaLine}
              </m.div>
            </AnimatePresence>
          )}
          {!offline && ratio != null && (
            <div className="mt-2 flex items-center gap-3">
              <span className="font-mono text-[10px] text-muted">{fmtTime(elapsed)}</span>
              <div className="relative h-0.5 w-[min(260px,50vw)] bg-soft-border">
                <div ref={fillRef} className="absolute top-0 bottom-0 left-0 bg-[var(--accent)]" />
              </div>
              <span className="font-mono text-[10px] text-muted">{fmtTime(nowPlaying?.duration)}</span>
            </div>
          )}
          {voice && (
            <div className="mt-9 flex max-w-[520px] flex-col gap-2.5">
              <div className="font-display text-[clamp(15px,2.4vw,21px)] leading-normal italic">
                “{voice.text}”
              </div>
              <div className="font-mono text-[9px] tracking-[0.3em] text-muted uppercase">
                — {djName}, on air
              </div>
            </div>
          )}
        </div>
      )}

      {/* the ··· chip — available whenever the poster is up (gate not covering) */}
      {!showOverlay && (
        <button
          type="button"
          onClick={() => setPanelOpen(o => !o)}
          aria-expanded={panelOpen}
          className="v3-focus absolute bottom-6 left-1/2 -translate-x-1/2 cursor-pointer border border-soft-border/50 bg-[var(--field)]/25 px-4 py-1 font-mono text-[12px] tracking-[0.3em] text-muted backdrop-blur-md hover:bg-[var(--field)]/45 hover:text-ink"
        >
          ···
        </button>
      )}

      {/* behind the chip: request + recent history */}
      {panelOpen && (
        <div className="absolute bottom-16 left-1/2 flex w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 border border-soft-border bg-[var(--bg)]/90 p-4 backdrop-blur-sm">
          <form
            className="flex items-baseline gap-2.5"
            onSubmit={e => { e.preventDefault(); void slip.send(); }}
          >
            {slip.ack ? (
              <>
                <span className="min-w-0 flex-1 text-[13px] italic">{slip.ack}</span>
                <button
                  type="button"
                  onClick={slip.reset}
                  className="v3-focus cursor-pointer border-0 bg-transparent p-0 font-mono text-[10px] tracking-[0.2em] text-muted uppercase hover:text-ink"
                >
                  again
                </button>
              </>
            ) : (
              <>
                <input
                  ref={reqInputRef}
                  value={slip.text}
                  onChange={e => slip.setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setPanelOpen(false); }}
                  placeholder="ask the dj for something…"
                  className="v3-focus min-w-0 flex-1 border-0 border-b border-soft-border bg-transparent pb-1 text-[13px] text-ink italic outline-none placeholder:text-muted"
                />
                <button
                  type="submit"
                  disabled={slip.sending || !slip.text.trim()}
                  className={cn(
                    'v3-focus border-0 bg-transparent p-0 font-mono text-[10px] tracking-[0.2em] uppercase',
                    slip.sending || !slip.text.trim()
                      ? 'cursor-default text-muted opacity-60'
                      : 'cursor-pointer text-[var(--accent)] hover:opacity-80',
                  )}
                >
                  {slip.sending ? '…' : 'send'}
                </button>
              </>
            )}
          </form>
          {history.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-soft-border pt-2.5">
              {history.map((h, i) => (
                <div key={`${h.t ?? i}-${h.title ?? i}`} className="flex gap-2.5 font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                  <span>{turnClock(entryTime(h), timezone, stationLocale)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {h.title ?? '?'}{h.artist ? ` — ${h.artist}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* the gate: just the wash and one lowercase word */}
      {showOverlay && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 grid w-full cursor-pointer place-items-center border-0 bg-transparent"
        >
          <span className={cn('font-display text-[clamp(28px,4vw,40px)] font-semibold text-ink lowercase', styles.breathe)}>
            listen
          </span>
        </button>
      )}
    </div>
  );
}
