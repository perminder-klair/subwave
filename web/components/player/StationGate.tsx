'use client';

// privatePlayer replaces the UI; listenerAuth overlays it and adds the stored token to the stream
// URL. Validate with fail-closed /station-auth; /listener-auth can fail open. Only the controller's
// own answers count (lib/stationAuth.ts): a stored token is forgotten on its refusal alone, and a
// typed one is saved on its pass alone. A stream that keeps refusing the stored token asks again
// (lib/stuckPasswordCheck.ts).

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useStationOrigin } from '@/lib/stationOrigin';
import {
  SAVED_REJECTED_COPY,
  answerForStored,
  clearStationAuthToken,
  createStationAuthClient,
  getStationAuthToken,
  setStationAuthToken,
  stationAuthFailureCopy,
  storedPasswordVerdict,
  type StationAuthCheck,
  type StationAuthClient,
} from '@/lib/stationAuth';
import { stuckConnecting, watchStuckPassword } from '@/lib/stuckPasswordCheck';
import { usePlayerActions, usePlayerAudio, usePlayerFeed } from './PlayerCore';

type AuthPhase = 'checking' | 'prompt' | 'ok';

// Is a stored token still good? Exported so the shell can decide whether to
// render the player at all before this component mounts.
export function useStationAuth(): {
  required: boolean;
  phase: AuthPhase;
  /** The prompt is up because the stored token was refused, not because there was none: the prompt
   *  says so, until the listener tries a password. */
  savedRejected: boolean;
  unlock: (pw: string) => Promise<StationAuthCheck>;
} {
  const { state } = usePlayerFeed();
  const { tunedIn, status } = usePlayerAudio();
  const { stop } = usePlayerActions();
  const { apiUrl } = useStationOrigin();
  const required =
    state.privacy?.privatePlayer === true || state.privacy?.listenerAuth === true;
  const listenerAuth = state.privacy?.listenerAuth === true;

  const [phase, setPhase] = useState<AuthPhase>('checking');
  const [savedRejected, setSavedRejected] = useState(false);
  const client = useMemo(() => createStationAuthClient(apiUrl), [apiUrl]);
  // A check answers for the station it was asked about, so one that lands after a switch is dropped.
  // A showcase switch remounts this hook rather than changing `client`, and the token is one key for
  // every station, so leaving counts: a late answer must not save or forget anything under the next.
  const clientRef = useRef<StationAuthClient | null>(client);
  useEffect(() => {
    clientRef.current = client;
    return () => { clientRef.current = null; };
  }, [client]);

  useEffect(() => {
    if (!required) return;
    let cancelled = false;
    setSavedRejected(false);
    const stored = getStationAuthToken();
    if (!stored) {
      setPhase('prompt');
      return;
    }
    client.check(stored).then(({ result }) => {
      if (cancelled) return;
      const verdict = storedPasswordVerdict(answerForStored(result, stored, getStationAuthToken()));
      if (verdict.clearStored) clearStationAuthToken();
      setSavedRejected(verdict.clearStored);
      setPhase(verdict.phase);
    });
    return () => { cancelled = true; };
  }, [required, client]);

  // Locked out while tuned in (a lock switched on, or the password rotated): the audio stops with
  // the prompt, as the app's does. Otherwise a stream password station's <audio> stays mounted
  // under the prompt and the player reconnects forever.
  useEffect(() => {
    if (required && phase === 'prompt' && tunedIn) stop();
  }, [required, phase, tunedIn, stop]);

  // Icecast rejects a stale password silently, as far as the player can tell: it just keeps
  // reconnecting. Ask the controller whether that is why, for as long as the player stays stuck
  // (watchStuckPassword). With privatePlayer alone the stream isn't gated, so nothing is asked.
  const stuck = stuckConnecting(tunedIn, status);
  useEffect(() => {
    if (!listenerAuth || phase !== 'ok' || !stuck) return;
    return watchStuckPassword({
      check: async () => {
        const password = getStationAuthToken();
        // Another tab's denial forgot it, and the stream now connects with nothing. The app's store
        // tells its gate about that; localStorage tells nobody here, so only this brings the prompt.
        if (!password) return 'denied';
        return answerForStored((await client.check(password)).result, password, getStationAuthToken());
      },
      lastCheckAt: client.lastCheckAt,
      heldUntil: client.heldUntil,
      current: () => clientRef.current === client,
      // Not held back by the cleanup: a stop while the check was out must still lead to the prompt.
      onDenied: () => {
        clearStationAuthToken();
        setSavedRejected(true);
        setPhase('prompt');
      },
    });
  }, [listenerAuth, phase, stuck, client]);

  const unlock = async (pw: string): Promise<StationAuthCheck> => {
    setSavedRejected(false);
    const check = await client.check(pw);
    if (clientRef.current !== client) return { result: 'unavailable', retryAt: 0 };
    if (check.result === 'ok') {
      setStationAuthToken(pw);
      setPhase('ok');
    }
    return check;
  };

  return { required, phase, savedRejected, unlock };
}

export function StationPasswordGate({
  phase,
  unlock,
  savedRejected,
  /** true when privatePlayer is on — the gate stands in for the whole player
   *  rather than sitting over it, so it gets an opaque backdrop. */
  solid,
}: {
  phase: AuthPhase;
  unlock: (pw: string) => Promise<StationAuthCheck>;
  savedRejected: boolean;
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
    const { result, retryAt } = await unlock(pass);
    setBusy(false);
    // This component outlives the prompt over a tuned-in face, and the next one must start empty.
    if (result === 'ok') setInput('');
    else setError(stationAuthFailureCopy(result, retryAt, Date.now()));
  };

  const notice = error || (savedRejected ? SAVED_REJECTED_COPY : '');

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
        {notice && <div role="alert" className="mt-2 text-sm text-vermilion">{notice}</div>}
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
