'use client';

// Private-station gates (#478), mounted once in the shell so every skin gets
// them for free (same deal as the toaster — skins never implement these).
//
// PrivateStationScreen replaces the whole player when the operator flips
// privacy.privatePlayer: a minimal card instead of the skin, so the public
// pages stop advertising the station. UI-level only — the stream password
// below is the actual security boundary.
//
// StreamAuthOverlay fronts the player when privacy.listenerAuth is on and no
// valid token is stored: one password prompt, validated against the same
// POST /listener-auth endpoint Icecast itself calls on every listener
// connect, then remembered in localStorage. usePlayer appends the stored
// token to the stream URL as ?auth= (browsers can't do basic auth on
// <audio>). A stale token (password rotated) fails the mount-time check and
// re-prompts.

import { useEffect, useState, type FormEvent } from 'react';
import { useStationOrigin } from '@/lib/stationOrigin';
import {
  checkStreamAuth,
  clearStreamAuthToken,
  getStreamAuthToken,
  setStreamAuthToken,
} from '@/lib/streamAuth';
import { usePlayerFeed } from './PlayerCore';

export function PrivateStationScreen() {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg p-6 text-ink">
      <div className="max-w-sm border border-ink p-6 text-center">
        <div className="text-[11px] tracking-[0.2em] text-muted uppercase">off the air for you</div>
        <div className="mt-2 text-xl font-extrabold tracking-[-0.02em]">
          This station is private.
        </div>
        <p className="mt-3 text-sm text-muted">
          The operator has turned off the public player. If this is your
          station, sign in to the console.
        </p>
        <a
          href="/admin"
          className="mt-5 inline-block border border-ink px-4 py-2 text-sm font-bold hover:bg-ink hover:text-bg"
        >
          Admin sign-in
        </a>
      </div>
    </div>
  );
}

type AuthPhase = 'checking' | 'prompt' | 'ok';

export function StreamAuthOverlay() {
  const { state } = usePlayerFeed();
  const { apiUrl } = useStationOrigin();
  const authRequired = state.privacy?.listenerAuth === true;

  const [phase, setPhase] = useState<AuthPhase>('checking');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Validate any stored token once auth flips on (first poll, or live when
  // the operator enables it). An invalid token means the password rotated —
  // drop it and prompt again.
  useEffect(() => {
    if (!authRequired) return;
    let cancelled = false;
    const stored = getStreamAuthToken();
    if (!stored) {
      setPhase('prompt');
      return;
    }
    checkStreamAuth(apiUrl, stored).then(ok => {
      if (cancelled) return;
      if (ok) {
        setPhase('ok');
      } else {
        clearStreamAuthToken();
        setPhase('prompt');
      }
    });
    return () => { cancelled = true; };
  }, [authRequired, apiUrl]);

  if (!authRequired || phase !== 'prompt') return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pass = input.trim();
    if (!pass || busy) return;
    setBusy(true);
    setError('');
    const ok = await checkStreamAuth(apiUrl, pass);
    setBusy(false);
    if (ok) {
      setStreamAuthToken(pass);
      setPhase('ok');
    } else {
      setError('That password was not accepted.');
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-bg/80 p-6 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-sm border border-ink bg-bg p-6 text-ink">
        <div className="text-[11px] tracking-[0.2em] text-muted uppercase">members only</div>
        <div className="mt-2 text-xl font-extrabold tracking-[-0.02em]">
          This station needs a password.
        </div>
        <p className="mt-3 text-sm text-muted">
          Ask the operator for the listener password to tune in.
        </p>
        <input
          type="password"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="listener password"
          autoComplete="current-password"
          className="mt-4 w-full border border-ink bg-bg px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-vermilion"
        />
        {error && <div className="mt-2 text-sm text-vermilion">{error}</div>}
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
