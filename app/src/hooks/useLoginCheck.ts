// A saved Station login the station no longer accepts (#1873). The stream
// cannot say why it will not start, so ask /api/health with the saved login,
// which only a proxy in front of the station can refuse: once per station
// visit, and again when playback is stuck reconnecting. Only a challenged 401
// counts (loginRefused); a 403, a timeout or a network error never stops the
// player. Refused, the player stops, as it does for a rejected station
// password, and stays stopped until the login is edited or a check passes.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerStatus } from '@/hooks/usePlayer';
import type { HealthResult, StationApi } from '@/lib/api';
import { loginRefused } from '@/lib/station-login';

// Sooner than useStationGate's 15 s stuck recheck: a proxy that refuses the
// login refuses /station-auth too (stationAuthResult reads its challenge as
// 'unavailable', not a wrong password), so stopping first clears the gate's
// timer and saves it a rate-limited attempt that cannot get through. A health
// check costs no rate limit, so the gap only spaces checks out across stalls.
const STUCK_RECHECK_MS = 8_000;
const RECHECK_MIN_GAP_MS = 30_000;
const PROBE_TIMEOUT_MS = 4_500;

export interface LoginCheckState {
  rejected: boolean;
  /** Ask again; only a passing check clears a rejection. */
  recheck: () => Promise<void>;
}

export function useLoginCheck({
  api,
  hasLogin,
  tunedIn,
  status,
  stop,
}: {
  api: StationApi | null;
  hasLogin: boolean;
  tunedIn: boolean;
  status: PlayerStatus;
  stop: () => void;
}): LoginCheckState {
  const [rejected, setRejected] = useState(false);
  const lastCheckRef = useRef(0);
  // An answer is for the client it was asked with. Saving a new login
  // rebuilds the client, so a late answer about the old login is dropped.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const probe = useCallback(async (a: StationApi): Promise<HealthResult> => {
    lastCheckRef.current = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      return await a.probeHealth(ctrl.signal);
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    setRejected(false);
    if (!api || !hasLogin) return;
    let alive = true;
    void probe(api).then((result) => {
      if (alive) setRejected(loginRefused(result));
    });
    return () => {
      alive = false;
    };
  }, [api, hasLogin, probe]);

  // One check per stall, never sooner than RECHECK_MIN_GAP_MS after the last.
  useEffect(() => {
    if (!api || !hasLogin || rejected || !tunedIn || status !== 'connecting') return;
    let alive = true;
    const wait = Math.max(STUCK_RECHECK_MS, lastCheckRef.current + RECHECK_MIN_GAP_MS - Date.now());
    const timer = setTimeout(() => {
      void probe(api).then((result) => {
        if (alive && apiRef.current === api && loginRefused(result)) setRejected(true);
      });
    }, wait);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, hasLogin, rejected, tunedIn, status, probe]);

  useEffect(() => {
    if (rejected && tunedIn) stop();
  }, [rejected, tunedIn, stop]);

  const recheck = useCallback(async () => {
    const a = apiRef.current;
    if (!a) return;
    const result = await probe(a);
    if (apiRef.current === a && result.ok) setRejected(false);
  }, [probe]);

  return { rejected, recheck };
}
