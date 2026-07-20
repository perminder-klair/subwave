'use client';

// Volt — "digital display meets newsprint". A single broadsheet column on flat
// off-white paper: masthead ticker, a now-playing deck matching the reference
// art (cover, Doto title, mono meta row with accent mood tags, robot-glyph DJ
// line with a blinking cursor), a hairline bento of station stats, and an
// inline "Dear DJ" request slip. One electric accent, film grain, Doto
// dot-matrix headlines. Everything reads the core contexts; the shell owns the
// <audio> element. Styles are co-located in Volt.module.css — globals.css is
// never touched.

import { useRef } from 'react';
import styles from './Volt.module.css';
import { doto } from './fonts';
import ThemeSwitcher from '@/components/ThemeSwitcher';
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
import { useRequestSlip, useTrackLike, useVolumeNudge } from '../sharedHooks';
import type { SkinProps } from '../types';

const INDEX_CODE = 'VL-014';

/** Big numbers stay legible in the stat blocks — Doto 900 gets wide fast. */
function compactNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The little booth robot from the reference art — square eyes + antenna, no
 *  radius, currentColor so it inherits the ink. */
function RobotMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={cn(styles.robot, 'mt-0.5')}
      aria-hidden="true"
    >
      <path d="M8 1.6V3.5" stroke="currentColor" strokeWidth="1" />
      <rect x="7.1" y="0.4" width="1.8" height="1.8" fill="currentColor" />
      <rect x="2.5" y="3.5" width="11" height="9" stroke="currentColor" strokeWidth="1" />
      <rect x="5" y="6.4" width="2" height="2" fill="currentColor" />
      <rect x="9" y="6.4" width="2" height="2" fill="currentColor" />
      <path d="M5.6 10.4H10.4" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** 1px hairline progress bar. Solid accent fill scaled by the elapsed ratio;
 *  a dashed idle rule when the duration is unknown (annotate metadata carries
 *  none) — no fake fill. */
function ProgressBar({ elapsed, duration }: { elapsed: number; duration: number | undefined }) {
  const ratio = progressRatio(elapsed, duration);
  const fillRef = useRef<HTMLDivElement | null>(null);
  useDynamicStyle(fillRef, { transform: `scaleX(${ratio ?? 0})` });
  return (
    <div className={styles.progress}>
      {ratio == null ? (
        <div className={styles.progressIdle} aria-hidden="true" />
      ) : (
        <div ref={fillRef} className={styles.progressFill} aria-hidden="true" />
      )}
    </div>
  );
}

export default function VoltSkin(_props: SkinProps) {
  const client = useStationClient();
  const {
    nowPlaying, context, dj, activeShow, listeners, llmTokens, state, session,
    trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume } = usePlayerActions();
  const { showTuneIn, showOverlay, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount = listenerCountOf(listeners);
  const { stationName, djName, showName } = stationIdentity(dj, activeShow, context);
  const meta = trackMeta(nowPlaying);
  const booth = boothLines(session.messages, 6);
  const voice = lastVoiceLine(session.messages);
  const upNext = state.upcoming?.[0];
  const history = (state.history ?? []).slice(0, 6);
  const ctxLine = contextLine(context);
  const live = !offline;
  const playing = tunedIn && status === 'playing' && !offline;

  const adjustVolume = useVolumeNudge();
  const like = useTrackLike();
  const reqRef = useRef<HTMLInputElement | null>(null);
  const slip = useRequestSlip({
    sent: 'Request received — the DJ is on it.',
    refused: 'Request refused.',
    failed: 'Network error — request not sent.',
  });

  useKeyboardShortcuts({
    space: handleTune,
    k: handleTune,
    arrowup: () => adjustVolume(0.05),
    arrowdown: () => adjustVolume(-0.05),
    m: toggleMute,
    r: () => reqRef.current?.focus(),
  });

  const digits = showTuneIn || offline ? '--:--' : fmtTime(elapsed);
  const showProgress = !showTuneIn && !offline;

  // Ticker — the show/DJ/context strapline, doubled so the marquee wraps
  // seamlessly (the second copy is aria-hidden).
  const tickerText =
    (offline
      ? `Off air · ${stationName} · the stream will be back`
      : [
          showName ? `${showName} · with ${djName}` : `With ${djName}`,
          ctxLine,
          stationName,
        ]
          .filter(Boolean)
          .join('  ·  ')
    ).toUpperCase() + '  ·  ';

  const title = nowPlaying?.title ?? (offline ? 'Off air' : 'Scanning…');

  return (
    <div className={cn(doto.variable, styles.volt)}>
      <div className={styles.grain} aria-hidden="true" />

      <div className={styles.scroll}>
        <div className={styles.column}>
          {/* ── masthead ─────────────────────────────────────── */}
          <header className="flex items-center justify-between gap-3 pb-2">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(styles.statusDot, !live && styles.statusOff)}
                aria-hidden="true"
              />
              <span className={styles.wordmark}>
                SUB<span className={styles.accent}>/</span>WAVE
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className={styles.eyebrow}>{INDEX_CODE}</span>
              <ThemeSwitcher />
            </div>
          </header>

          <div className={styles.ticker}>
            <div key={tickerText} className={styles.tickerTrack}>
              <span className={styles.tickerText}>{tickerText}</span>
              <span className={styles.tickerText} aria-hidden="true">{tickerText}</span>
            </div>
          </div>

          {/* ── now-playing deck ─────────────────────────────── */}
          <section className={cn(styles.card, 'mt-[1px] px-4 pt-11 pb-4')}>
            <span className={styles.cornerTag}>Now Playing</span>
            <span className={styles.indexCode}>
              {offline ? 'OFF AIR' : playing ? 'ON AIR' : 'LIVE'}
            </span>

            <div className={cn(styles.eyebrow, 'mb-3 flex items-center gap-2')}>
              <span>NOW PLAYING — {digits}</span>
              {listenerCount != null && <span className={styles.accent}>⊙ {listenerCount} LISTENING</span>}
            </div>

            <div className="flex gap-4">
              {nowPlaying?.subsonic_id && !offline ? (
                <img
                  src={client.coverUrl(nowPlaying.subsonic_id)}
                  alt=""
                  className={cn(styles.cover, 'h-20 w-20 flex-none sm:h-24 sm:w-24')}
                />
              ) : (
                <div className={cn(styles.coverEmpty, 'h-20 w-20 flex-none sm:h-24 sm:w-24')}>ART</div>
              )}

              <div className="min-w-0 flex-1">
                <h1 className={cn(styles.doto, styles.title)}>{title}</h1>

                {(nowPlaying?.artist || nowPlaying?.album || nowPlaying?.year) && (
                  <div className={cn(styles.byline, 'mt-1.5')}>
                    {nowPlaying?.artist && (
                      <span className={styles.bylineArtist}>{nowPlaying.artist}</span>
                    )}
                    {nowPlaying?.album && <> · {nowPlaying.album}</>}
                    {nowPlaying?.year && <> · {nowPlaying.year}</>}
                  </div>
                )}

                {(meta.facts.length > 0 || meta.moods.length > 0) && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    {meta.facts.length > 0 && (
                      <span className={styles.facts}>{meta.facts.join(' · ')}</span>
                    )}
                    {meta.moods.length > 0 && (
                      <span className={styles.moods}>
                        ↳ {meta.moods.map(m => m.toUpperCase()).join(' · ')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-4">
              <ProgressBar elapsed={elapsed} duration={showProgress ? nowPlaying?.duration : undefined} />
            </div>

            {voice?.text && (
              <div className="mt-3.5 flex items-start gap-2.5">
                <RobotMark />
                <p className={styles.djLine}>
                  {voice.text}
                  <span className={styles.cursor} aria-hidden="true" />
                </p>
              </div>
            )}

            <hr className={cn(styles.rule, 'mt-4')} />

            {/* transport */}
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleTune}
                disabled={offline}
                aria-label={tunedIn ? 'Tune out' : 'Tune in'}
                className={cn(
                  styles.pill,
                  styles.focus,
                  tunedIn ? styles.pillGhost : styles.pillPrimary,
                )}
              >
                {offline ? 'OFF AIR' : tunedIn ? '■ TUNE OUT' : '▶ TUNE IN'}
              </button>

              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={muted}
                className={cn(styles.pill, styles.focus, styles.pillGhost, muted && styles.pillActive)}
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
                  className={cn(styles.pill, styles.focus, styles.pillGhost, like.liked && styles.pillActive)}
                >
                  {like.liked ? '♥ LIKED' : '♡ LIKE'}
                  {like.count > 0 ? ` ${like.count}` : ''}
                </button>
              )}

              <div className="ml-auto flex min-w-[130px] flex-1 items-center gap-2 sm:w-40 sm:flex-none">
                <span className={styles.label}>VOL</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(volume * 100)}
                  onChange={e => setVolume(Number(e.target.value) / 100)}
                  aria-label="Volume"
                  className={styles.range}
                />
                <span className="w-6 text-right text-[10px] tabular-nums">{Math.round(volume * 100)}</span>
              </div>
            </div>
          </section>

          {/* ── bento: station stats ─────────────────────────── */}
          <div className={cn(styles.bento, 'mt-[1px]')}>
            <div className={styles.cell}>
              <span className={styles.label}>Listeners</span>
              <span className={cn(styles.statNum, styles.accent)}>
                {listenerCount != null ? listenerCount : '—'}
              </span>
            </div>

            <div className={styles.cell}>
              <span className={styles.label}>Signal</span>
              <span className={styles.statNum}>
                {signal.latencyMs != null && tunedIn ? signal.latencyMs : '—'}
                <span className="ml-1 text-[11px] tracking-[0.16em]">MS</span>
              </span>
              {signal.quality && (
                <span className={cn(styles.eyebrow, 'uppercase')}>{String(signal.quality)}</span>
              )}
            </div>

            <div className={styles.cell}>
              <span className={styles.label}>AI Tokens</span>
              <span className={styles.statNum}>{llmTokens != null ? compactNum(llmTokens) : '—'}</span>
            </div>

            <div className={styles.cell}>
              <span className={styles.label}>Up Next</span>
              {upNext?.title ? (
                <div className="min-w-0">
                  <div className={cn(styles.feedRow, 'truncate font-bold')}>{upNext.title}</div>
                  {upNext.artist && (
                    <div className={cn(styles.feedRow, styles.feedRowMuted, 'truncate')}>{upNext.artist}</div>
                  )}
                </div>
              ) : (
                <span className={cn(styles.feedRow, styles.feedRowMuted)}>—</span>
              )}
            </div>

            {/* booth feed */}
            <div className={cn(styles.cell, styles.cellWide)}>
              <span className={styles.label}>Booth Feed</span>
              {booth.length === 0 ? (
                <span className={cn(styles.feedRow, styles.feedRowMuted)}>waiting for the booth…</span>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {booth.map((line, i) => (
                    <div
                      key={`${line.t ?? i}-${i}`}
                      className={cn(styles.feedRow, line.kind !== 'voice' && styles.feedRowMuted)}
                    >
                      <span className={cn(styles.eyebrow, 'mr-1.5')}>
                        {turnClock(line.t, timezone, stationLocale)}
                      </span>
                      {line.kind === 'voice' ? (
                        <>
                          <span className={cn(styles.accent, 'font-bold')}>{djName.toUpperCase()} ▸ </span>
                          {line.text}
                        </>
                      ) : (
                        line.text
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* recently played */}
            <div className={cn(styles.cell, styles.cellWide)}>
              <span className={styles.label}>Recently Played</span>
              {history.length === 0 ? (
                <span className={cn(styles.feedRow, styles.feedRowMuted)}>nothing yet…</span>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {history.map((h, i) => (
                    <div key={`${entryTime(h) ?? i}-${h.title ?? i}`} className={styles.histRow}>
                      <span>{String(i + 1).padStart(2, '0')}</span>
                      <span className={styles.clip}>
                        {h.title ?? '?'}
                        {h.artist ? ` — ${h.artist}` : ''}
                      </span>
                      <span>{turnClock(entryTime(h), timezone, stationLocale)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── request slip ─────────────────────────────────── */}
          <div className="mt-3 flex flex-col gap-1.5">
            <span className={styles.label}>Dear DJ —</span>
            {slip.ack ? (
              <div className="flex items-center justify-between gap-3">
                <p className={cn(styles.feedRow, 'italic')}>{slip.ack}</p>
                <button type="button" onClick={slip.reset} className={cn(styles.sendBtn, styles.focus)}>
                  NEW ↻
                </button>
              </div>
            ) : (
              <form
                className={styles.field}
                onSubmit={e => {
                  e.preventDefault();
                  void slip.send();
                }}
              >
                <span className={styles.fieldGlyph} aria-hidden="true">⌕</span>
                <input
                  ref={reqRef}
                  value={slip.text}
                  onChange={e => slip.setText(e.target.value)}
                  placeholder="request a track, an artist, a vibe…"
                  aria-label="Request a track"
                  className={styles.fieldInput}
                />
                <button
                  type="submit"
                  disabled={slip.sending || !slip.text.trim()}
                  className={cn(styles.sendBtn, styles.focus)}
                >
                  {slip.sending ? '…' : 'SEND ↗'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* ── first-paint tune-in gate (audio-unblock gesture) ── */}
      {showOverlay && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          aria-label="Tune in"
          className={cn(styles.gate, styles.focus)}
        >
          <span className={styles.eyebrow}>{stationName} · LIVE</span>
          <span className={styles.gateTitle}>
            TUNE<span className={styles.accent}>/</span>IN
          </span>
          <span className={cn(styles.pill, styles.pillPrimary)}>
            ▶ PRESS TO LISTEN
            <span className={styles.cursor} aria-hidden="true" />
          </span>
          {showName && <span className={styles.eyebrow}>{showName}</span>}
        </button>
      )}
    </div>
  );
}
