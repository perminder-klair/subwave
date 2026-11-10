'use client';


import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Captions, CaptionsOff, Headphones, Heart } from 'lucide-react';
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
import { REQUEST_NAME_MAX } from '@/lib/schemas.generated';
import { fmtTime, normalizeStationLocale, type StationLocale } from '@/lib/format';
import { useStationClient } from '@/lib/stationClient';
import type { StationContext } from '@/lib/types';
import {
  contextLine,
  entryTime,
  lastVoiceLine,
  listenerCountOf,
  progressRatio,
  stationIdentity,
  turnClock,
} from '../shared';
import { CAP_CENTRE } from '../capCentre';
import { useLyricsPreference, useTrackLyrics } from '../lyrics';
import LyricsSettings, { usePopoverDismiss } from '../LyricsSettings';
import { useCrossfade, useRequestSlip, useSkinMotion, useTrackLike, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';
import DriftLyrics from './DriftLyrics';

/* Opacity only, paced against the washes' twenty seconds. mode="wait" leaves a
   beat of empty page between tracks. */
const TYPE_DISSOLVE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.9 },
};
/* Lite: mount straight at rest. A zero-duration transition isn't enough —
   motion still paints `initial` for a frame first, which flashes blank type. */
const TYPE_CUT = {
  initial: false,
  animate: { opacity: 1 },
  // Nothing on the way out either — a fade-to-zero on the outgoing
  // node is still an animation, however brief.
  exit: {},
  transition: { duration: 0 },
};
const COVER_DISSOLVE = { ...TYPE_DISSOLVE, transition: { duration: 1.2 } };
const COVER_CUT = TYPE_CUT;

/* Keep in step with .layer's opacity transition in Drift.module.css. */
const WASH_FADE_MS = 20_000;

/** One drifting pool of colour. A new colour crossfades in on the box's
 *  hidden layer (see ../crossfade.ts) rather than transitioning the
 *  gradient's colour, which repainted it every frame of the fade. */
function Wash({ color, className }: { color: string; className: string }) {
  // Lite turns the fade off in CSS, so a swap there needn't wait for one.
  const fades = useSkinMotion();
  const { layers, front } = useCrossfade(color, fades ? WASH_FADE_MS : 0);
  return (
    <div aria-hidden="true" className={cn(styles.wash, className)}>
      <WashLayer color={layers[0]} front={front === 0} />
      <WashLayer color={layers[1]} front={front === 1} />
    </div>
  );
}

function WashLayer({ color, front }: { color: string; front: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(ref, { '--sw-drift-c': color });
  return <div ref={ref} className={cn(styles.layer, front && styles.front)} />;
}

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

/* The clock and the elapsed time each tick once a second, on two unaligned
   timers, so each lives in the leaf that shows it: at the skin root they
   re-rendered the whole skin twice a second (see useElapsed). */

/** "23:09 saturday · late night", or just the context before the first tick. */
function ClockLine({ timezone, locale, context }: {
  timezone: string | null;
  locale: StationLocale;
  context: StationContext | null;
}) {
  const clock = useClock();
  return clock
    ? [
        `${turnClock(clock.getTime(), timezone, locale)} ${stationWeekday(clock, timezone)}`,
        contextLine(context),
      ].filter(Boolean).join(' · ')
    : contextLine(context);
}

function Progress({ startedAt, duration, compact = false }: {
  startedAt: number | null;
  duration: number;
  /** The small form, under the title while lyrics hold the centre. */
  compact?: boolean;
}) {
  const elapsed = useElapsed(startedAt);
  const ratio = progressRatio(elapsed, duration) ?? 0;
  const fillRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(fillRef, { width: `${Math.round(ratio * 100)}%` });
  const time = cn('font-mono text-ink/70', compact ? 'text-[9px]' : 'text-[11px]');
  return (
    <div className={cn('flex items-center', compact ? 'mt-1.5 gap-2' : 'mt-2 gap-3')}>
      <span className={time}>{fmtTime(elapsed)}</span>
      <div
        className={cn(
          'relative bg-[color-mix(in_oklab,var(--ink)_18%,transparent)]',
          compact ? 'h-[2px] w-[min(140px,30vw)]' : 'h-[3px] w-[min(260px,50vw)]',
        )}
      >
        <div ref={fillRef} className="absolute top-0 bottom-0 left-0 bg-[var(--accent)]" />
      </div>
      <span className={time}>{fmtTime(duration)}</span>
    </div>
  );
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

  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const voice = lastVoiceLine(session.messages);
  const upNext = state.upcoming?.[0];
  const duration = nowPlaying?.duration;

  const coverId = nowPlaying?.subsonic_id ?? null;
  const coverSrc = coverId ? client.coverUrl(coverId) : null;
  const colors = useCoverColors(coverSrc);
  const c1 = colors.vibrant ?? 'var(--accent)';
  const c2 = colors.average ?? 'var(--muted)';

  const adjustVolume = useVolumeNudge();
  const like = useTrackLike();

  // One key per airing: offline and the placeholder collapse to constants so a
  // transient null from the 5s /state poll can't re-fire the dissolve
  // mid-track.
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

  // Lyrics, synced or not, take the centre of the page (DriftLyrics) and
  // everything else there shrinks around them. The operator's switch rides GET /state;
  // within it, L shows and hides them for this browser, and the corner's
  // lyrics icon (the ··· panel on a phone) opens their settings. One answer
  // per track feeds both the lines and the settings.
  const lyricsOn = state.lyrics?.enabled === true;
  const lyricsPref = useLyricsPreference();
  const showLyrics = lyricsOn && lyricsPref.shown && !offline;
  const lyricsTrack = useTrackLyrics(showLyrics ? nowPlaying?.subsonic_id : null);
  const [lyricsPresent, setLyricsPresent] = useState(false);
  const focus = showLyrics && lyricsPresent;

  const [panelOpen, setPanelOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const lyricsButtonRef = useRef<HTMLButtonElement | null>(null);
  const lyricsPopoverRef = useRef<HTMLDivElement | null>(null);
  const closeLyrics = useCallback(() => setLyricsOpen(false), []);
  usePopoverDismiss(lyricsOpen, closeLyrics, lyricsPopoverRef, lyricsButtonRef);
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
      ...(lyricsOn ? { l: () => void lyricsPref.toggle() } : {}),
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
      <Wash
        color={`color-mix(in oklab, ${c1} 29%, transparent)`}
        className={cn(styles.washA, 'top-[-20%] left-[-10%] h-[70vmax] w-[70vmax]')}
      />
      <Wash
        color={`color-mix(in oklab, ${c2} 34%, transparent)`}
        className={cn(styles.washB, 'right-[-14%] bottom-[-28%] h-[85vmax] w-[85vmax]')}
      />
      <Wash
        color="color-mix(in oklab, var(--accent) 10%, transparent)"
        className={cn(styles.washC, 'top-[-30%] left-[40%] h-[55vmax] w-[55vmax]')}
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_45%,transparent_55%,var(--overlay))]"
        aria-hidden="true"
      />

      <div className="absolute top-7 left-8 max-w-[70%] truncate font-mono text-[11px] tracking-[0.24em] text-ink uppercase sm:max-w-[45%]">
        {stationName} — {showName ? `${showName} with ${djName}` : `small hours with ${djName}`}
      </div>
      {/* Baseline-aligned so the palette sits on the run's cap centre (see
          CAP_CENTRE_16); the run is hidden below sm, so the nudge starts there. */}
      <div className="absolute top-7 right-8 flex max-w-[45%] items-baseline gap-3 font-mono text-[11px]">
        <span className="hidden min-w-0 truncate tracking-[0.24em] text-muted uppercase sm:block">
          <ClockLine timezone={timezone} locale={stationLocale} context={context} />
        </span>
        <ThemeSwitcher className="sm:-my-2 sm:translate-y-[calc(50%-0.5cap)]" />
      </div>
      <div className="absolute bottom-7 left-8 max-w-[38%] truncate font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
        {upNext?.title ? `up next · ${[upNext.title, upNext.artist].filter(Boolean).join(' — ')}` : ''}
      </div>
      {/* One baseline for the corner, with the icons on its cap centre
          (CAP_CENTRE). Every group inside is baseline-aligned too: a centred
          group that leads with an icon takes the icon's bottom edge as its
          baseline, which lifted the count and the heart above the volume. */}
      <div className="absolute right-8 bottom-7 flex items-baseline gap-2 font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
        <span className="hidden items-baseline gap-1.5 sm:inline-flex">
          {listenerCount != null && (
            <span className="inline-flex items-baseline gap-1" aria-label={`${listenerCount} listening`}>
              <Headphones aria-hidden className={cn('size-3', CAP_CENTRE)} strokeWidth={1.5} />
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
              'v3-focus inline-flex items-baseline gap-1 border-0 bg-transparent p-0',
              like.liked ? 'text-[var(--accent)]' : 'cursor-pointer text-muted hover:text-ink',
              like.pending && 'opacity-60',
            )}
          >
            <Heart aria-hidden className={cn('size-3', CAP_CENTRE, like.liked && 'fill-current')} strokeWidth={1.5} />
            {like.count > 0 && like.count}
          </button>
        )}
        {lyricsOn && (
          // An icon, like the heart beside it, and from sm up only: on a phone
          // the corner already reaches the ··· button, whose panel carries the
          // same settings.
          <button
            ref={lyricsButtonRef}
            type="button"
            onClick={() => {
              setPanelOpen(false);
              setLyricsOpen((open) => !open);
            }}
            aria-expanded={lyricsOpen}
            aria-haspopup="dialog"
            aria-label="Lyrics settings"
            title="Lyrics (L shows or hides them)"
            className={cn(
              'v3-focus hidden cursor-pointer items-baseline border-0 bg-transparent p-0 hover:text-ink sm:inline-flex',
              lyricsPref.shown || lyricsOpen ? 'text-ink' : 'text-muted',
            )}
          >
            {lyricsPref.shown
              ? <Captions aria-hidden className={cn('size-3', CAP_CENTRE)} strokeWidth={1.5} />
              : <CaptionsOff aria-hidden className={cn('size-3', CAP_CENTRE)} strokeWidth={1.5} />}
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

      {/* Keep the title clickable without intercepting clicks on the corner controls. */}
      {!showOverlay && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center',
            focus ? 'gap-6' : 'gap-4',
          )}
        >
          {/* Two arrangements that dissolve into each other: the full stack,
              or one small line while lyrics hold the centre. */}
          <AnimatePresence mode="wait" initial={false}>
            {focus ? (
              <m.div key="compact" {...typeSwap} className="flex max-w-full items-center gap-3.5">
                {coverSrc && (
                  <div className="relative h-12 w-12 shrink-0 border border-soft-border sm:h-14 sm:w-14">
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
                <div className="flex min-w-0 flex-col items-start text-left">
                  <AnimatePresence mode="wait" initial={false}>
                    <m.button
                      key={trackKey}
                      type="button"
                      onClick={handleTune}
                      {...typeSwap}
                      className="v3-focus pointer-events-auto max-w-[min(420px,60vw)] cursor-pointer truncate border-0 bg-transparent p-0 text-left font-display text-[clamp(16px,2vw,20px)] leading-tight font-semibold text-ink"
                    >
                      {nowPlaying?.title ?? 'somewhere on the dial'}
                    </m.button>
                  </AnimatePresence>
                  {metaLine && (
                    <div className="mt-0.5 max-w-[min(420px,60vw)] truncate font-mono text-[9px] tracking-[0.2em] text-ink/70 uppercase">
                      {metaLine}
                    </div>
                  )}
                  {duration != null && duration > 0 && (
                    <Progress startedAt={trackStartedAt} duration={duration} compact />
                  )}
                </div>
              </m.div>
            ) : (
              <m.div key="full" {...typeSwap} className="flex max-w-full flex-col items-center gap-4">
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
                <div className="mt-2 font-mono text-[10px] tracking-[0.28em] text-accent-2 uppercase">
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
                      className="max-w-full truncate font-mono text-[12px] tracking-[0.2em] text-ink/75 uppercase"
                    >
                      {metaLine}
                    </m.div>
                  </AnimatePresence>
                )}
                {!offline && duration != null && duration > 0 && (
                  <Progress startedAt={trackStartedAt} duration={duration} />
                )}
              </m.div>
            )}
          </AnimatePresence>

          {/* Mounted in both arrangements, at one place in the tree, so a
              change of arrangement never refetches or resets the lyrics. */}
          {showLyrics && (
            <DriftLyrics
              track={lyricsTrack}
              trackStartedAt={trackStartedAt}
              onPresenceChange={setLyricsPresent}
            />
          )}

          {voice && (focus ? (
            <div className="flex max-w-[min(560px,90vw)] items-baseline gap-2">
              <span className="min-w-0 truncate font-display text-[13px] text-ink/60 italic">“{voice.text}”</span>
              <span className="shrink-0 font-mono text-[9px] tracking-[0.3em] text-muted uppercase">— {djName}</span>
            </div>
          ) : (
            <div className="mt-9 flex max-w-[520px] flex-col gap-2.5">
              <div className="font-display text-[clamp(15px,2.4vw,21px)] leading-normal italic">
                “{voice.text}”
              </div>
              <div className="font-mono text-[9px] tracking-[0.3em] text-muted uppercase">
                — {djName}, on air
              </div>
            </div>
          ))}
        </div>
      )}

      {!showOverlay && (
        <button
          type="button"
          onClick={() => {
            setLyricsOpen(false);
            setPanelOpen(o => !o);
          }}
          aria-expanded={panelOpen}
          className="v3-focus absolute bottom-6 left-1/2 -translate-x-1/2 cursor-pointer border border-soft-border/50 bg-[var(--field)]/25 px-4 py-1 font-mono text-[12px] tracking-[0.3em] text-muted backdrop-blur-md hover:bg-[var(--field)]/45 hover:text-ink"
        >
          ···
        </button>
      )}

      {panelOpen && (
        <div className="absolute bottom-16 left-1/2 flex w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 border border-soft-border bg-[var(--bg)]/90 p-4 backdrop-blur-sm">
          <form
            className="flex flex-col gap-2"
            onSubmit={e => { e.preventDefault(); void slip.send(); }}
          >
            {slip.ack ? (
              <div className="flex items-baseline gap-2.5">
                <span className="min-w-0 flex-1 text-[13px] italic">{slip.ack}</span>
                <button
                  type="button"
                  onClick={slip.reset}
                  className="v3-focus cursor-pointer border-0 bg-transparent p-0 font-mono text-[10px] tracking-[0.2em] text-muted uppercase hover:text-ink"
                >
                  again
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-baseline gap-2.5">
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
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] tracking-[0.2em] text-muted uppercase">from</span>
                  <input
                    value={slip.name}
                    onChange={e => slip.setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') setPanelOpen(false); }}
                    placeholder="your name (optional)"
                    maxLength={REQUEST_NAME_MAX}
                    className="v3-focus min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-ink italic outline-none placeholder:text-muted/70"
                  />
                </div>
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
          {lyricsOn && (
            // A phone's way to the lyrics settings; from sm up the corner
            // icon opens them.
            <div className="border-t border-soft-border pt-2.5 sm:hidden">
              <LyricsSettings shown={lyricsPref.shown} onToggle={lyricsPref.toggle} track={lyricsTrack} />
            </div>
          )}
        </div>
      )}

      {lyricsOn && lyricsOpen && !showOverlay && (
        <div
          ref={lyricsPopoverRef}
          role="dialog"
          aria-label="Lyrics settings"
          className="absolute right-8 bottom-14 z-30 w-[min(340px,calc(100vw-2rem))] border border-soft-border bg-[var(--bg)]/95 p-4"
        >
          <LyricsSettings shown={lyricsPref.shown} onToggle={lyricsPref.toggle} track={lyricsTrack} />
        </div>
      )}

      {showOverlay && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 grid w-full cursor-pointer place-items-center border-0 bg-[color-mix(in_srgb,var(--bg)_30%,transparent)]"
        >
          <span className={cn('font-display text-[clamp(28px,4vw,40px)] font-semibold text-ink lowercase', styles.breathe)}>
            listen
          </span>
        </button>
      )}
    </div>
  );
}
