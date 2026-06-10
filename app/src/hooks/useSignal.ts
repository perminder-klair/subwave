// Native port of web/web/hooks/useSignal.ts.
//
// Times a cheap GET /health every few seconds while tuned in, surfacing a
// measured round-trip latency + a derived quality band for the signal meter.
// `performance.now()` → `Date.now()` (RN has no high-res perf timer guarantee).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppActive } from '@/hooks/useAppActive';
import type { StationApi } from '@/lib/api';
import type { PlayerStatus } from './usePlayer';

export const SCALE_MAX = 250;
const PROBE_INTERVAL_MS = 5000;
// After a few consecutive failures the link is just down — probe gently
// instead of hammering a dead origin every 5s.
const PROBE_BACKOFF_MS = 15000;
const PROBE_BACKOFF_AFTER = 3;
const PROBE_TIMEOUT_MS = 4000;
const GOOD_MS = 120;

export type SignalQuality =
  | 'offline'
  | 'idle'
  | 'acquiring'
  | 'good'
  | 'fair'
  | 'poor';

export interface Signal {
  latencyMs: number | null;
  quality: SignalQuality;
}

export interface UseSignalOptions {
  api: StationApi | null;
  tunedIn: boolean;
  status: PlayerStatus;
  offline: boolean;
}

export function useSignal({ api, tunedIn, status, offline }: UseSignalOptions): Signal {
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const appActive = useAppActive();
  const failsRef = useRef(0);

  useEffect(() => {
    if (!api || !tunedIn || offline || !appActive) {
      if (!tunedIn || offline) {
        setLatencyMs(null);
        setFailed(false);
        failsRef.current = 0;
      }
      return;
    }

    let cancelled = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    const probe = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        await api.health(ctrl.signal);
        if (cancelled) return;
        failsRef.current = 0;
        setLatencyMs(Math.round(Date.now() - t0));
        setFailed(false);
      } catch {
        if (!cancelled) {
          failsRef.current += 1;
          setLatencyMs(null);
          setFailed(true);
        }
      } finally {
        clearTimeout(timer);
      }
      if (cancelled) return;
      const delay = failsRef.current >= PROBE_BACKOFF_AFTER ? PROBE_BACKOFF_MS : PROBE_INTERVAL_MS;
      next = setTimeout(probe, delay);
    };

    probe();
    return () => {
      cancelled = true;
      if (next) clearTimeout(next);
    };
  }, [api, tunedIn, offline, appActive]);

  const quality = useMemo<SignalQuality>(() => {
    if (offline) return 'offline';
    if (!tunedIn) return 'idle';
    if (failed) return 'poor';
    if (status === 'connecting' || latencyMs == null) return 'acquiring';
    if (latencyMs < GOOD_MS) return 'good';
    if (latencyMs <= SCALE_MAX) return 'fair';
    return 'poor';
  }, [offline, tunedIn, status, failed, latencyMs]);

  return { latencyMs, quality };
}
