// Native port of web/web/hooks/useSignal.ts.
//
// Times a cheap GET /health every few seconds while tuned in, surfacing a
// measured round-trip latency + a derived quality band for the signal meter.
// `performance.now()` → `Date.now()` (RN has no high-res perf timer guarantee).

import { useEffect, useMemo, useState } from 'react';
import type { StationApi } from '@/lib/api';
import type { PlayerStatus } from './usePlayer';

export const SCALE_MAX = 250;
const PROBE_INTERVAL_MS = 5000;
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

  useEffect(() => {
    if (!api || !tunedIn || offline) {
      setLatencyMs(null);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const probe = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        await api.health(ctrl.signal);
        if (cancelled) return;
        setLatencyMs(Math.round(Date.now() - t0));
        setFailed(false);
      } catch {
        if (!cancelled) {
          setLatencyMs(null);
          setFailed(true);
        }
      } finally {
        clearTimeout(timer);
      }
    };

    probe();
    const id = setInterval(probe, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, tunedIn, offline]);

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
