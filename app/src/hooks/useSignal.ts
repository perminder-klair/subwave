import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppActive } from '@/hooks/useAppActive';
import type { StationApi } from '@/lib/api';
import type { PlayerStatus } from './usePlayer';

export const SCALE_MAX = 250;
const PROBE_INTERVAL_MS = 5000;
// Back off after consecutive failures so a dead origin is not probed every 5s.
const PROBE_BACKOFF_MS = 15000;
const PROBE_BACKOFF_AFTER = 3;
const PROBE_TIMEOUT_MS = 4000;
// Phone round trips of 200–300ms are normal for buffered audio; keep the full scale good.
const GOOD_MS = SCALE_MAX;

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
    let activeProbe: AbortController | null = null;
    const probe = async () => {
      const ctrl = new AbortController();
      activeProbe = ctrl;
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        const healthy = await api.health(ctrl.signal);
        if (!healthy) throw new Error('Station health check failed');
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
        activeProbe = null;
      }
      if (cancelled) return;
      const delay = failsRef.current >= PROBE_BACKOFF_AFTER ? PROBE_BACKOFF_MS : PROBE_INTERVAL_MS;
      next = setTimeout(probe, delay);
    };

    probe();
    return () => {
      cancelled = true;
      activeProbe?.abort();
      if (next) clearTimeout(next);
    };
  }, [api, tunedIn, offline, appActive]);

  // Grade playback health separately from latency; reserve poor for an unreachable station.
  const quality = useMemo<SignalQuality>(() => {
    if (offline) return 'offline';
    if (!tunedIn) return 'idle';
    if (status === 'connecting') return 'acquiring';
    if (failed) return 'poor';
    if (latencyMs == null) return 'acquiring';
    if (latencyMs <= GOOD_MS) return 'good';
    return 'fair';
  }, [offline, tunedIn, status, failed, latencyMs]);

  return { latencyMs, quality };
}
