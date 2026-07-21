'use client';

// TTY — the station as a live process. Panes and a status line, everything
// tails: NOW PLAYING, BOOTH (tail -f), UP NEXT, LAST, and a :req prompt.
// Utilitarian · dense · alive. Design ref: Skins Canvas 1e. Replaces the old
// bare "terminal" readout (the registry aliases terminal → tty).

import { useEffect, useRef, useState } from 'react';
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
import { fmtTime, normalizeStationLocale } from '@/lib/format';
import { useStationClient } from '@/lib/stationClient';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  boothLines,
  contextLine,
  entryTime,
  listenerCountOf,
  progressRatio,
  stationIdentity,
  trackMeta,
  turnClock,
} from '../shared';
import { useRequestSlip, useTrackLike, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';

const PROGRESS_CELLS = 16;
const VOL_CELLS = 8;

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <div className="truncate text-[10px] tracking-[0.22em] text-muted uppercase select-none">
      ── {children} ──────────────────
    </div>
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

  const adjustVolume = useVolumeNudge();
  const like = useTrackLike();

  // :req prompt + :log depth toggle.
  const [reqOpen, setReqOpen] = useState(false);
  const [logDeep, setLogDeep] = useState(false);
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
    },
    { disabled: showTuneIn || reqOpen },
  );

  // The gate's contract is "press any key": while it's up, a printable key
  // (or Enter) tunes in. Deliberately NOT literally any key — Tab keeps
  // focus traversal (keyboard users must still be able to leave the gate),
  // and F-keys/Escape/arrows stay with the browser. A press another shortcut
  // map already claimed (the shell's s/t cycling calls preventDefault) is
  // ceded to it, and this handler preventDefaults its own accepts, so one
  // keypress never both tunes in and cycles.
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

  return (
    <div className="absolute inset-0 overflow-hidden p-4 font-mono text-[13px] leading-relaxed text-ink sm:p-7">
      <div className="flex h-full w-full flex-col gap-3.5">

        {/* header bar — station line truncates; context is desktop-only so
            mobile stays one clean row with the theme icon pinned right */}
        <div className="flex flex-none items-center justify-between gap-x-4 border border-[var(--line)] px-4 py-2.5">
          <div className="min-w-0 truncate text-[13px] tracking-[0.1em]">
            <span className={cn(offline ? 'text-muted' : 'text-[var(--accent)]')}>●</span>{' '}
            <span className="font-bold">{stationName.toUpperCase()}</span>
            {showName ? <> ▸ {showName.toUpperCase()}</> : null}
            <span className="text-[var(--accent)]"> — WITH {djName.toUpperCase()}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden max-w-[40vw] truncate text-[12px] tracking-[0.1em] text-muted uppercase sm:inline">
              {[contextLine(context), clock ? turnClock(clock.getTime(), timezone, stationLocale) : '']
                .filter(Boolean).join(' · ')}
            </span>
            <ThemeSwitcher />
          </div>
        </div>

        {/* now playing + booth — fills most of the middle; stacked on mobile
            (now-playing auto, booth fills + scrolls), side-by-side on lg */}
        <div className="grid min-h-0 flex-[2] grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3.5 lg:grid-cols-[1fr_380px] lg:grid-rows-1">
          <section className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto border border-[var(--line)] px-5 py-5 sm:px-7">
            <Rule>NOW PLAYING</Rule>
            <div className="flex min-w-0 flex-row items-start gap-4 sm:gap-6">
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className="text-[clamp(22px,4vw,46px)] leading-[1.05] font-extrabold tracking-[0.06em] uppercase">
                  {offline ? <span className="text-muted">— OFF AIR —</span> : (nowPlaying?.title ?? 'SCANNING…')}
                </div>
                {!offline && nowPlaying?.artist && (
                  <div className="text-[15px] tracking-[0.08em] uppercase">
                    {nowPlaying.artist}
                    {(nowPlaying.album || nowPlaying.year) && (
                      <span className="text-muted">
                        {' '}— {[nowPlaying.album, nowPlaying.year].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </div>
                )}
                {!offline && (meta.facts.length > 0 || meta.moods.length > 0) && (
                  <div className="flex flex-wrap gap-2">
                    {meta.facts.map(f => (
                      <span key={f} className="border border-[var(--line)] px-2 py-0.5 text-[11px] tracking-[0.1em] uppercase">{f}</span>
                    ))}
                    {meta.moods.map(m => (
                      <span key={m} className="border border-[var(--accent)] px-2 py-0.5 text-[11px] tracking-[0.1em] text-[var(--accent)] uppercase">{m}</span>
                    ))}
                  </div>
                )}
                {!offline && (
                  <div className="mt-2 text-[14px] tracking-[0.06em]">
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
              <div className="hidden flex-none flex-col gap-1.5 sm:flex">
                <div className="grid h-[120px] w-[120px] place-items-center border border-[var(--line)] sm:h-[148px] sm:w-[148px]">
                  {coverId && !offline ? (
                    <img src={client.coverUrl(coverId)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[10px] text-muted">no art</span>
                  )}
                </div>
                <div className="text-center text-[9px] tracking-[0.14em] text-muted">cover.raw</div>
              </div>
            </div>
          </section>

          <section className="flex min-h-0 min-w-0 flex-col gap-3 border border-[var(--line)] px-5 py-4">
            <Rule>BOOTH · tail -f</Rule>
            <ScrollArea className="-mx-5 min-h-0 flex-1">
              <div className="flex flex-col gap-3 px-5">
                {booth.length === 0 && (
                  <div className="text-[12px] text-muted">▸ waiting for the booth…</div>
                )}
                {booth.map((line, i) => (
                  <div key={`${line.t ?? i}-${i}`} className="text-[12px] leading-relaxed break-words">
                    <span className="text-muted">{turnClock(line.t, timezone, stationLocale)}</span>{' '}
                    {line.kind === 'voice' ? (
                      <>
                        <span className="font-bold text-[var(--accent)]">{djName.toUpperCase()} ●</span>{' '}
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
          </section>
        </div>

        {/* up next + last — last fills + scrolls; stacked on mobile,
            side-by-side from sm */}
        <div className="grid min-h-0 flex-none grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3.5 sm:flex-[1] sm:grid-cols-2 sm:grid-rows-1">
          <section className="flex min-h-0 min-w-0 flex-col gap-2.5 border border-[var(--line)] px-5 py-4">
            <Rule>UP NEXT</Rule>
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
          </section>
          <section className="hidden min-h-0 min-w-0 flex-col gap-2 border border-[var(--line)] px-5 py-4 sm:flex">
            <Rule>LAST</Rule>
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
          </section>
        </div>

        {/* :req prompt (in place of the status line while open) */}
        {reqOpen ? (
          <div className="flex flex-none items-baseline gap-3 border border-[var(--accent)] bg-[var(--field)] px-4 py-2.5 text-[12px]">
            <span className="font-bold text-[var(--accent)] select-none">:req ▸</span>
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
                  placeholder="artist, song, or a vibe… [enter] send · [esc] cancel"
                  className="v3-focus min-w-0 flex-1 border-0 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-muted"
                />
                <span className={cn('text-muted select-none', slip.sending && 'text-[var(--accent)]')}>
                  {slip.sending ? 'sending…' : '▊'}
                </span>
              </>
            )}
          </div>
        ) : (
          /* status line */
          <div className="flex flex-none flex-wrap items-baseline gap-x-5 gap-y-1 border border-[var(--line)] bg-[var(--field)] px-4 py-2.5 text-[12px] tracking-[0.08em]">
            <button
              type="button"
              onClick={handleTune}
              className={cn(
                'v3-focus cursor-pointer border-0 bg-transparent p-0 font-bold uppercase',
                offline ? 'text-muted' : tunedIn ? 'text-[var(--accent)]' : 'text-ink hover:text-[var(--accent)]',
              )}
            >
              {offline ? 'OFF AIR' : tunedIn ? (status === 'playing' ? 'TUNED ●' : 'TUNING…') : '▶ TUNE IN'}
            </button>
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              className={cn(
                'v3-focus cursor-pointer border-0 bg-transparent p-0 uppercase',
                muted ? 'font-bold text-[var(--accent)]' : 'text-muted hover:text-ink',
              )}
            >
              {muted ? 'MUTED' : 'MUTE'}
            </button>
            {like.available && (
              <button
                type="button"
                onClick={() => void like.like()}
                disabled={like.pending || like.liked}
                aria-pressed={like.liked}
                aria-label={like.liked ? 'Liked' : 'Like this track'}
                className={cn(
                  'v3-focus border-0 bg-transparent p-0 uppercase',
                  like.liked ? 'font-bold text-[var(--accent)]' : 'cursor-pointer text-muted hover:text-ink',
                  like.pending && 'opacity-60',
                )}
              >
                {like.liked ? '[♥ LIKED]' : '[♥ LIKE]'}{like.count > 0 ? ` ${like.count}` : ''}
              </button>
            )}
            {signal.latencyMs != null && tunedIn && (
              <span className="hidden text-muted uppercase sm:inline">SIG {signal.latencyMs} MS · {signal.quality}</span>
            )}
            {listenerCount != null && (
              <span className="hidden text-muted uppercase sm:inline">{listenerCount} LISTENING</span>
            )}
            <button
              type="button"
              onClick={() => setReqOpen(true)}
              className="v3-focus cursor-pointer border-0 bg-transparent p-0 font-bold text-[var(--accent)] uppercase"
            >
              :req SEND A REQUEST
            </button>
            <button
              type="button"
              onClick={() => setLogDeep(d => !d)}
              className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted uppercase hover:text-ink"
            >
              :log {logDeep ? 'SHORT LOG' : 'FULL LOG'}
            </button>
            {/* volume floats to the right end of the status line */}
            <span className="ml-auto inline-flex items-baseline gap-1.5">
              <button type="button" aria-label="Volume down" onClick={() => adjustVolume(-0.125)}
                className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">−</button>
              <span aria-label={`Volume ${Math.round(volume * 100)}%`}>
                VOL <span className="text-ink">{'█'.repeat(volFilled)}</span>
                <span className="text-muted">{'░'.repeat(VOL_CELLS - volFilled)}</span>{' '}
                {Math.round(volume * 100)}
              </span>
              <button type="button" aria-label="Volume up" onClick={() => adjustVolume(0.125)}
                className="v3-focus cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-ink">+</button>
            </span>
          </div>
        )}
      </div>

      {/* boot-log gate — halts at "press any key". The tap/keypress is the
          browser's audio-unblock gesture. */}
      {showOverlay && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 block w-full cursor-pointer bg-[var(--bg)] p-8 text-left font-mono text-[13px] leading-loose text-ink sm:p-14"
        >
          <span className="grid gap-1">
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
