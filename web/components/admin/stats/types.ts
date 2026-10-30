// Response shapes for the Stats page's reads: /stats (in-memory rollups since
// boot, plus the durable transitions record), /stats/week (the weekly recap),
// /listeners, /audience, /listeners/connections and /system.

import type { MixDropReason, TransitionEffect } from '@/lib/schemas.generated';
import type { ListenerConnection } from '../../../lib/clientLabel';
import type { ListenerSample } from '../../../lib/audienceStats';

export interface LatencyStats {
  avg?: number;
  p50?: number;
  p95?: number;
  max?: number;
}

export interface ByKindRow {
  kind: string;
  count: number;
  ok: number;
  avgMs?: number;
  tokens?: number;
}

export interface ContextWindowRow {
  kind: string;
  calls: number;
  samples: number;
  averageInputTokens: number | null;
  peakInputTokens: number | null;
}

export interface ContextWindow {
  samples: number;
  peakInputTokens: number | null;
  pickerPeakInputTokens?: number | null;
  peakKind?: string | null;
  suggestedTokens: number | null;
  headroomPct?: number;
  responseReserveTokens?: number;
  message: string;
}

export interface LlmStats {
  window: number;
  count: number;
  ok: number;
  failed: number;
  successRate?: number;
  latency: LatencyStats;
  tokens?: { total?: number; input?: number; output?: number };
  cost?: { usd: number; complete: boolean } | null;
  // Failed calls that ran out the agent deadline; null without a deadline.
  deadlineHits?: number | null;
  agentTimeoutMs?: number;
  provider?: string;
  activeModel?: string;
  agent: { calls: number; avgSteps?: number; avgTools?: number };
  byKind: ByKindRow[];
  // Which model answered: the primary, or a fallback leg that stepped in.
  byModel: { model: string; count: number; tokens?: number; costUsd?: number; priced?: boolean }[];
  contextWindows?: {
    shortlist: ContextWindow;
    agenticPicker: ContextWindow;
    byKind: ContextWindowRow[];
  };
  budget?: {
    enabled: boolean;
    cap: number;
    softPct: number;
    usedToday: number;
    remaining: number | null;
    mode: 'normal' | 'soft' | 'hard';
  };
}

export interface TtsStats {
  window: number;
  count: number;
  ok: number;
  failed: number;
  latency: LatencyStats;
  fellBack: number;
  fallbackRate?: number | null;
  chars?: number;
  slowest?: { ms: number; kind: string | null } | null;
  byEngine: { engine: string; count: number; ok: number; avgMs?: number }[];
  byKind: { kind: string; count: number; avgMs?: number }[];
}

export interface DjLogStats {
  count: number;
  byKind: { kind: string; count: number }[];
}

export interface RequestsStats {
  window: number;
  count: number;
  resolved: number;
  failed: number;
  successRate?: number | null;
  latency: LatencyStats;
  artistMiss: { count: number; rate?: number | null };
  byPath: { path: string; count: number; ok: number }[];
  byPickSource: { source: string; count: number }[];
  topRequesters: { requester: string; count: number }[];
}

// The durable seam record, from library.db plays over the last `days` days.
export interface TransitionStats {
  days: number;
  since: string;
  seams: number;
  bySeam: Record<string, number>;
  asked: number;
  byAsk: Record<string, number>;
  dropped: number;
  byReason: Partial<Record<MixDropReason, number>>;
  byEffect: Partial<Record<TransitionEffect, Partial<Record<MixDropReason, number>>>>;
}

export interface StatsResponse {
  llm?: LlmStats;
  trackSelection?: 'agentic' | 'shortlist';
  tts?: TtsStats;
  djLog?: DjLogStats;
  requests?: RequestsStats;
  // Null when the play history is unavailable; absent from an older controller.
  transitions?: TransitionStats | null;
  error?: string;
}

export interface WeekTotals {
  sessions: number | null;
  countries: number | null;
  listeningHours: number | null;
  requests: number | null;
  tracks: number | null;
}

// A null figure is unmeasured (its record does not cover the window), not zero.
export interface WeekRecap {
  station: string;
  week: { from: string; to: string; number: number };
  current: WeekTotals;
  previous: WeekTotals;
  busiestHour: { at: string; avg: number } | null;
  topArtist: { name: string; plays: number; requested: number } | null;
  topTrack: { title: string; artist: string | null; plays: number } | null;
  topRequester: { name: string; requests: number } | null;
  newSource: { source: string; sessions: number; firstSeen: string } | null;
  mostPlayed: {
    days: number;
    artists: { name: string; plays: number }[];
    tracks: { title: string; artist: string | null; plays: number }[];
  };
}

export interface ListenersResponse {
  current?: number | null;
  sinceMinutes?: number;
  samples?: ListenerSample[];
  error?: string;
}

export interface AudienceResponse {
  sinceMinutes?: number;
  sessions?: number;
  referrers?: { source: string; count: number }[];
  countries?: { country: string; count: number }[];
  error?: string;
}

// `error` is set on a 502 (Icecast admin unreachable), so "nobody connected"
// stays distinct from "couldn't read".
export interface ConnectionsResponse {
  count?: number;
  connections?: ListenerConnection[];
  error?: string;
}

export interface ContainerUsage {
  name: string;
  service: string;
  cpuPct: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
}

export interface HostUsage {
  cpus: number;
  loadavg: [number, number, number];
  memTotal: number;
  memUsed: number;
  uptime: number;
}

export interface SystemResponse {
  dockerAvailable?: boolean;
  dockerError?: string;
  host?: HostUsage;
  containers?: ContainerUsage[];
  error?: string;
}
