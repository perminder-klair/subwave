// The private-station gate (#478), the app's half of web/components/player/
// StationGate.tsx. /state says which locks are on; this decides whether the
// passwords already on the device open them, and otherwise asks. Every check
// goes through the fail-CLOSED POST /station-auth — never /listener-auth,
// which fails open when stream auth is off.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerStatus } from '@/hooks/usePlayer';
import type { StationApi } from '@/lib/api';
import {
  stationLockRequired,
  verifyStoredPasswords,
  type StationAuthResult,
  type StationPrivacy,
} from '@/lib/station-password';

/** 'open' = no lock; 'checking' = verifying a saved password; 'prompt' = ask. */
export type GatePhase = 'open' | 'checking' | 'prompt' | 'ok';

export interface StationGate {
  phase: GatePhase;
  /** privatePlayer is on: the gate stands in for the whole player rather than
   *  sitting over it, and the face stays hidden until the password is in. */
  solid: boolean;
  unlock: (password: string) => Promise<StationAuthResult>;
}

// A tuned-in listener stuck reconnecting on a stream-password station may be
// holding a rotated password. Wait this long before asking the controller,
// and never ask more often than RECHECK_MIN_GAP_MS: /station-auth allows 20
// attempts per 15 minutes per IP, and a household shares one.
const STUCK_RECHECK_MS = 15_000;
const RECHECK_MIN_GAP_MS = 120_000;

export function useStationGate({
  api,
  privacy,
  stationPassword,
  loginPassword,
  rememberStationPassword,
  forgetStationPassword,
  tunedIn,
  status,
  stop,
}: {
  api: StationApi | null;
  privacy: StationPrivacy | null | undefined;
  stationPassword: string | null;
  loginPassword: string | null;
  rememberStationPassword: (password: string) => Promise<void>;
  forgetStationPassword: () => Promise<void>;
  tunedIn: boolean;
  status: PlayerStatus;
  stop: () => void;
}): StationGate {
  const required = stationLockRequired(privacy);
  const solid = privacy?.privatePlayer === true;
  const listenerAuth = privacy?.listenerAuth === true;
  const [phase, setPhase] = useState<GatePhase>(required ? 'checking' : 'open');

  // Read through refs so saving or forgetting a password does not re-run the
  // verification that caused it.
  const passwordsRef = useRef({ stationPassword, loginPassword });
  useEffect(() => {
    passwordsRef.current = { stationPassword, loginPassword };
  }, [stationPassword, loginPassword]);
  const storeRef = useRef({ rememberStationPassword, forgetStationPassword });
  useEffect(() => {
    storeRef.current = { rememberStationPassword, forgetStationPassword };
  }, [rememberStationPassword, forgetStationPassword]);
  const lastCheckRef = useRef(0);
  // A check answers for the station it was asked about. A late answer after a
  // station switch must not save or forget anything under the new station.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  // Once per station visit, and again whenever a lock turns on.
  useEffect(() => {
    if (!required || !api) {
      setPhase('open');
      return;
    }
    let alive = true;
    setPhase('checking');
    lastCheckRef.current = Date.now();
    void verifyStoredPasswords({
      stored: passwordsRef.current.stationPassword,
      login: passwordsRef.current.loginPassword,
      check: (pw) => api.checkStationAuth(pw),
    }).then(async (verdict) => {
      if (!alive) return;
      if (verdict.save) await storeRef.current.rememberStationPassword(verdict.save);
      else if (verdict.clearStored) await storeRef.current.forgetStationPassword();
      if (alive) setPhase(verdict.phase);
    });
    return () => {
      alive = false;
    };
  }, [required, api]);

  // Locked out while tuned in (a lock switched on, or the password rotated):
  // the audio stops with the face, as the web player's does.
  useEffect(() => {
    if (phase === 'prompt' && tunedIn) stop();
  }, [phase, tunedIn, stop]);

  // Icecast rejects a stale password silently, as far as the player can tell:
  // it just keeps reconnecting. Ask the controller whether that is why.
  useEffect(() => {
    if (!listenerAuth || phase !== 'ok' || !tunedIn || status !== 'connecting' || !api) return;
    let alive = true;
    const timer = setTimeout(() => {
      const password = passwordsRef.current.stationPassword;
      if (!password || Date.now() - lastCheckRef.current < RECHECK_MIN_GAP_MS) return;
      lastCheckRef.current = Date.now();
      void api.checkStationAuth(password).then(async (result) => {
        if (result !== 'denied' || apiRef.current !== api) return;
        await storeRef.current.forgetStationPassword();
        if (alive) setPhase('prompt');
      });
    }, STUCK_RECHECK_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [listenerAuth, phase, tunedIn, status, api]);

  const unlock = useCallback(
    async (password: string): Promise<StationAuthResult> => {
      if (!api) return 'unavailable';
      lastCheckRef.current = Date.now();
      const result = await api.checkStationAuth(password);
      if (apiRef.current !== api) return 'unavailable';
      if (result === 'ok') {
        await storeRef.current.rememberStationPassword(password);
        setPhase('ok');
      }
      return result;
    },
    [api],
  );

  return { phase, solid, unlock };
}
