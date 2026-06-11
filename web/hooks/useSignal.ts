'use client';

import { useEffect, useMemo, useState } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import type { PlayerStatus } from '@/hooks/usePlayer';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

// The signal meter reads round-trip latency to the controller as a proxy for
// connection health — there's no lower-level stream-jitter signal available in
// the browser. The needle maps onto a 0–250 ms analog scale (see SCALE_MAX).
export const SCALE_MAX = 250;
const PROBE_INTERVAL_MS = 5000; // aligned with useStationFeed's poll cadence
const PROBE_TIMEOUT_MS = 4000;
const GOOD_MS = 120; // < this → "good"; up to SCALE_MAX → "fair"; beyond → "poor"

export type SignalQuality =
  | 'offline' // station off air
  | 'idle' // not tuned in
  | 'acquiring' // tuning in / first probe in flight
  | 'good'
  | 'fair'
  | 'poor'; // slow round-trip or a failed probe

export interface Signal {
  /** Last successful round-trip in ms, or null before the first probe lands. */
  latencyMs: number | null;
  quality: SignalQuality;
}

export interface UseSignalOptions {
  tunedIn: boolean;
  status: PlayerStatus;
  offline: boolean;
}

// Times a cheap GET to /health every few seconds while tuned in, surfacing a
// measured latency + a derived quality band for the footer's signal meter.
// Probes only while tuned in and on air, so the landing page makes no requests.
export function useSignal({ tunedIn, status, offline }: UseSignalOptions): Signal {
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Park the meter (and stop probing) whenever there's nothing live to read.
    if (!tunedIn || offline) {
      setLatencyMs(null);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const probe = async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const t0 = performance.now();
      try {
        await fetch(`${API_URL}/health`, { cache: 'no-store', signal: ctrl.signal });
        if (cancelled) return;
        setLatencyMs(Math.round(performance.now() - t0));
        setFailed(false);
      } catch {
        // Timeout or network error — treat as a degraded signal rather than
        // surfacing an error; the watchdog in usePlayer owns actual recovery.
        if (!cancelled) {
          setLatencyMs(null);
          setFailed(true);
        }
      } finally {
        clearTimeout(timer);
      }
    };

    // Probes pause while the tab is hidden — a backgrounded player doesn't
    // need a live needle — and fire again immediately on return.
    const stopPolling = pollWhileVisible(() => { void probe(); }, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [tunedIn, offline]);

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
