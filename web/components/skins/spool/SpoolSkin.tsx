'use client';

// Spool — a walkman deck; the whole station fits on one cassette.
// Pocketable · tactile · warm. Design ref: Skins Canvas 1a.
//
// The supply reel thins as the take-up reel fattens across the track's
// runtime (dynamic hub sizes off the progress ratio); both spin while
// playing. History is a stack of rewound tapes, the queue head sits on the
// stack, and requests are a Side B paper slip passed to the booth.

import { useRef, useState } from 'react';
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
import { cn } from '@/lib/cn';
import { fmtTime, normalizeStationLocale } from '@/lib/format';
import { useStationClient } from '@/lib/stationClient';
import {
  contextLine,
  lastVoiceLine,
  listenerCountOf,
  progressRatio,
  trackMeta,
  turnClock,
} from '../shared';
import type { SkinProps } from '../types';
import type { RequestResult } from '@/lib/types';

/** Two little tape hubs — the cassette signature, reused on every card. */
function MiniHubs() {
  return (
    <div className="flex gap-11" aria-hidden="true">
      <span className="h-3.5 w-3.5 rounded-full border-[3px] border-[var(--muted)]" />
      <span className="h-3.5 w-3.5 rounded-full border-[3px] border-[var(--muted)]" />
    </div>
  );
}

function Spool({ playing, fast, sizeRef }: { playing: boolean; fast?: boolean; sizeRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={sizeRef}
      className="grid place-items-center rounded-full bg-[var(--muted)]"
      aria-hidden="true"
    >
      <div
        className={cn(
          'box-border h-[42px] w-[42px] rounded-full border-[5px] border-dashed border-ink bg-bg',
          styles.hub,
          fast && styles.hubFast,
          playing && styles.spinning,
        )}
      />
    </div>
  );
}

export default function SpoolSkin(_props: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume, submitRequest } = usePlayerActions();
  const { showTuneIn, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const stationName = (typeof dj?.station === 'string' && dj.station) || 'SUB/WAVE';
  const djName =
    activeShow?.persona?.name || (typeof dj?.name === 'string' ? dj.name : '') || 'the DJ';
  const showName = activeShow?.name || context?.time?.show || '';
  const meta = trackMeta(nowPlaying);
  const ratio = progressRatio(elapsed, nowPlaying?.duration) ?? 0.5;
  const voice = lastVoiceLine(session.messages);
  const upNext = state.upcoming?.[0];
  const history = (state.history ?? []).slice(0, 3);
  const playing = tunedIn && status === 'playing' && !offline;

  // Supply reel empties into the take-up reel across the runtime.
  const leftPx = Math.round(100 - 36 * ratio);
  const rightPx = Math.round(64 + 36 * ratio);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(leftRef, { width: `${leftPx}px`, height: `${leftPx}px` });
  useDynamicStyle(rightRef, { width: `${rightPx}px`, height: `${rightPx}px` });

  const adjustVolume = (delta: number) =>
    setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100)));

  // Side B request slip.
  const [reqText, setReqText] = useState('');
  const [reqName, setReqName] = useState('');
  const [reqAck, setReqAck] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const reqInputRef = useRef<HTMLInputElement | null>(null);
  const sendRequest = async () => {
    const text = reqText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res: RequestResult = await submitRequest(text, reqName.trim());
      setReqAck(res.success ? (res.ack || 'Slip passed to the booth — the DJ has it.') : (res.message || 'The booth waved this one off.'));
      if (res.success) setReqText('');
    } catch {
      setReqAck('The booth line is down — try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  useKeyboardShortcuts(
    {
      space: handleTune,
      k: handleTune,
      arrowup: () => adjustVolume(0.05),
      arrowdown: () => adjustVolume(-0.05),
      m: toggleMute,
      r: () => reqInputRef.current?.focus(),
    },
    { disabled: showTuneIn },
  );

  return (
    <div className="absolute inset-0 flex flex-col overflow-y-auto font-sans text-ink">
      {/* masthead */}
      <div className="flex flex-none flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-soft-border px-5 py-3 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn('h-2.5 w-2.5 flex-none rounded-full', offline ? 'bg-[var(--muted)]' : 'bg-[var(--accent)]')} />
          <span className="text-[15px] font-extrabold tracking-[0.12em]">{stationName.toUpperCase()}</span>
          {showName && (
            <span className="hidden truncate font-mono text-[11px] tracking-[0.18em] uppercase sm:inline">▸ {showName}</span>
          )}
          <span className="truncate font-mono text-[11px] tracking-[0.18em] text-[var(--accent)] uppercase">with {djName}</span>
        </div>
        <div className="truncate font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
          {contextLine(context)}
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-[1280px] flex-1 grid-cols-1 gap-8 p-5 sm:p-9 lg:grid-cols-[240px_1fr_240px]">
        {/* recently rewound */}
        <div className="order-3 flex flex-col gap-3 lg:order-1">
          <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Recently rewound</div>
          {history.length === 0 && (
            <div className="font-mono text-[11px] text-muted">nothing on the shelf yet</div>
          )}
          {history.map((h, i) => (
            <div key={`${h.t ?? i}-${h.title ?? i}`} className="flex flex-col gap-1.5 border border-soft-border bg-[var(--field)] px-3.5 py-3">
              <MiniHubs />
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[13px] font-bold">{h.title ?? '?'}</span>
                <span className="flex-none font-mono text-[10px] text-muted">{turnClock(h.t, timezone, stationLocale)}</span>
              </div>
              {h.artist && <div className="truncate text-[11px] text-muted">{h.artist}</div>}
            </div>
          ))}
        </div>

        {/* the deck */}
        <div className="order-1 flex min-w-0 flex-col gap-4 lg:order-2">
          <div className="flex flex-col gap-4 border border-ink bg-[var(--field)] p-4 sm:p-5">
            {/* cassette label */}
            <div className="border border-ink bg-bg">
              <div className="h-2 bg-[var(--accent)]" />
              <div className="flex gap-5 p-4 sm:p-5">
                <div className="hidden h-[118px] w-[118px] flex-none border border-ink sm:block">
                  {nowPlaying?.subsonic_id && !offline ? (
                    <img src={client.coverUrl(nowPlaying.subsonic_id)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full w-full place-items-center font-mono text-[9px] text-muted">no art</div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono text-[10px] tracking-[0.2em] text-muted uppercase">
                      {stationName} · Side A{showName ? ` — ${showName}` : ''}
                    </span>
                    <span className="flex-none border border-ink px-1.5 font-mono text-[12px] font-bold">A</span>
                  </div>
                  <div className="truncate font-display text-[clamp(22px,3.2vw,38px)] leading-[1.05] font-bold italic">
                    {offline ? <span className="text-muted not-italic">— off air —</span> : (nowPlaying?.title ?? 'Scanning the dial…')}
                  </div>
                  {!offline && nowPlaying?.artist && (
                    <div className="truncate font-mono text-[13px] tracking-[0.14em] uppercase">{nowPlaying.artist}</div>
                  )}
                  {!offline && (nowPlaying?.album || nowPlaying?.year) && (
                    <div className="truncate font-mono text-[11px] tracking-[0.12em] text-muted uppercase">
                      {[nowPlaying.album, nowPlaying.year].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* spool window */}
            <div className="relative flex h-32 items-center justify-around bg-ink">
              <div className="absolute right-6 bottom-4 left-6 h-0.5 bg-[var(--muted)]" aria-hidden="true" />
              <Spool playing={playing} sizeRef={leftRef} />
              <Spool playing={playing} fast sizeRef={rightRef} />
              <div className="pointer-events-none absolute inset-0 bg-[var(--overlay)]" aria-hidden="true" />
            </div>

            {(meta.facts.length > 0 || meta.moods.length > 0) && !offline && (
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-[11px] tracking-[0.14em] uppercase">{meta.facts.join(' · ')}</span>
                {meta.moods.length > 0 && (
                  <span className="font-mono text-[11px] tracking-[0.14em] text-[var(--accent)] uppercase">
                    ↳ {meta.moods.join(' · ')}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* transport */}
          <div className="flex flex-wrap items-center gap-3.5">
            <div className="flex items-baseline gap-2 border border-ink bg-[var(--field)] px-4 py-2.5">
              <span className="font-mono text-[22px] font-bold">{fmtTime(elapsed)}</span>
              <span className="font-mono text-[13px] text-muted">
                {nowPlaying?.duration ? `/ ${fmtTime(nowPlaying.duration)}` : '· live'}
              </span>
            </div>
            <button
              type="button"
              onClick={handleTune}
              aria-label={tunedIn ? 'Tune out' : 'Tune in'}
              className={cn(
                'v3-focus grid h-14 w-14 cursor-pointer place-items-center border text-[20px]',
                tunedIn
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-bg'
                  : 'border-ink bg-bg hover:bg-[var(--overlay)]',
              )}
            >
              {tunedIn ? '■' : '▶'}
            </button>
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              className={cn(
                'v3-focus grid h-14 w-14 cursor-pointer place-items-center border border-ink font-mono text-[9px] font-bold tracking-[0.14em]',
                muted ? 'bg-ink text-bg' : 'bg-bg hover:bg-[var(--overlay)]',
              )}
            >
              {muted ? 'MUTED' : 'MUTE'}
            </button>
            <div className="flex h-14 items-center gap-1 border border-ink bg-[repeating-linear-gradient(90deg,var(--field)_0_6px,var(--soft-border)_6px_8px)] px-2">
              <button type="button" aria-label="Volume down" onClick={() => adjustVolume(-0.05)}
                className="v3-focus cursor-pointer border-0 bg-transparent px-1 font-mono text-[13px] text-muted hover:text-ink">−</button>
              <span className="border border-soft-border bg-bg px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.14em]">
                VOL {Math.round(volume * 100)}
              </span>
              <button type="button" aria-label="Volume up" onClick={() => adjustVolume(0.05)}
                className="v3-focus cursor-pointer border-0 bg-transparent px-1 font-mono text-[13px] text-muted hover:text-ink">+</button>
            </div>
            <div className="ml-auto font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
              {offline
                ? 'off air'
                : [
                    signal.latencyMs != null && tunedIn ? `signal ${signal.quality}` : '',
                    listenerCount != null ? `${listenerCount} ♪` : '',
                    signal.latencyMs != null && tunedIn ? `${signal.latencyMs} ms` : '',
                  ].filter(Boolean).join(' · ')}
            </div>
          </div>

          {/* booth line */}
          {voice && (
            <div className="flex items-baseline gap-3.5 border border-ink bg-bg px-4 py-3.5">
              <span className="flex-none font-mono text-[10px] font-bold tracking-[0.18em] text-[var(--accent)] uppercase">
                ● on air — {djName}
              </span>
              <span className="min-w-0 text-[15px] leading-relaxed italic">“{voice.text}”</span>
            </div>
          )}
        </div>

        {/* next + request slip */}
        <div className="order-2 flex flex-col gap-3 lg:order-3">
          <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Next on the stack</div>
          {upNext?.title ? (
            <div className="flex flex-col gap-2 overflow-hidden border border-ink bg-[var(--field)] p-3.5">
              <div className="-mx-3.5 -mt-3.5 mb-1 h-[5px] bg-[var(--accent)]" />
              <MiniHubs />
              <div className="truncate text-[14px] font-bold">{upNext.title}</div>
              {upNext.artist && <div className="truncate text-[12px] text-muted">{upNext.artist}</div>}
            </div>
          ) : (
            <div className="border border-soft-border bg-[var(--field)] p-3.5 font-mono text-[11px] text-muted">
              stack empty — {djName} decides at the wire
            </div>
          )}

          <form
            className="mt-3 flex flex-col gap-2.5 border border-ink bg-bg p-4"
            onSubmit={e => { e.preventDefault(); void sendRequest(); }}
          >
            <div className="font-mono text-[10px] font-bold tracking-[0.2em] uppercase">Side B — request slip</div>
            {reqAck ? (
              <>
                <div className="text-[13px] leading-relaxed italic">{reqAck}</div>
                <button
                  type="button"
                  onClick={() => setReqAck(null)}
                  className="v3-focus cursor-pointer self-start border-0 bg-transparent p-0 font-mono text-[11px] font-bold tracking-[0.14em] text-muted uppercase hover:text-ink"
                >
                  new slip
                </button>
              </>
            ) : (
              <>
                <div className="text-[13px] text-muted italic">Dear DJ —</div>
                <input
                  ref={reqInputRef}
                  value={reqText}
                  onChange={e => setReqText(e.target.value)}
                  placeholder="a song, an artist, a feeling…"
                  className="v3-focus w-full border-0 border-b border-soft-border bg-transparent pb-1 text-[13px] text-ink italic outline-none placeholder:text-muted"
                />
                <input
                  value={reqName}
                  onChange={e => setReqName(e.target.value)}
                  placeholder="from (optional)"
                  className="v3-focus w-full border-0 border-b border-soft-border bg-transparent pb-1 text-[13px] text-ink italic outline-none placeholder:text-muted"
                />
                <button
                  type="submit"
                  disabled={sending || !reqText.trim()}
                  className={cn(
                    'v3-focus self-start border-0 bg-transparent p-0 font-mono text-[11px] font-bold tracking-[0.14em] uppercase',
                    sending || !reqText.trim()
                      ? 'cursor-default text-muted opacity-60'
                      : 'cursor-pointer text-[var(--accent)] hover:opacity-80',
                  )}
                >
                  {sending ? 'passing…' : 'pass it to the booth ↗'}
                </button>
              </>
            )}
          </form>
        </div>
      </div>

      {/* tune-in gate — the deck sits with its door open; one tap clunks it
          shut and the spools start. */}
      {showTuneIn && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 grid w-full cursor-pointer place-items-center border-0 bg-[var(--bg)]/95 p-6"
        >
          <span className="grid w-full max-w-[420px] -rotate-2 justify-items-stretch gap-3">
            <span className="block border border-ink bg-[var(--field)] p-4">
              <span className="block border border-ink bg-bg">
                <span className="block h-2 bg-[var(--accent)]" />
                <span className="block px-4 py-3 text-left">
                  <span className="block font-mono text-[10px] tracking-[0.2em] text-muted uppercase">{stationName} · Side A</span>
                  <span className="mt-1 block font-display text-[24px] leading-tight font-bold italic">
                    {nowPlaying?.title ?? 'one live stream'}
                  </span>
                </span>
              </span>
              <span className="mt-3 flex items-center justify-around bg-ink py-5">
                <span className="grid h-16 w-16 place-items-center rounded-full bg-[var(--muted)]">
                  <span className="box-border block h-[38px] w-[38px] rounded-full border-4 border-dashed border-ink bg-bg" />
                </span>
                <span className="grid h-16 w-16 place-items-center rounded-full bg-[var(--muted)]">
                  <span className="box-border block h-[38px] w-[38px] rounded-full border-4 border-dashed border-ink bg-bg" />
                </span>
              </span>
            </span>
            <span className="text-center font-mono text-[11px] font-bold tracking-[0.22em] text-ink uppercase">
              tap to close the deck ▸ tune in
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
