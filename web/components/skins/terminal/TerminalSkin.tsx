'use client';

// Terminal — a deliberately minimal, text-only player face. One column of
// monospace readouts, no drawers, no canvas, no artwork: the point of this
// skin is (a) a lo-fi face for kiosks and tiny windows, and (b) proof that
// the skin contract holds for a layout that shares nothing with classic.
// Everything on screen comes from the core contexts + shared hooks; styles
// are Tailwind-only against the theme tokens (bg/ink/muted/accent), so
// operator themes restyle it like any other skin.

import { useEffect, useRef, useState } from 'react';
import {
  usePlayerActions,
  usePlayerAudio,
  usePlayerFeed,
} from '@/components/player/PlayerCore';
import { useTuneInGate } from '@/components/player/useTuneInGate';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useElapsed } from '@/hooks/useElapsed';
import { cn } from '@/lib/cn';
import { fmtClockMinute, fmtTime, normalizeStationLocale } from '@/lib/format';
import type { SkinProps } from '@/components/skins/types';
import type { RequestResult, SessionTurn } from '@/lib/types';

const VOL_CELLS = 10;

/** The most recent booth turn with speakable text — the DJ's last line. */
function lastBoothLine(messages: SessionTurn[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i];
    if (typeof t?.text === 'string' && t.text.trim() && t.role !== 'track') {
      return t.text.trim();
    }
  }
  return null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="shrink-0 text-muted select-none">{label.padEnd(8, ' ')}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

export default function TerminalSkin(_props: SkinProps) {
  const {
    nowPlaying, dj, listeners, state, session, trackStartedAt, timezone, locale,
  } = usePlayerFeed();
  const { tunedIn, status, volume, muted, offline, signal } = usePlayerAudio();
  const { toggleMute, setVolume, submitRequest } = usePlayerActions();
  const { showTuneIn, tuneInFromOverlay, handleTune } = useTuneInGate();

  const elapsed = useElapsed(trackStartedAt);
  const stationLocale = normalizeStationLocale(locale);
  const listenerCount =
    listeners == null ? null : typeof listeners === 'number' ? listeners : (listeners.current ?? null);

  const adjustVolume = (delta: number) =>
    setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100)));

  useKeyboardShortcuts({
    space: handleTune,
    k: handleTune,
    arrowup: () => adjustVolume(0.1),
    arrowdown: () => adjustVolume(-0.1),
    m: toggleMute,
  });

  // Inline request line — no drawer; the ack renders where the form was.
  const [requestText, setRequestText] = useState('');
  const [requestAck, setRequestAck] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ackTimer = useRef<number | null>(null);
  useEffect(() => () => { if (ackTimer.current != null) window.clearTimeout(ackTimer.current); }, []);
  const sendRequest = async () => {
    const text = requestText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res: RequestResult = await submitRequest(text, '');
      setRequestAck(res.success ? (res.ack || 'request received — the DJ is on it.') : (res.message || 'request refused.'));
      if (res.success) setRequestText('');
    } catch {
      setRequestAck('network error — is the controller up?');
    } finally {
      setSending(false);
      if (ackTimer.current != null) window.clearTimeout(ackTimer.current);
      ackTimer.current = window.setTimeout(() => setRequestAck(null), 8000);
    }
  };

  const stationName = typeof dj?.station === 'string' && dj.station ? dj.station : 'SUB/WAVE';
  const djName = typeof dj?.name === 'string' && dj.name ? dj.name : 'dj';
  const boothLine = lastBoothLine(session.messages);
  const volFilled = Math.round(volume * VOL_CELLS);
  const volBar = '█'.repeat(volFilled) + '░'.repeat(VOL_CELLS - volFilled);
  const statusLine = offline
    ? 'OFF AIR'
    : !tunedIn
      ? 'standing by'
      : status === 'playing'
        ? 'ON AIR — tuned in'
        : 'connecting…';
  const upNext = state.upcoming?.[0];
  const history = (state.history ?? []).slice(0, 5);

  return (
    <div className="absolute inset-0 flex justify-center overflow-y-auto font-mono text-[13px] leading-relaxed text-ink">
      <div className="flex w-full max-w-[640px] flex-col gap-4 px-4 py-6">
        <header className="border-b border-soft-border pb-2">
          <div className="text-[15px] font-bold tracking-widest uppercase">{stationName}</div>
          <div className="text-muted">terminal · one live stream · {djName} on the mic</div>
        </header>

        <section className="grid gap-1" aria-live="polite">
          <Row label="status">
            <span className={cn(offline ? 'text-muted' : 'text-[var(--accent)]')}>{statusLine}</span>
            {signal.latencyMs != null && tunedIn && !offline && (
              <span className="text-muted"> · {signal.quality} ({signal.latencyMs}ms)</span>
            )}
            {listenerCount != null && <span className="text-muted"> · {listenerCount} listening</span>}
          </Row>
          <Row label="now">
            {offline || !nowPlaying?.title ? (
              <span className="text-muted">—</span>
            ) : (
              <>
                {nowPlaying.artist ? `${nowPlaying.artist} — ` : ''}{nowPlaying.title}
                {nowPlaying.duration ? (
                  <span className="text-muted"> ({fmtTime(elapsed)} / {fmtTime(nowPlaying.duration)})</span>
                ) : null}
              </>
            )}
          </Row>
          {upNext?.title && (
            <Row label="next">
              {upNext.artist ? `${upNext.artist} — ` : ''}{upNext.title}
            </Row>
          )}
          {boothLine && (
            <Row label="booth">
              <span className="text-muted">“{boothLine}”</span>
            </Row>
          )}
        </section>

        <section className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-soft-border py-2">
          <button
            type="button"
            onClick={handleTune}
            className={cn(
              'v3-focus cursor-pointer border px-3 py-1 font-bold tracking-widest uppercase',
              tunedIn
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-ink hover:bg-[var(--overlay)]',
            )}
          >
            {tunedIn ? '■ tune out' : '▶ tune in'}
          </button>
          <span className="inline-flex items-center gap-2">
            <button type="button" onClick={() => adjustVolume(-0.1)} aria-label="Volume down"
              className="v3-focus cursor-pointer border border-soft-border px-2 hover:bg-[var(--overlay)]">−</button>
            <span className="select-none" aria-label={`Volume ${Math.round(volume * 100)}%`}>
              vol {volBar} {String(Math.round(volume * 100)).padStart(3, ' ')}%
            </span>
            <button type="button" onClick={() => adjustVolume(0.1)} aria-label="Volume up"
              className="v3-focus cursor-pointer border border-soft-border px-2 hover:bg-[var(--overlay)]">+</button>
          </span>
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={muted}
            className={cn(
              'v3-focus cursor-pointer border border-soft-border px-2 uppercase',
              muted ? 'bg-ink text-bg' : 'hover:bg-[var(--overlay)]',
            )}
          >
            {muted ? 'unmute' : 'mute'}
          </button>
        </section>

        <section className="grid gap-1">
          <div className="text-muted select-none">request a track:</div>
          {requestAck ? (
            <div className="text-[var(--accent)]" role="status">» {requestAck}</div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={e => { e.preventDefault(); void sendRequest(); }}
            >
              <span className="text-muted select-none" aria-hidden="true">&gt;</span>
              <input
                value={requestText}
                onChange={e => setRequestText(e.target.value)}
                placeholder="artist, song, or a vibe…"
                className="v3-focus min-w-0 flex-1 border-0 border-b border-soft-border bg-transparent font-mono text-ink outline-none placeholder:text-muted"
              />
              <button
                type="submit"
                disabled={sending || !requestText.trim()}
                className={cn(
                  'v3-focus border border-soft-border px-2 uppercase',
                  sending || !requestText.trim()
                    ? 'cursor-default opacity-50'
                    : 'cursor-pointer hover:bg-[var(--overlay)]',
                )}
              >
                send
              </button>
            </form>
          )}
        </section>

        {history.length > 0 && (
          <section className="grid gap-1">
            <div className="text-muted select-none">recently played:</div>
            {history.map((h, i) => (
              <div key={`${h.t ?? i}-${h.title ?? i}`} className="flex min-w-0 gap-2">
                <span className="shrink-0 text-muted">
                  {h.t ? fmtClockMinute(new Date(h.t), timezone, stationLocale) : '--:--'}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {h.artist ? `${h.artist} — ` : ''}{h.title ?? '?'}
                </span>
              </div>
            ))}
          </section>
        )}

        <footer className="mt-auto border-t border-soft-border pt-2 text-muted select-none">
          keys: space tune · ↑/↓ volume · m mute
        </footer>
      </div>

      {/* First-paint tune-in gate — the tap is the browser's audio-unblock
          gesture, rendered terminal-style over the readouts. */}
      {showTuneIn && !offline && (
        <button
          type="button"
          onClick={tuneInFromOverlay}
          className="absolute inset-0 z-40 grid cursor-pointer place-items-center bg-[var(--bg)]/90 font-mono text-ink backdrop-blur-[2px]"
        >
          <span className="grid justify-items-center gap-2">
            <span className="text-[15px] font-bold tracking-widest uppercase">{stationName}</span>
            <span className="animate-pulse text-muted">[ press space or tap to tune in ]</span>
          </span>
        </button>
      )}
    </div>
  );
}
