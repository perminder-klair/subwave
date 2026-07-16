'use client';

// Spool — a tape deck; the whole station rides on one cassette.
// Tactile · warm · mechanical. Design ref: Skins Canvas 1a.
//
// Desktop is a two-column console — the deck + cassette hero on the left, up-next
// and the Side-B request slip on the right — over a full-width Recently rewound
// shelf spanning the bottom. Mobile collapses to a single screen with a bottom tab bar
// (Deck / Rewound / Stack / Slip) so nothing scrolls off. Both reels spin
// while playing; the supply reel's wound tape thins as the take-up reel
// fattens across the runtime (dynamic diameters), a slow sheen crosses the
// window, and the VU needle rides. Everything that moves is a co-located
// keyframe (Spool.module.css) so it never re-renders React.

import { useCallback, useRef, useState, type RefObject } from 'react';
import styles from './Spool.module.css';
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
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { cn } from '@/lib/cn';
import { fmtTime, normalizeStationLocale } from '@/lib/format';
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
import { useRequestSlip, useTrackLike, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';

/** One reel — a dark wound-tape disc (diameter rides --reel-l/--reel-r) with a
 *  toothed sprocket hub that turns while playing. */
function Reel({
  playing, reelClass, hubClass, dotClass,
}: {
  playing: boolean; reelClass?: string; hubClass: string; dotClass: string;
}) {
  return (
    <div className={cn('relative grid aspect-square flex-none place-items-center', reelClass)} aria-hidden="true">
      <span className={cn('absolute inset-0 rounded-full', styles.wound)} />
      <span className={cn('grid place-items-center rounded-full border border-ink', styles.hub, hubClass, playing && styles.playing)}>
        <span className={cn('rounded-full bg-ink', dotClass)} />
      </span>
    </div>
  );
}

/** The tape window — the two reels behind glass with the exposed tape bridge,
 *  capstan and a slow light sheen. Reused across desktop, mobile and the gate. */
function TapeWindow({
  playing, hubClass, dotClass, className,
}: {
  playing: boolean; hubClass: string; dotClass: string; className?: string;
}) {
  return (
    <div className={cn('relative flex min-h-0 items-center justify-between overflow-hidden bg-ink', className)} aria-hidden="true">
      <Reel playing={playing} reelClass={styles.reelL} hubClass={hubClass} dotClass={dotClass} />
      <span className="pointer-events-none absolute inset-x-[8%] bottom-3 h-[2px] bg-linear-to-r from-transparent via-[#4a453c] to-transparent" />
      <span className="pointer-events-none absolute bottom-2 left-1/2 size-2 -translate-x-1/2 rounded-full border border-ink bg-bg" />
      <span className={cn('pointer-events-none absolute inset-0', styles.sheen, playing && styles.playing)} />
      <Reel playing={playing} reelClass={styles.reelR} hubClass={hubClass} dotClass={dotClass} />
    </div>
  );
}

/** Two little reels — the cassette signature on up-next cards. */
function MiniHubs() {
  return (
    <div className="flex gap-10" aria-hidden="true">
      <span className="size-3.5 rounded-full border-[3px] border-[var(--muted)]" />
      <span className="size-3.5 rounded-full border-[3px] border-[var(--muted)]" />
    </div>
  );
}

type MobileTab = 'deck' | 'rewound' | 'stack' | 'slip';
const MOBILE_TABS: { id: MobileTab; label: string }[] = [
  { id: 'deck', label: 'Deck' },
  { id: 'rewound', label: 'Rewound' },
  { id: 'stack', label: 'Stack' },
  { id: 'slip', label: 'Slip' },
];

export default function SpoolSkin(_props: SkinProps) {
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline } = usePlayerAudio();
  const { toggleMute, setVolume, stop } = usePlayerActions();
  const { showTuneIn, showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const meta = trackMeta(nowPlaying);
  const ratio = progressRatio(elapsed, nowPlaying?.duration);
  const ratioSafe = ratio ?? 0.5;
  const voice = lastVoiceLine(session.messages);
  const upNext = (state.upcoming ?? []).slice(0, 6);
  const history = (state.history ?? []).slice(0, 12);
  const playing = tunedIn && status === 'playing' && !offline;

  const title = offline ? '— off air —' : (nowPlaying?.title ?? 'Scanning the dial…');
  const artist = offline ? '' : (nowPlaying?.artist ?? '');

  const [tab, setTab] = useState<MobileTab>('deck');
  const adjustVolume = useVolumeNudge();

  // Progress + volume fills and reel diameters, all via CSS vars (no inline
  // style attribute). The supply reel (left) thins as the take-up (right) fills.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(rootRef, {
    '--pf': ratio ?? 0,
    '--vf': volume,
    '--reel-l': `${(46 - 12 * ratioSafe).toFixed(1)}%`,
    '--reel-r': `${(30 + 12 * ratioSafe).toFixed(1)}%`,
  });

  // Horizontal VOL fader (desktop) — map pointer X to level.
  const volRef = useRef<HTMLDivElement | null>(null);
  const setVolFromPointer = useCallback(
    (clientX: number) => {
      const el = volRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const frac = (clientX - r.left) / r.width;
      setVolume(Math.min(1, Math.max(0, Math.round(frac * 100) / 100)));
    },
    [setVolume],
  );

  const like = useTrackLike();
  const slip = useRequestSlip({
    sent: 'Slip passed to the booth — the DJ has it.',
    refused: 'The booth waved this one off.',
    failed: 'The booth line is down — try again in a moment.',
  });
  // Desktop and mobile each render their own copy of the request slip (both
  // in the DOM, one hidden per breakpoint), so each input gets its own ref;
  // the `r` shortcut focuses whichever slip is actually on screen.
  const reqDeckRef = useRef<HTMLInputElement | null>(null);
  const reqSlipRef = useRef<HTMLInputElement | null>(null);

  const playIn = () => { if (!tunedIn) handleTune(); };
  const stopOut = () => { if (tunedIn) stop(); };

  useKeyboardShortcuts({
    space: handleTune,
    k: handleTune,
    arrowup: () => adjustVolume(0.05),
    arrowdown: () => adjustVolume(-0.05),
    m: toggleMute,
    r: () => {
      if (showTuneIn) return;
      const deck = reqDeckRef.current;
      // offsetParent === null ⇒ that layout is display:none for this breakpoint.
      if (deck && deck.offsetParent !== null) { deck.focus(); return; }
      setTab('slip');
      requestAnimationFrame(() => reqSlipRef.current?.focus());
    },
  });

  // ── shared control atoms ────────────────────────────────────────────────
  const playKey = (extra: string) => (
    <button
      type="button"
      onClick={playIn}
      aria-label="Tune in"
      aria-pressed={playing}
      className={cn(
        'v3-focus flex cursor-pointer items-center justify-center gap-2 border border-ink',
        playing
          ? 'bg-[var(--accent)] text-bg shadow-[inset_0_3px_6px_rgba(0,0,0,0.25)]'
          : 'bg-bg hover:bg-[var(--overlay)]',
        extra,
      )}
    >
      ▶<span className="font-mono font-bold tracking-[0.14em]">PLAY</span>
    </button>
  );
  const stopKey = (extra: string) => (
    <button
      type="button"
      onClick={stopOut}
      aria-label="Tune out"
      className={cn('v3-focus flex cursor-pointer items-center justify-center border border-ink bg-bg hover:bg-[var(--overlay)]', extra)}
    >
      ■
    </button>
  );
  const muteKey = (extra: string) => (
    <button
      type="button"
      onClick={toggleMute}
      aria-pressed={muted}
      aria-label={muted ? 'Unmute' : 'Mute'}
      className={cn(
        'v3-focus flex cursor-pointer items-center justify-center border border-ink font-mono font-bold tracking-[0.1em]',
        muted ? 'bg-ink text-bg' : 'bg-bg hover:bg-[var(--overlay)]',
        extra,
      )}
    >
      {muted ? 'MUTED' : 'MUTE'}
    </button>
  );
  const likeKey = (extra: string) =>
    like.available && (
      <button
        type="button"
        onClick={() => void like.like()}
        disabled={like.pending || like.liked}
        aria-pressed={like.liked}
        aria-label={like.liked ? 'Liked' : 'Like this track'}
        className={cn(
          'v3-focus flex items-center justify-center gap-1 border border-ink font-mono font-bold tracking-[0.1em]',
          like.liked ? 'bg-[var(--accent)] text-bg' : 'cursor-pointer bg-bg hover:bg-[var(--overlay)]',
          like.pending && 'opacity-60',
          extra,
        )}
      >
        {like.liked ? '♥' : '♡'}
        {like.count > 0 && <span className="text-[0.7em] tabular-nums">{like.count}</span>}
      </button>
    );

  const requestForm = (ref: RefObject<HTMLInputElement | null>) => (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3"
      onSubmit={e => { e.preventDefault(); void slip.send(); }}
    >
      {slip.ack ? (
        <div className="flex flex-col gap-2">
          <div className="text-[13px] leading-relaxed italic">{slip.ack}</div>
          <button
            type="button"
            onClick={slip.reset}
            className="v3-focus cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[11px] font-bold tracking-[0.14em] text-muted uppercase hover:text-ink"
          >
            new slip
          </button>
        </div>
      ) : (
        <>
          <div className="text-[13px] text-muted italic">Dear DJ —</div>
          <input
            ref={ref}
            value={slip.text}
            onChange={e => slip.setText(e.target.value)}
            placeholder="a song, an artist, a feeling…"
            className="v3-focus w-full border-0 border-b border-soft-border bg-transparent pb-1 text-[13px] text-ink italic outline-none placeholder:text-muted"
          />
          <input
            value={slip.name}
            onChange={e => slip.setName(e.target.value)}
            placeholder="from (optional)"
            className="v3-focus w-full border-0 border-b border-soft-border bg-transparent pb-1 text-[13px] text-ink italic outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={slip.sending || !slip.text.trim()}
            className={cn(
              'v3-focus mt-auto self-start border-0 bg-transparent p-0 font-mono text-[11px] font-bold tracking-[0.14em] uppercase',
              slip.sending || !slip.text.trim()
                ? 'cursor-default text-muted opacity-60'
                : 'cursor-pointer text-[var(--accent)] hover:opacity-80',
            )}
          >
            {slip.sending ? 'passing…' : 'pass it to the booth ↗'}
          </button>
        </>
      )}
    </form>
  );

  const historyList = (
    <>
      {history.length === 0 && (
        <div className="p-4 font-mono text-[11px] text-muted">nothing on the shelf yet</div>
      )}
      {history.map((h, i) => (
        <div
          key={`${h.t ?? i}-${h.title ?? i}`}
          className="flex flex-none items-center gap-3 border-b border-soft-border px-4 py-2.5"
        >
          <span className="size-2 flex-none rounded-full border-2 border-[var(--muted)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-bold">{h.title ?? '?'}</div>
            {h.artist && <div className="truncate text-[11px] text-muted">{h.artist}</div>}
          </div>
          <span className="flex-none font-mono text-[10px] text-muted">{turnClock(entryTime(h), timezone, stationLocale)}</span>
        </div>
      ))}
    </>
  );

  // Horizontal variant of historyList for the desktop bottom shelf — tapes lined
  // up on a shelf (fixed-width cards, right-ruled) that scroll sideways.
  const historyShelf = (
    <>
      {history.length === 0 && (
        <div className="p-4 font-mono text-[11px] text-muted">nothing on the shelf yet</div>
      )}
      {history.map((h, i) => (
        <div
          key={`${h.t ?? i}-${h.title ?? i}`}
          className="flex w-[210px] flex-none items-center gap-3 border-r border-soft-border px-4 py-3 last:border-r-0"
        >
          <span className="size-2 flex-none rounded-full border-2 border-[var(--muted)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-bold">{h.title ?? '?'}</div>
            {h.artist && <div className="truncate text-[11px] text-muted">{h.artist}</div>}
          </div>
          <span className="flex-none font-mono text-[10px] text-muted">{turnClock(entryTime(h), timezone, stationLocale)}</span>
        </div>
      ))}
    </>
  );

  const onAirQuote = (extra?: string) =>
    voice && (
      <div className={cn('flex flex-col gap-2 border border-ink bg-bg px-4 py-3.5', extra)}>
        <span className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
          <span className="size-[7px] rounded-full bg-[var(--accent)]" />
          on air — {djName}
        </span>
        <span className="text-[14px] leading-relaxed italic">“{voice.text}”</span>
      </div>
    );

  return (
    <div ref={rootRef} className="absolute inset-0 flex flex-col overflow-hidden bg-bg font-sans text-ink">
      {/* masthead */}
      <div className="flex flex-none items-center justify-between gap-x-6 border-b border-ink px-5 py-3 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn('h-2.5 w-2.5 flex-none rounded-full', offline ? 'bg-[var(--muted)]' : 'bg-[var(--accent)]')} />
          <span className="flex-none text-[15px] font-extrabold tracking-[0.12em]">{stationName.toUpperCase()}</span>
          <span className="hidden border-l border-soft-border pl-3 font-mono text-[10px] tracking-[0.2em] text-muted uppercase sm:inline">
            SW-90 · portable deck
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden items-center gap-3 font-mono text-[11px] tracking-[0.16em] uppercase md:flex">
            {showName && <span className="max-w-[20vw] truncate">▸ {showName}</span>}
            <span className="text-[var(--accent)]">with {djName}</span>
            <span className="max-w-[22vw] truncate border-l border-soft-border pl-3 text-muted">
              {contextLine(context) || (offline ? 'off air' : 'on air')}
            </span>
          </div>
          <ThemeSwitcher />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* ============ desktop: two-column console over a full-width rewound shelf ============ */}
        <div className="hidden min-h-0 flex-1 grid-cols-[1fr_288px] grid-rows-[1fr_auto] gap-7 p-7 lg:grid">
          {/* center — the deck */}
          <section className="flex min-h-0 flex-col gap-4">
            <div className="flex min-h-0 flex-1 flex-col border border-ink bg-[var(--field)]">
              {/* brand strip */}
              <div className="flex flex-none items-center justify-between border-b border-soft-border px-5 py-3">
                <span className="min-w-0 truncate font-mono text-[10px] font-bold tracking-[0.22em] uppercase">
                  {stationName} · Side A{showName ? ` — ${showName}` : ''}
                </span>
                <span className="flex-none font-mono text-[10px] tracking-[0.16em] text-muted uppercase">TYPE II · Dolby NR ●</span>
              </div>

              {/* cassette hero */}
              <div className={cn(styles.hero, 'flex min-h-0 flex-1 items-center justify-center p-5')}>
                <div className={cn(styles.cassette, 'relative flex aspect-[512/320] flex-col border border-ink bg-bg shadow-[inset_0_0_0_8px_var(--field),inset_0_0_40px_rgba(0,0,0,0.06)]')}>
                  <span className="absolute top-4 left-4 size-[7px] rounded-full border border-muted" aria-hidden="true" />
                  <span className="absolute top-4 right-4 size-[7px] rounded-full border border-muted" aria-hidden="true" />
                  <span className="absolute bottom-4 left-4 size-[7px] rounded-full border border-muted" aria-hidden="true" />
                  <span className="absolute right-4 bottom-4 size-[7px] rounded-full border border-muted" aria-hidden="true" />

                  {/* paper label */}
                  <div className="relative mx-[8%] mt-[8%] mb-[3%] flex-none border border-ink bg-bg">
                    <div className="absolute inset-y-0 left-0 w-2 bg-[var(--accent)]" aria-hidden="true" />
                    <div className="flex items-baseline justify-between gap-3 py-2 pr-3.5 pl-5">
                      <div className="min-w-0">
                        <div className="truncate font-display text-[clamp(15px,2vw,24px)] leading-tight font-bold italic">
                          {title}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                          {[artist, nowPlaying?.year].filter(Boolean).join(' · ') || 'live stream'}
                        </div>
                      </div>
                      <span className="flex-none border border-ink px-2 font-mono text-[12px] font-bold">A</span>
                    </div>
                  </div>

                  <TapeWindow
                    playing={playing}
                    hubClass="size-[46px]"
                    dotClass="size-[18px]"
                    className="mx-[8%] mb-[6%] flex-1 px-[7%]"
                  />
                </div>
              </div>

              {/* transport + counter + volume */}
              <div className="flex flex-none flex-col gap-2.5 px-5 pb-5">
                <div className="flex items-stretch gap-2.5">
                  <div className="flex flex-none flex-col justify-center gap-0.5 border border-ink bg-bg px-3 py-2">
                    <span className="font-mono text-[8px] tracking-[0.2em] text-muted uppercase">counter</span>
                    <span className="font-mono text-[20px] font-bold tracking-[0.08em] tabular-nums">{fmtTime(elapsed)}</span>
                  </div>
                  <div className="flex flex-1 gap-2">
                    <div className="relative flex w-16 flex-none items-end justify-center overflow-hidden border border-ink bg-ink pb-1.5">
                      <span className="absolute top-1.5 left-1.5 font-mono text-[7px] tracking-[0.16em] text-bg">VU</span>
                      <span className={cn('h-8 w-0.5 bg-[var(--accent)]', styles.vu, playing && styles.playing)} />
                    </div>
                    {playKey('flex-[1.6] text-[16px]')}
                    {stopKey('flex-1 text-[15px]')}
                    {muteKey('flex-1 text-[11px]')}
                    {likeKey('flex-1 text-[16px]')}
                  </div>
                </div>
                {/* volume — the deck's output fader (keyboard ↑/↓ also work) */}
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[8px] font-bold tracking-[0.2em] text-muted uppercase">vol</span>
                  <button type="button" aria-label="Volume down" onClick={() => adjustVolume(-0.05)}
                    className="v3-focus cursor-pointer border-0 bg-transparent px-1 font-mono text-[13px] text-muted hover:text-ink">−</button>
                  <div
                    ref={volRef}
                    role="slider"
                    aria-label="Volume"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(volume * 100)}
                    tabIndex={0}
                    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setVolFromPointer(e.clientX); }}
                    onPointerMove={e => { if (e.buttons) setVolFromPointer(e.clientX); }}
                    onKeyDown={e => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); adjustVolume(0.05); }
                      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); adjustVolume(-0.05); }
                    }}
                    className="v3-focus relative h-1.5 flex-1 cursor-pointer touch-none bg-soft-border"
                  >
                    <div className={cn('pointer-events-none absolute inset-y-0 left-0 bg-[var(--muted)]', styles.volFill)} />
                  </div>
                  <button type="button" aria-label="Volume up" onClick={() => adjustVolume(0.05)}
                    className="v3-focus cursor-pointer border-0 bg-transparent px-1 font-mono text-[13px] text-muted hover:text-ink">+</button>
                  <span className="w-7 text-right font-mono text-[10px] tabular-nums">{Math.round(volume * 100)}</span>
                </div>
              </div>
            </div>

            {/* meta strip */}
            {(meta.facts.length > 0 || meta.moods.length > 0) && !offline && (
              <div className="flex flex-none items-center justify-between gap-3 border border-ink bg-[var(--field)] px-4 py-2.5">
                <span className="min-w-0 truncate font-mono text-[11px] tracking-[0.14em] uppercase">{meta.facts.join(' · ')}</span>
                {meta.moods.length > 0 && (
                  <span className="flex-none font-mono text-[11px] tracking-[0.14em] text-[var(--accent)] uppercase">↳ {meta.moods.join(' · ')}</span>
                )}
              </div>
            )}

            {/* on air */}
            {voice && (
              <div className="flex flex-none items-baseline gap-4 border border-ink bg-bg px-4 py-3">
                <span className="flex-none font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">● on air — {djName}</span>
                <span className="line-clamp-2 text-[14px] leading-snug italic">“{voice.text}”</span>
              </div>
            )}
          </section>

          {/* right — up next + request */}
          <section className="flex min-h-0 flex-col gap-4">
            <div className="flex min-h-0 flex-1 flex-col border border-ink bg-[var(--field)]">
              <div className="flex-none border-b border-soft-border px-3.5 py-3 font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Next on the stack</div>
              <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
                {upNext[0]?.title ? (
                  <div className="flex flex-none flex-col gap-2.5 overflow-hidden border border-ink bg-bg p-3.5">
                    <div className="-mx-3.5 -mt-3.5 mb-1 h-[5px] bg-[var(--accent)]" />
                    <MiniHubs />
                    <div>
                      <div className="font-mono text-[9px] tracking-[0.2em] text-[var(--accent)] uppercase">up next</div>
                      <div className="mt-1 truncate text-[15px] font-bold">{upNext[0].title}</div>
                      {upNext[0].artist && <div className="truncate text-[12px] text-muted">{upNext[0].artist}</div>}
                    </div>
                  </div>
                ) : (
                  <div className="border border-soft-border bg-bg p-3.5 font-mono text-[11px] text-muted">
                    stack empty — {djName} decides at the wire
                  </div>
                )}
                {upNext.slice(1, 4).map((t, i) => (
                  <div key={`${t.title ?? i}-${i}`} className="flex flex-none items-center gap-3 border border-soft-border bg-bg px-3.5 py-2.5">
                    <span className="font-mono text-[9px] tracking-[0.18em] text-muted">THEN</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-bold">{t.title ?? '—'}</div>
                      {t.artist && <div className="truncate text-[11px] text-muted">{t.artist}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col border border-ink bg-bg">
              <div className="flex-none border-b border-soft-border px-3.5 py-3 font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Side B — request slip</div>
              <div className="flex min-h-0 flex-1 flex-col p-4">{requestForm(reqDeckRef)}</div>
            </div>
          </section>

          {/* bottom — recently rewound, a full-width shelf of tapes */}
          <section className="col-span-2 flex min-h-0 flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Recently rewound</div>
              <div className="flex items-center gap-3 font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                <span>{history.length} rewound</span>
                {listenerCount != null && <span className="font-bold text-[var(--accent)]">{listenerCount} listening</span>}
              </div>
            </div>
            <ScrollArea className="border border-ink bg-[var(--field)]">
              <div className="flex w-max">{historyShelf}</div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </section>
        </div>

        {/* ===================== mobile: single screen + tab bar ===================== */}
        <div className="flex min-h-0 flex-1 flex-col lg:hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'deck' && (
              <div className="flex h-full flex-col gap-3.5 p-4">
                <div className="relative flex h-[190px] flex-none flex-col border border-ink bg-[var(--field)]">
                  <div className="flex flex-none items-center justify-between border-b border-soft-border px-3.5 py-2">
                    <span className="min-w-0 truncate font-mono text-[9px] font-bold tracking-[0.18em] uppercase">Side A{showName ? ` · ${showName}` : ''}</span>
                    <span className="flex-none font-mono text-[8px] tracking-[0.14em] text-muted uppercase">TYPE II</span>
                  </div>
                  <TapeWindow
                    playing={playing}
                    hubClass="size-[34px]"
                    dotClass="size-[13px]"
                    className="m-3 flex-1 px-[7%]"
                  />
                </div>

                <div className="flex-none">
                  <div className="truncate font-display text-[26px] leading-tight font-bold italic">{title}</div>
                  <div className="mt-1 truncate font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
                    {[artist, ...meta.facts].filter(Boolean).join(' · ') || 'live stream'}
                  </div>
                </div>

                <div className="flex flex-none items-center gap-3 font-mono text-[11px]">
                  <span className="font-bold tabular-nums">{fmtTime(elapsed)}</span>
                  <div className="relative h-1 flex-1 bg-soft-border">
                    <div className={cn('absolute inset-y-0 left-0 bg-[var(--accent)]', ratio == null ? 'w-full opacity-40' : styles.progFill)} />
                  </div>
                  <span className="text-muted tabular-nums">{nowPlaying?.duration ? fmtTime(nowPlaying.duration) : 'live'}</span>
                </div>

                <div className="flex h-14 flex-none gap-2">
                  {playKey('flex-[2] text-[18px]')}
                  {stopKey('flex-1 text-[16px]')}
                  {muteKey('flex-1 text-[12px]')}
                  {likeKey('flex-1 text-[18px]')}
                </div>

                {upNext[0]?.title && (
                  <div className="flex flex-none items-center gap-3 border border-ink bg-[var(--field)] px-3.5 py-3">
                    <MiniHubs />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[8px] tracking-[0.2em] text-[var(--accent)] uppercase">up next</div>
                      <div className="truncate text-[14px] font-bold">{upNext[0].title}</div>
                      {upNext[0].artist && <div className="truncate text-[11px] text-muted">{upNext[0].artist}</div>}
                    </div>
                  </div>
                )}

                {onAirQuote('min-h-0 flex-1')}
              </div>
            )}

            {tab === 'rewound' && (
              <div className="flex flex-col p-4">
                <div className="mb-3 font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Recently rewound</div>
                <div className="flex flex-col border border-ink bg-[var(--field)]">{historyList}</div>
              </div>
            )}

            {tab === 'stack' && (
              <div className="flex flex-col gap-3 p-4">
                <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Next on the stack</div>
                {upNext.length === 0 && (
                  <div className="border border-soft-border bg-[var(--field)] p-3.5 font-mono text-[11px] text-muted">
                    stack empty — {djName} decides at the wire
                  </div>
                )}
                {upNext.map((t, i) => (
                  <div key={`${t.title ?? i}-${i}`} className="flex items-center gap-3 border border-soft-border bg-[var(--field)] px-3.5 py-3">
                    <span className="font-mono text-[9px] tracking-[0.18em] text-[var(--accent)]">{i === 0 ? 'NOW NEXT' : 'THEN'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-bold">{t.title ?? '—'}</div>
                      {t.artist && <div className="truncate text-[11px] text-muted">{t.artist}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'slip' && (
              <div className="flex h-full flex-col p-4">
                <div className="mb-3 font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Side B — request slip</div>
                <div className="flex min-h-0 flex-1 flex-col border border-ink bg-bg p-4">{requestForm(reqSlipRef)}</div>
              </div>
            )}
          </div>

          {/* tab bar */}
          <div className="flex h-14 flex-none border-t border-ink font-mono text-[9px] tracking-[0.12em] uppercase">
            {MOBILE_TABS.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-pressed={tab === t.id}
                className={cn(
                  'v3-focus flex flex-1 cursor-pointer items-center justify-center border-r border-soft-border last:border-r-0',
                  tab === t.id ? 'font-bold text-[var(--accent)]' : 'text-muted',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* tune-in gate — the deck sits with the door open; one tap loads the tape
          and the reels spin up. */}
      {showOverlay && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 grid w-full cursor-pointer place-items-center border-0 bg-[var(--bg)]/95 p-6"
        >
          <span className="grid w-full max-w-[380px] justify-items-stretch gap-4">
            <span className="flex flex-col border border-ink bg-[var(--field)]">
              <span className="flex items-center justify-between border-b border-soft-border px-4 py-2.5">
                <span className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">{stationName} · Side A</span>
                <span className="font-mono text-[9px] tracking-[0.14em] text-muted uppercase">TYPE II</span>
              </span>
              <TapeWindow playing={false} hubClass="size-[40px]" dotClass="size-[15px]" className="m-4 h-[150px] px-[8%]" />
            </span>
            <span className="text-center font-mono text-[11px] font-bold tracking-[0.22em] text-ink uppercase">
              ▶ load the tape · tune in
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
