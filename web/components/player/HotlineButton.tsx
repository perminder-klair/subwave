'use client';

// The Hotline in the player (docs/plans/hotline.md): a "ring the DJ" button,
// drawn by the shell over every skin while the show on air opens the line,
// and the small call sheet behind it.
//
// The Caller's stream stops for the Call (the mic would hear it, and it runs
// 22 s behind anyway) and tunes back in at the live edge when they hang up, so
// they are there to hear their track and dedication.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useStationClient } from '@/lib/stationClient';
import { startHotlineCall, type HotlineCallHandle, type HotlineCallPhase } from '@/lib/hotlineCall';
import { usePlayerActions, usePlayerAudio, usePlayerFeed } from './PlayerCore';

const NAME_KEY = 'subwave:hotline-name';
const NOTICE_KEY = 'subwave:hotline-notice-ok';

function readKey(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function writeKey(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage off: asked again next time */ }
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function HotlineButton() {
  const { state } = usePlayerFeed();
  const { tunedIn } = usePlayerAudio();
  const actions = usePlayerActions();
  const client = useStationClient();
  const line = state.hotline?.state;

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<HotlineCallPhase | 'idle'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [noticeOk, setNoticeOk] = useState(false);
  const [dj, setDj] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [capSec, setCapSec] = useState(180);
  const [elapsed, setElapsed] = useState(0);
  const handleRef = useRef<HotlineCallHandle | null>(null);
  const resumeRef = useRef(false);

  useEffect(() => {
    setName(readKey(NAME_KEY));
    setNoticeOk(readKey(NOTICE_KEY) === '1');
  }, []);

  const inCall = phase === 'connecting' || phase === 'live';
  useEffect(() => {
    if (phase !== 'live' || startedAt == null) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 1000);
    return () => clearInterval(id);
  }, [phase, startedAt]);

  // Hang up if the player unmounts mid-Call (a page leave), so the line frees.
  useEffect(() => () => handleRef.current?.hangUp(), []);

  const ring = useCallback(async () => {
    writeKey(NAME_KEY, name.trim());
    writeKey(NOTICE_KEY, '1');
    setNoticeOk(true);
    setMessage(null);
    resumeRef.current = tunedIn;
    if (tunedIn) actions.stop();
    handleRef.current = await startHotlineCall({
      apiBase: client.origin.apiUrl,
      name: name.trim(),
      onConnected: info => { setDj(info.dj); setCapSec(info.capSec); },
      onPhase: (next, detail) => {
        setPhase(next);
        if (next === 'live') { setStartedAt(Date.now()); setElapsed(0); }
        if (next === 'ended' || next === 'error') {
          handleRef.current = null;
          setStartedAt(null);
          setMessage(detail ?? (next === 'ended' ? 'Thanks for calling.' : null));
          // Back on air at the live edge, to hear what the DJ queued.
          if (resumeRef.current) {
            resumeRef.current = false;
            actions.tune();
          }
        }
      },
    });
  }, [actions, client.origin.apiUrl, name, tunedIn]);

  const hangUp = useCallback(() => handleRef.current?.hangUp(), []);

  // Nothing at all unless the station's line is open or busy (or a Call is on).
  if (line !== 'open' && line !== 'busy' && !inCall && !open) return null;

  const busy = line === 'busy' && !inCall;

  return (
    <div className="pointer-events-none fixed top-16 right-4 z-40 flex flex-col items-end gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o || inCall)}
        className={cn(
          'pointer-events-auto inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold shadow-lg',
          inCall ? 'bg-vermilion text-bg' : 'bg-ink text-bg',
        )}
      >
        <Phone className="size-4" aria-hidden />
        {inCall ? 'On the line' : busy ? 'Hotline · busy' : 'Hotline'}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Hotline"
          className="pointer-events-auto w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-surface-border bg-surface p-4 text-ink shadow-lg"
        >
          <div className="mb-1 text-sm font-semibold">Ring the DJ</div>
          {inCall ? (
            <div className="grid gap-3">
              <div className="text-sm text-muted">
                {phase === 'connecting' ? 'Ringing…' : `On the line${dj ? ` with ${dj}` : ''} · ${mmss(elapsed)} / ${mmss(capSec)}`}
              </div>
              <button
                type="button"
                onClick={hangUp}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-vermilion px-3 py-2 text-sm font-semibold text-bg"
              >
                <PhoneOff className="size-4" aria-hidden /> Hang up
              </button>
            </div>
          ) : (
            <div className="grid gap-3">
              <p className="text-xs text-muted">
                A private call with the DJ — never broadcast. Ask for a track or a dedication;
                the DJ can queue one per call.
              </p>
              {!noticeOk && (
                <p className="rounded-md border border-separator-soft p-2 text-xs text-muted">
                  Your voice is processed by OpenAI so you can talk to the DJ. Nothing is recorded.
                  Your stream pauses for the call and comes back at the end.
                </p>
              )}
              <label className="grid gap-1 text-xs">
                <span className="text-muted">Your name (optional)</span>
                <input
                  value={name}
                  maxLength={40}
                  onChange={e => setName(e.target.value)}
                  className="rounded-md border border-soft-border bg-field px-2 py-1.5 text-sm text-ink"
                />
              </label>
              {message && <p className="text-xs text-muted" role="status">{message}</p>}
              <button
                type="button"
                disabled={busy}
                onClick={() => void ring()}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-ink px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
              >
                <Phone className="size-4" aria-hidden /> {busy ? 'Line busy' : noticeOk ? 'Call' : 'Agree and call'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
