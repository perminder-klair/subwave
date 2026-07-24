'use client';

// Private-station gate (#478), mounted once in the shell so every skin gets it
// for free (same deal as the toaster — skins never implement this).
//
// One prompt for both privacy locks, because they share one password:
//
//   privatePlayer  — the gate REPLACES the player. The shell doesn't mount the
//                    skin or the <audio> element at all, so a private station's
//                    public pages stop advertising it.
//   listenerAuth   — the gate OVERLAYS the player. The audio is what's locked;
//                    the stored token rides the stream URL as ?auth=.
//   both           — one prompt; unlocking reveals the UI and supplies the
//                    stream token in the same step.
//
// Validated against POST /station-auth, which fails closed. Do NOT point this
// at /listener-auth: that one fails open when stream auth is off, which would
// make a private player accept any password (see lib/stationAuth.ts).
//
// A stale token (operator rotated the password) fails the mount-time check and
// re-prompts.

import { useEffect, useState, type FormEvent } from 'react';
import { useStationOrigin } from '@/lib/stationOrigin';
import {
  checkStationAuth,
  clearStationAuthToken,
  getStationAuthToken,
  setStationAuthToken,
} from '@/lib/stationAuth';
import { usePlayerFeed } from './PlayerCore';

type AuthPhase = 'checking' | 'prompt' | 'ok';

// Is a stored token still good? Exported so the shell can decide whether to
// render the player at all before this component mounts.
export function useStationAuth(): { required: boolean; phase: AuthPhase; unlock: (pw: string) => Promise<boolean> } {
  const { state } = usePlayerFeed();
  const { apiUrl } = useStationOrigin();
  const required =
    state.privacy?.privatePlayer === true || state.privacy?.listenerAuth === true;

  const [phase, setPhase] = useState<AuthPhase>('checking');

  useEffect(() => {
    if (!required) return;
    let cancelled = false;
    const stored = getStationAuthToken();
    if (!stored) {
      setPhase('prompt');
      return;
    }
    checkStationAuth(apiUrl, stored).then(ok => {
      if (cancelled) return;
      if (ok) {
        setPhase('ok');
      } else {
        clearStationAuthToken();
        setPhase('prompt');
      }
    });
    return () => { cancelled = true; };
  }, [required, apiUrl]);

  const unlock = async (pw: string) => {
    const ok = await checkStationAuth(apiUrl, pw);
    if (ok) {
      setStationAuthToken(pw);
      setPhase('ok');
    }
    return ok;
  };

  return { required, phase, unlock };
}

export function StationPasswordGate({
  phase,
  unlock,
  /** true when privatePlayer is on — the gate stands in for the whole player
   *  rather than sitting over it, so it gets an opaque backdrop. */
  solid,
}: {
  phase: AuthPhase;
  unlock: (pw: string) => Promise<boolean>;
  solid: boolean;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (phase !== 'prompt') return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pass = input.trim();
    if (!pass || busy) return;
    setBusy(true);
    setError('');
    const ok = await unlock(pass);
    setBusy(false);
    if (!ok) setError('That password was not accepted.');
  };

  return (
    <div
      className={`absolute inset-0 z-40 flex items-center justify-center p-6 ${
        solid ? 'bg-bg' : 'bg-bg/80 backdrop-blur-sm'
      }`}
    >
      <form onSubmit={submit} className="w-full max-w-sm border border-ink bg-bg p-6 text-ink">
        <div className="text-[11px] tracking-[0.2em] text-muted uppercase">members only</div>
        <div className="mt-2 text-xl font-extrabold tracking-[-0.02em]">
          This station is private.
        </div>
        <p className="mt-3 text-sm text-muted">
          Ask the operator for the station password to tune in.
        </p>
        <input
          type="password"
          aria-label="Station password"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="station password"
          autoComplete="current-password"
          className="mt-4 w-full border border-ink bg-bg px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-vermilion"
        />
        {error && <div role="alert" className="mt-2 text-sm text-vermilion">{error}</div>}
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="mt-4 w-full border border-ink px-4 py-2 text-sm font-bold hover:bg-ink hover:text-bg disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Tune in'}
        </button>
      </form>
    </div>
  );
}
