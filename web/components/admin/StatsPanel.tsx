'use client';

// The Stats page, after the "Stats Redesign" design: a front panel that says
// whether anyone is listening and whether the station is healthy, then sections
// from the weekly recap down to diagnostics, with a tuner dial pinned above them
// to find your way. This file owns the reads and the page header; each section
// renders from what it is handed (./stats/*).
//
// /stats reports activity since boot, except `transitions`, which is read from
// the play history; /listeners, /audience and /stats/week read durable records.

import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError, adminJson, useAdminQuery } from '../../lib/admin-query';
import { errorMessage } from '../../lib/notify';
import { ErrorState } from '@/components/ui/error-state';
import { Btn } from './ui';
import { cn } from '../../lib/cn';
import { statsKeys } from './stats-queries';
import { LABEL, NOTE } from './stats/parts';
import { SectionDial } from './stats/SectionDial';
import { FrontPanel } from './stats/FrontPanel';
import { WeekRecap } from './stats/WeekRecap';
import { Listening } from './stats/Listening';
import { OnAir } from './stats/OnAir';
import { EngineRoom } from './stats/EngineRoom';
import { Rack } from './stats/Rack';
import { Diagnostics, type DiagnosticKey } from './stats/Diagnostics';
import type {
  AudienceResponse,
  ConnectionsResponse,
  ListenersResponse,
  StatsResponse,
  SystemResponse,
  WeekRecap as WeekRecapResponse,
} from './stats/types';

class StatsShapeError extends Error {}

const CLOSED: Record<DiagnosticKey, boolean> = { requests: false, transitions: false };

export default function StatsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [paused, setPaused] = useState(false);
  const [range, setRange] = useState('1440'); // minutes — 24h default
  const [open, setOpen] = useState(CLOSED);
  const enabled = hydrated && !needsAuth && !paused;

  // /stats — usage rollups, 5s.
  const statsQuery = useAdminQuery<StatsResponse & { t?: string }>({
    key: statsKeys.rollups(), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 5_000,
    request: async (fetcher, signal) => {
      const body = await adminJson<StatsResponse & { t?: string }>(fetcher, '/stats', undefined, signal);
      if (!body || typeof body !== 'object' || !body.llm) {
        throw new StatsShapeError(body?.error || 'unexpected response shape from /stats');
      }
      return body;
    },
  });

  // /stats/week — the weekly recap and most-played lists. Cached server-side
  // for five minutes (it reads listeners.jsonl whole), so poll at that pace.
  const weekQuery = useAdminQuery<WeekRecapResponse>({
    key: statsKeys.week(), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 5 * 60_000,
    request: (fetcher, signal) => adminJson(fetcher, '/stats/week', undefined, signal),
  });

  // /listeners — durable time-series for the listener chart, 30s. Soft-fails:
  // a miss leaves the last reading in place rather than erroring the page.
  const listenersQuery = useAdminQuery<ListenersResponse>({
    key: statsKeys.listeners(range), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    placeholderData: previous => previous,
    request: (fetcher, signal) => adminJson(fetcher, `/listeners?sinceMinutes=${range}`, undefined, signal),
  });

  // /audience — durable referral/geo rollup, 30s, soft-fail like /listeners.
  const audienceQuery = useAdminQuery<AudienceResponse>({
    key: statsKeys.audience(range), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    placeholderData: previous => previous,
    request: (fetcher, signal) => adminJson(fetcher, `/audience?sinceMinutes=${range}`, undefined, signal),
  });
  // Range is part of both cache keys, so keep a range-independent last success:
  // a first failure on a new range would otherwise blank the charts.
  const [lastListeners, setLastListeners] = useState<ListenersResponse | null>(null);
  const [lastAudience, setLastAudience] = useState<AudienceResponse | null>(null);
  useEffect(() => {
    if (listenersQuery.data) setLastListeners(listenersQuery.data);
  }, [listenersQuery.data]);
  useEffect(() => {
    if (audienceQuery.data) setLastAudience(audienceQuery.data);
  }, [audienceQuery.data]);

  // /listeners/connections — 30s, range-independent. A 502 is stored as an
  // error, not dropped, so the card can say "live detail unavailable".
  const connectionsQuery = useAdminQuery<ConnectionsResponse>({
    key: statsKeys.connections(), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    request: async (fetcher, signal) => {
      try {
        return await adminJson<ConnectionsResponse>(
          fetcher, '/listeners/connections', undefined, signal,
        );
      } catch (error) {
        if (error instanceof AdminResponseError) {
          const detail = typeof error.body.error === 'string' ? error.body.error : null;
          return { error: detail || 'live connection detail unavailable' };
        }
        throw error;
      }
    },
  });

  // /system — host and per-container CPU/memory, 30s (~1s per container to
  // sample). Feeds the front panel's Host row as well as the rack. Soft-fails.
  const systemQuery = useAdminQuery<SystemResponse>({
    key: statsKeys.system(), adminFetch, enabled, staleTime: 0,
    refetchInterval: () => 30_000,
    request: (fetcher, signal) => adminJson(fetcher, '/system', undefined, signal),
  });

  const data = statsQuery.error instanceof StatsShapeError ? null : (statsQuery.data ?? null);
  const err = statsQuery.error ? errorMessage(statsQuery.error) : null;
  const listeners = listenersQuery.data ?? lastListeners;
  const audience = audienceQuery.data ?? lastAudience;
  const recap = weekQuery.data ?? null;
  const system = systemQuery.data ?? null;
  const rangeLabel = range === '10080' ? '7d' : '24h';

  const samples = listeners?.samples ?? [];
  const counts = samples.map(s => s.count);
  // The controller's own clock, so the masthead moves with each poll.
  const asOf = data?.t ? new Date(data.t) : null;

  return (
    // A block, not a grid: a sticky grid item can't leave its own row, and the
    // dial has to ride the whole page.
    <div>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="m-0 font-display text-[40px] leading-none font-normal tracking-[-0.02em]">Stats</h1>
        <span className={NOTE}>
          {[
            recap?.station,
            asOf && `${asOf.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${asOf.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
          ].filter(Boolean).join(' · ') || ' '}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-4">
          <span className={cn(LABEL, err ? 'text-[var(--danger)]' : paused ? 'text-muted' : 'text-vermilion')}>
            ● {err ? 'down' : paused ? 'paused' : 'live'}
          </span>
          <span className="font-mono text-[10px] tracking-[0.2em] uppercase">refresh · 5s</span>
          <span className={cn(NOTE, 'order-last w-full sm:order-none sm:w-auto')}>rollups since boot · listeners durable</span>
          <Btn sm onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Btn>
        </div>
      </header>

      <SectionDial />

      <div className="mt-3 grid grid-cols-1 gap-14">
        {err && <ErrorState error={err} />}

        <FrontPanel
          listeners={{
            now: listeners?.current ?? null,
            peak: counts.length ? Math.max(...counts) : null,
            avg: counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : null,
            low: counts.length ? Math.min(...counts) : null,
            rangeLabel,
            loaded: listeners != null,
          }}
          llm={data?.llm ?? null}
          tts={data?.tts ?? null}
          requests={data?.requests ?? null}
          host={system?.host ?? null}
          statsDown={!!err}
        />

        <WeekRecap recap={recap} />

        <Listening
          range={range}
          onRange={setRange}
          rangeLabel={rangeLabel}
          samples={samples}
          listenersLoaded={listeners != null}
          audience={audience}
          connections={connectionsQuery.data ?? null}
        />

        <OnAir
          recap={recap}
          djLog={data?.djLog ?? null}
          transitions={data?.transitions}
          onTransitions={() => setOpen(o => ({ ...o, transitions: true }))}
        />

        <EngineRoom llm={data?.llm ?? null} tts={data?.tts ?? null} />

        <Rack system={system} />

        <Diagnostics
          requests={data?.requests ?? null}
          llm={data?.llm ?? null}
          trackSelection={data?.trackSelection}
          transitions={data ? data.transitions : undefined}
          open={open}
          onToggle={key => setOpen(o => ({ ...o, [key]: !o[key] }))}
        />
      </div>
    </div>
  );
}
