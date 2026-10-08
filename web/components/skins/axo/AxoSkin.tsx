'use client';

// AXO — the player drawn as a hi-fi stack at 30° isometric. The drawing is the
// interface (see AxoScene); the column beside it carries the facts a drawing
// can't, and the dashed construction lines before tune-in are the gate.
// Desktop and mobile are two trees switched by CSS rather than a JS media
// query, so SSR paints the right one first; the hidden scene's loop idles.

import { useEffect, useRef, useState } from 'react';
import styles from './Axo.module.css';
import AxoScene, { type AxoSceneProps } from './AxoScene';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import ThemeSwitcher from '@/components/ThemeSwitcher';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDynamicStyle } from '@/hooks/useDynamicStyle';
import { useElapsed } from '@/hooks/useElapsed';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/lib/cn';
import { fmtTime, normalizeStationLocale } from '@/lib/format';
import { REQUEST_NAME_MAX } from '@/lib/schemas.generated';
import {
  contextLine,
  entryTime,
  isPowered,
  lastVoiceLine,
  listenPhase,
  listenerCountOf,
  progressRatio,
  stationIdentity,
  trackMeta,
  tuningStatus,
  turnClock,
} from '../shared';
import {
  useDjOnAir,
  useRequestSlip,
  useSkinCalm,
  useTrackLike,
  useVolumeNudge,
  type RequestSlip,
} from '../sharedHooks';
import type { SkinProps } from '../types';

const OFFLINE_COPY = 'Nothing is on the stream right now. Power is disabled until the station comes back.';

/** Clip a label to the width of the window it's printed in. */
function fit(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function counterOf(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function AxoSkin(_props: SkinProps) {
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal, audioRef } = usePlayerAudio();
  const { toggleMute, setVolume } = usePlayerActions();
  const { showTuneIn, showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const ratio = progressRatio(elapsed, nowPlaying?.duration);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const meta = trackMeta(nowPlaying);
  const voice = lastVoiceLine(session.messages);
  const onMic = useDjOnAir();
  const upNext = (state.upcoming ?? []).slice(0, 2);
  const history = (state.history ?? []).slice(0, 3);
  const stationLocale = normalizeStationLocale(locale);

  const phase = listenPhase({ offline, tunedIn, status });
  const live = phase === 'live';
  const powered = isPowered(phase);
  const talk = live && onMic && !!voice;
  const calm = useSkinCalm();

  const title = offline ? '— off air —' : (nowPlaying?.title ?? 'Scanning the dial…');
  const artist = offline ? '' : (nowPlaying?.artist ?? '');
  const eyebrow = phase === 'standby'
    ? 'standby · press power to listen'
    : phase === 'connecting'
      ? 'tuning in…'
      : muted
        ? 'now playing — muted'
        : 'now playing — side a';
  const statusText = tuningStatus(phase, muted);
  const lcd = fit(
    offline
      ? 'OFF AIR · NO SIGNAL'
      : phase === 'standby'
        ? 'STANDBY · PRESS POWER'
        : phase === 'connecting'
          ? 'TUNING IN…'
          : [title, artist].filter(Boolean).join(' — ').toUpperCase(),
    26,
  );

  const adjustVolume = useVolumeNudge();
  const like = useTrackLike();

  const [reqOpen, setReqOpen] = useState(false);
  const slip = useRequestSlip({
    sent: `On tape. ${djName} will play it back.`,
    refused: 'The booth waved this one off.',
    failed: 'The tape jammed — the booth line is down. Try again in a moment.',
  });
  const closeReq = () => { setReqOpen(false); slip.reset(); };

  useKeyboardShortcuts({
    space: handleTune,
    k: handleTune,
    arrowup: () => adjustVolume(0.05),
    arrowdown: () => adjustVolume(-0.05),
    m: toggleMute,
    r: () => { if (!showTuneIn) setReqOpen(true); },
    // Only while the card is up, so Escape still reaches menus otherwise.
    escape: reqOpen ? closeReq : undefined,
  });

  const rootRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(rootRef, { '--pf': ratio ?? 0 });

  const scene: Omit<AxoSceneProps, 'variant'> = {
    phase,
    talk,
    muted,
    volume,
    ratio,
    counter: live ? counterOf(elapsed) : '--:--',
    duration: nowPlaying?.duration ? fmtTime(nowPlaying.duration) : 'LIVE',
    lcd,
    tapeLabel: fit((artist || stationName).toUpperCase(), 24),
    djName,
    bpm: typeof nowPlaying?.bpm === 'number' ? nowPlaying.bpm : null,
    calm,
    audioRef,
    like: { available: like.available, liked: like.liked, count: like.count, pending: like.pending },
    gateTap: showOverlay && !offline,
    onGateTap: tuneInFromOverlay,
    onPower: handleTune,
    onMute: toggleMute,
    onVolume: v => setVolume(v),
    onRequest: () => setReqOpen(true),
    onLike: () => void like.like(),
  };

  const progress = (size: 'lg' | 'sm') => (
    <div className={cn('flex items-center', size === 'lg' ? 'gap-3 pt-1.5' : 'gap-2.5')}>
      <span className={cn('font-mono font-bold tabular-nums', size === 'lg' ? 'text-[13px]' : 'text-[12px]')}>
        {fmtTime(elapsed)}
      </span>
      <div className="relative h-[6px] flex-1 bg-[color-mix(in_oklab,var(--ink)_14%,var(--bg))]">
        <div className={cn('absolute inset-y-0 left-0 bg-[var(--accent)]', ratio == null ? 'w-full opacity-40' : styles.progFill)} />
        {ratio != null && <div className={cn('absolute -top-[3.5px] h-[13px] w-[3px] bg-ink', styles.progHead)} />}
      </div>
      <span className={cn('font-mono text-muted tabular-nums', size === 'lg' ? 'text-[13px]' : 'text-[12px]')}>
        {nowPlaying?.duration ? fmtTime(nowPlaying.duration) : 'live'}
      </span>
    </div>
  );

  const eyebrowEl = offline ? (
    <span className="font-mono text-[10px] font-bold tracking-[0.24em] text-muted uppercase">off air</span>
  ) : (
    <span className="font-mono text-[10px] font-bold tracking-[0.24em] text-[var(--accent)] uppercase">{eyebrow}</span>
  );

  const showLine = (className: string) => (
    <span className={cn('truncate font-mono text-[10px] tracking-[0.16em] text-muted uppercase', className)}>
      {showName && <>▸ {showName} · </>}
      <span className="text-[var(--accent)]">with {djName}</span>
    </span>
  );

  const onAirTag = (
    <span className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
      <span className={cn('size-[7px] rounded-full bg-[var(--accent)]', styles.pulse)} />
      on air — {djName}
    </span>
  );

  const statusBar = (pad: string) => (
    <div className={cn('flex flex-none items-center gap-4 border-t border-ink bg-field font-mono text-[10px] tracking-[0.16em] uppercase', pad)}>
      <span className={cn('flex items-center gap-2 font-bold whitespace-nowrap', powered ? 'text-[var(--accent)]' : 'text-muted')}>
        <span
          className={cn(
            'size-2 rounded-full',
            powered ? 'bg-[var(--accent)]' : 'border border-[var(--muted)]',
          )}
        />
        {statusText}
      </span>
      {listenerCount != null && (
        <span className="flex items-center gap-1.5 text-muted sm:border-l sm:border-soft-border sm:pl-4">
          <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current" strokeWidth={2} aria-hidden="true">
            <path d="M4 14v-2a8 8 0 0 1 16 0v2" strokeLinecap="round" />
            <rect x="2.5" y="13" width="4" height="7.5" rx="1.5" />
            <rect x="17.5" y="13" width="4" height="7.5" rx="1.5" />
          </svg>
          {listenerCount}
          <span className="sr-only">listening</span>
        </span>
      )}
      {live && signal.latencyMs != null && (
        <span className="hidden whitespace-nowrap text-muted lg:inline">sig {signal.latencyMs} ms · {signal.quality}</span>
      )}
      <span className="ml-auto whitespace-nowrap text-muted">{muted ? 'muted' : `vol ${Math.round(volume * 100)}`}</span>
    </div>
  );

  return (
    <div ref={rootRef} className="absolute inset-0 overflow-hidden bg-bg font-sans text-ink">
      {/* ── Desktop ─────────────────────────────────────────────── */}
      <div className="absolute inset-0 hidden flex-col lg:flex">
        <div className="flex flex-none items-center justify-between gap-6 border-b border-ink px-8 py-3.5">
          <div className="flex min-w-0 items-baseline gap-3.5">
            <span className="font-display text-[22px] font-extrabold tracking-[0.02em]">{stationName.toUpperCase()}</span>
            <span className="font-mono text-[10px] tracking-[0.24em] whitespace-nowrap text-muted uppercase">axo-1 · hi-fi stack</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <div className="flex items-center gap-3 font-mono text-[11px] tracking-[0.16em] uppercase">
              {showName && <span className="max-w-[18vw] truncate">▸ {showName}</span>}
              <span className="whitespace-nowrap text-[var(--accent)]">with {djName}</span>
              {contextLine(context) && (
                <span className="max-w-[22vw] truncate border-l border-soft-border pl-3 text-muted">{contextLine(context)}</span>
              )}
            </div>
            <ThemeSwitcher />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[clamp(380px,32vw,460px)] flex-none flex-col gap-[22px] overflow-hidden border-r border-ink px-8 pt-8 pb-6">
            <div className="flex flex-col gap-2.5">
              {eyebrowEl}
              <div className="line-clamp-3 font-display text-[clamp(40px,4.2vw,60px)] leading-[0.95] font-extrabold tracking-[-0.01em] text-balance italic">
                {title}
              </div>
              {offline ? (
                <span className="text-[15px] leading-relaxed text-pretty text-muted">{OFFLINE_COPY}</span>
              ) : (
                <>
                  {artist && <span className="truncate font-mono text-[14px] tracking-[0.14em] uppercase">{artist}</span>}
                  {(nowPlaying?.album || nowPlaying?.year) && (
                    <span className="truncate font-mono text-[11px] tracking-[0.12em] text-muted uppercase">
                      {[nowPlaying.album, nowPlaying.year].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {(meta.facts.length > 0 || meta.moods.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {meta.facts.map(f => <Badge key={f} variant="ink" className="whitespace-nowrap">{f}</Badge>)}
                      {meta.moods.map(m => <Badge key={m} variant="accent" className="whitespace-nowrap">{m}</Badge>)}
                    </div>
                  )}
                  {progress('lg')}
                </>
              )}
            </div>

            {!offline && (
              <>
                <div className="h-px flex-none bg-soft-border" />
                {voice && (
                  <div className="flex flex-col gap-2.5">
                    {talk ? (
                      <>
                        {onAirTag}
                        <span className="line-clamp-5 font-display text-[22px] leading-[1.35] font-medium text-pretty italic">
                          “{voice.text}”
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-[10px] font-bold tracking-[0.18em] text-muted uppercase">
                          last on air · {turnClock(voice.t, timezone, stationLocale)} — {djName}
                        </span>
                        <span className="line-clamp-4 font-display text-[17px] leading-[1.45] font-medium text-pretty italic">
                          “{voice.text}”
                        </span>
                      </>
                    )}
                  </div>
                )}
                <div className="flex flex-none flex-col border border-ink">
                  <div className="border-b border-line px-3.5 py-2.5 font-mono text-[9px] font-bold tracking-[0.22em] text-muted uppercase">
                    next on the stack
                  </div>
                  {upNext.length > 0 ? (
                    upNext.map((t, i) => (
                      <div
                        key={`${t.title ?? i}-${i}`}
                        className={cn('flex items-center gap-3 px-3.5 py-2.5', i < upNext.length - 1 && 'border-b border-soft-border')}
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
                      nothing cued — {djName} picks at the run-out
                    </div>
                  )}
                </div>
              </>
            )}

            {!talk && history.length > 0 && (
              <div className="flex w-full flex-none flex-col gap-0.5">
                <span className="pb-1.5 font-mono text-[9px] font-bold tracking-[0.22em] text-muted uppercase">recently spun</span>
                {history.map((h, i) => (
                  <div
                    key={`${entryTime(h) ?? ''}-${h.title ?? i}`}
                    className="flex gap-3 border-b border-soft-border py-[5px] text-[13px] last:border-b-0"
                  >
                    <span className="pt-0.5 font-mono text-[10px] text-muted tabular-nums">
                      {turnClock(entryTime(h), timezone, stationLocale)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <b>{h.title ?? '—'}</b>
                      {h.artist && <> — {h.artist}</>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={cn('relative min-w-0 flex-1', styles.gridDesk)}>
            <span className="absolute top-5 left-6 font-mono text-[9px] tracking-[0.24em] whitespace-nowrap text-muted uppercase">
              receiver · tape · turntable — drawn at 30°
            </span>
            <div className="absolute inset-x-4 top-9 bottom-3">
              <AxoScene variant="desk" {...scene} />
            </div>
            {reqOpen && (
              <div className="absolute right-6 bottom-6 flex w-[360px] flex-col border border-ink bg-bg shadow-drawer">
                <RequestCard slip={slip} onClose={closeReq} layout="desk" />
              </div>
            )}
          </div>
        </div>

        {statusBar('px-6 py-3')}
      </div>

      {/* ── Mobile ──────────────────────────────────────────────── */}
      <div className="absolute inset-0 flex flex-col lg:hidden">
        <div className="flex flex-none flex-col gap-1 border-b border-ink px-4 pt-3 pb-2.5 landscape:py-1.5">
          <div className="flex items-center justify-between">
            <span className="font-display text-[19px] font-extrabold tracking-[0.02em]">{stationName.toUpperCase()}</span>
            <ThemeSwitcher />
          </div>
          {showLine('landscape:hidden')}
        </div>

        {/* Phones get the design's crop (receiver + tape, controls ~1.3×
            larger). A portrait tablet has the room for the whole stack, so
            the drawing takes the free height and the facts sit under it. A
            phone turned sideways puts the crop beside the facts instead,
            where stacking would shrink the drawing to a few pixels. */}
        <div className="flex min-h-0 flex-1 flex-col landscape:flex-row">
          <div
            className={cn(
              // A short phone (SE-class) trades a little drawing for the facts.
              'relative aspect-[290/372] max-h-[56dvh] w-full flex-none border-b border-ink [@media(orientation:portrait)_and_(max-height:700px)]:max-h-[48dvh]',
              'sm:portrait:aspect-auto sm:portrait:max-h-none sm:portrait:min-h-0 sm:portrait:flex-1',
              'landscape:aspect-auto landscape:max-h-none landscape:w-[52%] landscape:border-r landscape:border-b-0',
              styles.gridMob,
            )}
          >
            <div className="absolute inset-0 sm:portrait:hidden">
              <AxoScene variant="mobile" {...scene} />
            </div>
            <div className="absolute inset-x-4 inset-y-3 hidden sm:portrait:block">
              <AxoScene variant="desk" {...scene} />
            </div>
          </div>

          {/* Rows never shrink: squeezed, a clamped title collapses to
              nothing. The column clips at the bottom instead. */}
          <div className="flex min-h-0 flex-1 flex-col gap-[7px] overflow-hidden px-4 py-3 *:shrink-0 sm:portrait:flex-none sm:portrait:px-6 sm:portrait:pb-4 landscape:justify-center">
            {/* Sideways, the header drops this line to give the drawing height. */}
            {showLine('hidden landscape:block')}
            {eyebrowEl}
            <div className="line-clamp-2 font-display text-[30px] leading-[0.95] font-extrabold tracking-[-0.01em] italic [@media(orientation:portrait)_and_(max-height:700px)]:line-clamp-1">
              {title}
            </div>
            {offline ? (
              <span className="text-[14px] leading-normal text-muted">{OFFLINE_COPY}</span>
            ) : (
              <>
                {artist && (
                  <span className="truncate font-mono text-[12px] tracking-[0.14em] uppercase">
                    {artist}
                    {nowPlaying?.year && <span className="text-muted"> · {nowPlaying.year}</span>}
                  </span>
                )}
                {progress('sm')}
              </>
            )}
            {talk && voice && (
              <div className="flex flex-col gap-1 border-t border-soft-border pt-1.5">
                {onAirTag}
                <span className="line-clamp-3 font-display text-[15px] leading-[1.35] font-medium italic [@media(orientation:portrait)_and_(max-height:700px)]:line-clamp-2">
                  “{voice.text}”
                </span>
              </div>
            )}
            {!talk && !offline && upNext[0] && (
              <div className="flex items-center gap-3 border-t border-soft-border pt-2">
                <span className="font-mono text-[9px] tracking-[0.18em] text-[var(--accent)]">CUED</span>
                <div className="min-w-0 flex-1 truncate text-[13px]">
                  <b>{upNext[0].title ?? '—'}</b>
                  {upNext[0].artist && <> — {upNext[0].artist}</>}
                </div>
              </div>
            )}
          </div>
        </div>

        {statusBar('px-4 py-3 landscape:py-2')}

        {reqOpen && (
          <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col border-t border-ink bg-bg shadow-drawer">
            <RequestCard slip={slip} onClose={closeReq} layout="mobile" />
          </div>
        )}
      </div>
    </div>
  );
}

/** The REC key's card: compose, send, then the booth's answer. */
function RequestCard({
  slip,
  onClose,
  layout,
}: {
  slip: RequestSlip;
  onClose: () => void;
  layout: 'desk' | 'mobile';
}) {
  const mob = layout === 'mobile';
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Only the visible tree's card takes focus; the hidden one has no box.
    const el = inputRef.current;
    if (el && el.offsetParent !== null) el.focus();
  }, []);

  return (
    <>
      <div className={cn('flex items-center justify-between border-b border-ink', mob ? 'py-1.5 pr-0.5 pl-4' : 'px-3.5 py-2.5')}>
        <span className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.22em] uppercase">
          <span className="size-[7px] rounded-full bg-[var(--accent)]" />
          rec · ask the dj
        </span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={cn(
            'v3-focus cursor-pointer border-0 bg-transparent p-0 leading-none text-muted hover:text-ink',
            mob ? 'h-9 w-11 text-[20px]' : 'text-[18px]',
          )}
        >
          ×
        </button>
      </div>
      {slip.ack ? (
        <div className={cn('flex flex-col gap-2.5', mob ? 'px-4 pt-3.5 pb-5' : 'p-3.5')}>
          <span className="font-display text-[16px] leading-normal italic">{slip.ack}</span>
          <button
            type="button"
            onClick={slip.reset}
            className={cn(
              'v3-focus cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[10px] font-bold tracking-[0.14em] text-muted uppercase hover:text-ink',
              mob && 'min-h-11',
            )}
          >
            another
          </button>
        </div>
      ) : (
        <form
          className={cn('flex flex-col gap-2.5', mob ? 'px-4 pt-3.5 pb-5' : 'p-3.5')}
          onSubmit={e => { e.preventDefault(); void slip.send(); }}
          onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
        >
          <Input
            ref={inputRef}
            value={slip.text}
            onChange={e => slip.setText(e.target.value)}
            placeholder="a song, an artist, a feeling…"
            aria-label="Your request"
            className={mob ? 'h-11' : undefined}
          />
          <Input
            value={slip.name}
            onChange={e => slip.setName(e.target.value)}
            placeholder="your name (optional)"
            aria-label="Your name"
            maxLength={REQUEST_NAME_MAX}
            className={mob ? 'h-11' : undefined}
          />
          <div className={cn('flex gap-2 pt-1', mob ? 'flex-col' : 'justify-end')}>
            {!mob && (
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            )}
            <Button
              type="submit"
              variant="accent"
              disabled={slip.sending || !slip.text.trim()}
              className={mob ? 'h-11 w-full' : undefined}
            >
              {slip.sending ? 'Recording…' : 'Record request'}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
