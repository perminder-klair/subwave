'use client';

// Subamp — a compact modular player: deck, booth and log stacked like it's
// 1998. Compact · nostalgic · busy. Design ref: Skins Canvas 2a.
//
// The tune-in gate is inline, not an overlay: the deck loads un-tuned with a
// flat analyzer, --:-- digits and a marquee scrolling PRESS ▶ TO TUNE IN;
// only ▶ is lit accent. One click starts the stream and the analyzer jumps.
// Double-click a titlebar to roll its window up.

import { useRef, useState, type ReactNode } from 'react';
import styles from './Subamp.module.css';
import Analyzer from './Analyzer';
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
import { fmtTime, normalizeStationLocale } from '@/lib/format';
import { useStationClient } from '@/lib/stationClient';
import {
  boothLines,
  contextLine,
  entryTime,
  listenerCountOf,
  trackMeta,
  turnClock,
} from '../shared';
import type { SkinProps } from '../types';
import type { RequestResult } from '@/lib/types';

function Grip() {
  return (
    <span
      className="h-1.5 min-w-4 flex-1 bg-[repeating-linear-gradient(90deg,var(--soft-border)_0_2px,transparent_2px_5px)]"
      aria-hidden="true"
    />
  );
}

/** A Subamp window: dotted-grip titlebar, faux buttons, roll-up on
 *  double-click (or the ▁ button). */
function Window({ title, children }: { title: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-soft-border bg-bg">
      <div
        onDoubleClick={() => setOpen(o => !o)}
        className="flex items-center gap-2.5 border-b border-soft-border bg-[var(--field)] px-2.5 py-1 select-none"
      >
        <Grip />
        <span className="truncate text-[9px] font-bold tracking-[0.24em] uppercase">{title}</span>
        <Grip />
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-label={open ? 'Roll window up' : 'Roll window down'}
          className="v3-focus cursor-pointer border border-soft-border bg-transparent px-1 text-[9px] leading-tight text-muted hover:text-ink"
        >
          {open ? '▁' : '▆'}
        </button>
        <span className="border border-soft-border px-1 text-[9px] leading-tight text-muted opacity-60" aria-hidden="true">✕</span>
      </div>
      {open && children}
    </div>
  );
}

export default function SubampSkin(_props: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { audioRef, tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume, submitRequest } = usePlayerActions();
  const { showTuneIn, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const clock = useClock();
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const stationName = (typeof dj?.station === 'string' && dj.station) || 'SUB/WAVE';
  const djName =
    activeShow?.persona?.name || (typeof dj?.name === 'string' ? dj.name : '') || 'the DJ';
  const showName = activeShow?.name || context?.time?.show || '';
  const meta = trackMeta(nowPlaying);
  const booth = boothLines(session.messages, 3);
  const upNext = state.upcoming?.[0];
  const history = (state.history ?? []).slice(0, 3).reverse(); // oldest first
  const playing = tunedIn && status === 'playing' && !offline;

  const adjustVolume = (delta: number) =>
    setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100)));

  // Request line (station log window).
  const [reqText, setReqText] = useState('');
  const [reqAck, setReqAck] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const reqInputRef = useRef<HTMLInputElement | null>(null);
  const sendRequest = async () => {
    const text = reqText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res: RequestResult = await submitRequest(text, '');
      setReqAck(res.success ? (res.ack || 'request received — the DJ is on it.') : (res.message || 'request refused.'));
      if (res.success) setReqText('');
    } catch {
      setReqAck('network error — request not sent.');
    } finally {
      setSending(false);
    }
  };

  useKeyboardShortcuts({
    space: handleTune,
    k: handleTune,
    arrowup: () => adjustVolume(0.05),
    arrowdown: () => adjustVolume(-0.05),
    m: toggleMute,
    r: () => reqInputRef.current?.focus(),
  });

  // Marquee copy — keyed so a track change restarts the scroll from the left.
  const marqueeText = offline
    ? `OFF AIR ▪ ${stationName} ▪ THE STREAM WILL BE BACK ▪▸ `
    : showTuneIn
      ? `PRESS ▶ TO TUNE IN ▪ ${stationName} ▪ ONE LIVE STREAM ▪▸ `
      : [
          [nowPlaying?.title, nowPlaying?.artist].filter(Boolean).join(' — '),
          [nowPlaying?.album, nowPlaying?.year].filter(Boolean).join(' · '),
          stationName,
          showName ? `${showName} WITH ${djName}` : `WITH ${djName}`,
        ].filter(Boolean).join(' ▪ ').toUpperCase() + ' ▪▸ ';

  const digits = showTuneIn || offline ? '--:--' : fmtTime(elapsed);

  return (
    <div className="absolute inset-0 overflow-y-auto font-mono text-ink">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_70%_at_50%_42%,color-mix(in_oklab,var(--accent)_5%,transparent),transparent)]"
        aria-hidden="true"
      />

      {/* corner readouts */}
      <div className="absolute top-7 left-9 hidden text-[10px] tracking-[0.24em] text-muted uppercase lg:block">
        {stationName} — {showName ? `${showName} with ${djName}` : `with ${djName}`}
      </div>
      <div className="absolute top-6 right-4 z-10 flex items-center gap-3 lg:top-7 lg:right-9">
        <span className="hidden text-[10px] tracking-[0.24em] text-muted uppercase lg:inline">
          {[clock ? turnClock(clock.getTime(), timezone, stationLocale) : '', contextLine(context)]
            .filter(Boolean).join(' · ')}
        </span>
        <ThemeSwitcher />
      </div>
      <div className="absolute bottom-7 left-9 hidden text-[10px] tracking-[0.18em] text-muted uppercase lg:block">
        {offline
          ? 'off air'
          : tunedIn
            ? ['tuned', signal.latencyMs != null ? `sig ${signal.quality} · ${signal.latencyMs} ms` : ''].filter(Boolean).join(' ▪ ')
            : 'standing by'}
      </div>
      <div className="absolute right-9 bottom-7 hidden text-[10px] tracking-[0.18em] text-muted uppercase lg:block">
        double-click a titlebar to roll it up
      </div>

      <div className="relative mx-auto flex min-h-full w-full max-w-[580px] flex-col justify-center gap-2 px-3 py-14">
        {/* ── deck ─────────────────────────────────────────── */}
        <Window title={<>SUBAMP ▪ LIVE BROADCAST DECK</>}>
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex items-stretch gap-3.5">
              <div className="flex flex-col justify-center gap-1">
                <div className="text-[clamp(28px,5vw,40px)] leading-none font-extrabold tracking-[0.06em]">{digits}</div>
                <div className="text-[10px] tracking-[0.14em] text-muted">
                  {nowPlaying?.duration && !showTuneIn && !offline ? `/ ${fmtTime(nowPlaying.duration)} · ` : ''}LIVE ONLY
                </div>
              </div>
              <div className="h-16 min-w-0 flex-1 border border-soft-border px-2 py-1.5">
                <Analyzer audioRef={audioRef} active={playing} />
              </div>
              <div className="hidden h-16 w-16 flex-none self-center border border-soft-border sm:block">
                {nowPlaying?.subsonic_id && !offline ? (
                  <img src={client.coverUrl(nowPlaying.subsonic_id)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-[8px] text-muted">art</div>
                )}
              </div>
            </div>

            {/* marquee plate */}
            <div className="overflow-hidden border border-soft-border bg-[var(--field)] px-0 py-1.5">
              <div key={marqueeText} className={styles.marqueeTrack}>
                <span className="px-2.5 text-[12px] tracking-[0.12em]">{marqueeText}</span>
                <span className="px-2.5 text-[12px] tracking-[0.12em]" aria-hidden="true">{marqueeText}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {meta.facts.map(f => (
                <span key={f} className="border border-soft-border px-1.5 py-0.5 text-[10px] tracking-[0.1em]">{f}</span>
              ))}
              {meta.moods.map(m => (
                <span key={m} className="border border-[var(--accent)] px-1.5 py-0.5 text-[10px] tracking-[0.1em] text-[var(--accent)] uppercase">{m}</span>
              ))}
              <span className="ml-auto flex items-center gap-1.5 text-[10px] font-bold tracking-[0.18em] text-[var(--accent)]">
                <span className={cn('h-2 w-2 rounded-full', offline ? 'bg-[var(--muted)]' : 'bg-[var(--accent)]')} />
                {offline ? 'DOWN' : 'LIVE'}
              </span>
              <span className="text-[10px] tracking-[0.14em] text-muted">
                STEREO{signal.latencyMs != null && tunedIn ? ` · ${signal.latencyMs} MS` : ''}
              </span>
            </div>

            {/* transport */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { if (showTuneIn) tuneInFromOverlay(); else if (!tunedIn) handleTune(); }}
                aria-label="Tune in"
                className={cn(
                  'v3-focus grid h-[34px] w-11 cursor-pointer place-items-center border text-[13px]',
                  tunedIn
                    ? 'border-soft-border text-muted'
                    : 'border-[var(--accent)] bg-[var(--accent)] text-bg',
                )}
              >
                ▶
              </button>
              <button
                type="button"
                onClick={() => { if (tunedIn) handleTune(); }}
                aria-label="Tune out"
                className={cn(
                  'v3-focus grid h-[34px] w-11 place-items-center border border-soft-border text-[11px]',
                  tunedIn ? 'cursor-pointer text-ink hover:bg-[var(--overlay)]' : 'cursor-default text-muted',
                )}
              >
                ■
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={muted}
                className={cn(
                  'v3-focus grid h-[34px] w-11 cursor-pointer place-items-center border text-[9px] font-bold tracking-[0.1em]',
                  muted ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-soft-border hover:bg-[var(--overlay)]',
                )}
              >
                MUTE
              </button>
              <div className="ml-2 flex min-w-[120px] flex-1 items-center gap-2">
                <span className="text-[9px] font-bold tracking-[0.16em] text-muted">VOL</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(volume * 100)}
                  onChange={e => setVolume(Number(e.target.value) / 100)}
                  aria-label="Volume"
                  className={styles.range}
                />
                <span className="w-6 text-right text-[10px]">{Math.round(volume * 100)}</span>
              </div>
              <button
                type="button"
                onClick={() => reqInputRef.current?.focus()}
                className="v3-focus grid h-[34px] w-11 cursor-pointer place-items-center border border-[var(--accent)] text-[9px] font-bold tracking-[0.1em] text-[var(--accent)] hover:bg-[var(--overlay)]"
              >
                REQ
              </button>
            </div>
          </div>
        </Window>

        {/* ── booth ────────────────────────────────────────── */}
        <Window title={<>BOOTH FEED ▪ {djName.toUpperCase()}</>}>
          <div className="flex flex-col gap-2 px-4 py-3">
            {booth.length === 0 && (
              <div className="text-[11px] text-muted">waiting for the booth…</div>
            )}
            {booth.map((line, i) => (
              <div key={`${line.t ?? i}-${i}`} className="text-[12px] leading-relaxed break-words">
                {line.kind === 'voice' ? (
                  <>
                    <span className="text-muted">{turnClock(line.t, timezone, stationLocale)}</span>{' '}
                    <span className="font-bold text-[var(--accent)]">{djName.toUpperCase()} ●</span>{' '}
                    “{line.text}”
                  </>
                ) : (
                  <span className="text-[11px] text-muted">
                    {turnClock(line.t, timezone, stationLocale)} {line.kind === 'dj' ? 'dj' : 'sys'} ▸ {line.text}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Window>

        {/* ── station log ──────────────────────────────────── */}
        <Window
          title={<>STATION LOG{listenerCount != null ? ` ▪ ${listenerCount} LISTENING` : ''}</>}
        >
          <div className="flex flex-col gap-1.5 px-4 py-2.5">
            {history.map((h, i) => (
              <div key={`${h.t ?? i}-${h.title ?? i}`} className="flex gap-2.5 text-[11px] tracking-[0.06em] text-muted uppercase">
                <span>{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">
                  {h.title ?? '?'}{h.artist ? ` — ${h.artist}` : ''}
                </span>
                <span>{turnClock(entryTime(h), timezone, stationLocale)}</span>
              </div>
            ))}
            <div className="-mx-2 flex gap-2.5 bg-[var(--field)] px-2 py-0.5 text-[11px] font-bold tracking-[0.06em] text-[var(--accent)] uppercase">
              <span>{history.length + 1}.</span>
              <span className="min-w-0 flex-1 truncate">
                ▶ {offline ? '— off air —' : (nowPlaying?.title ?? 'scanning…')}
                {!offline && nowPlaying?.artist ? ` — ${nowPlaying.artist}` : ''}
              </span>
              <span>{fmtTime(elapsed)}</span>
            </div>
            {upNext?.title && (
              <div className="flex gap-2.5 text-[11px] tracking-[0.06em] text-muted uppercase">
                <span>{history.length + 2}.</span>
                <span className="min-w-0 flex-1 truncate">
                  {upNext.title}{upNext.artist ? ` — ${upNext.artist}` : ''}
                </span>
                <span>queued</span>
              </div>
            )}

            {/* request line */}
            <form
              className="mt-1 flex items-baseline gap-2.5 border-t border-soft-border pt-2"
              onSubmit={e => { e.preventDefault(); void sendRequest(); }}
            >
              <span className="flex-none text-[10px] tracking-[0.14em] text-muted select-none">DEAR DJ —</span>
              {reqAck ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-[11px] italic">{reqAck}</span>
                  <button
                    type="button"
                    onClick={() => setReqAck(null)}
                    className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-[10px] font-bold tracking-[0.14em] text-muted uppercase hover:text-ink"
                  >
                    new
                  </button>
                </>
              ) : (
                <>
                  <input
                    ref={reqInputRef}
                    value={reqText}
                    onChange={e => setReqText(e.target.value)}
                    placeholder="something with a 303 in it…"
                    className="v3-focus min-w-0 flex-1 border-0 border-b border-soft-border bg-transparent pb-0.5 font-mono text-[11px] text-ink italic outline-none placeholder:text-muted"
                  />
                  <button
                    type="submit"
                    disabled={sending || !reqText.trim()}
                    className={cn(
                      'v3-focus border-0 bg-transparent p-0 text-[10px] font-bold tracking-[0.14em] uppercase',
                      sending || !reqText.trim()
                        ? 'cursor-default text-muted opacity-60'
                        : 'cursor-pointer text-[var(--accent)] hover:opacity-80',
                    )}
                  >
                    {sending ? '…' : 'SEND ↗'}
                  </button>
                </>
              )}
            </form>
          </div>
        </Window>
      </div>
    </div>
  );
}
