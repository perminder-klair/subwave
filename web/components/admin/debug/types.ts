// Shapes of the controller's /debug response. Admin endpoints return loose JSON,
// so these are narrowed with optional-chaining at call sites, not trusted outright.

import type { StationLocale } from '../../../lib/types';

export interface DebugIcecast {
  listeners?: number;
  peakListeners?: number;
  error?: string;
}

interface DebugLibrary {
  total?: number;
  updatedAt?: string;
}

interface DebugQueueEntry {
  title?: string;
  artist?: string;
  requestedBy?: string;
}

interface DjLogEntry {
  id: string;
  t?: string;
  kind?: string;
  message?: string;
}

interface DebugQueue {
  current?: Record<string, unknown> | null;
  upcoming?: DebugQueueEntry[];
  djLog?: DjLogEntry[];
  djLogCount?: number;
}

interface DebugTtsSpoken {
  engine?: string;
  voice?: string;
  provider?: string;
  fellBack?: boolean;
  requested?: string;
}

/** One entry from the controller's TTS call ring (stats.ts ttsCalls): every speak()
 * outcome since boot, newest first, including silent engine fallbacks. */
export interface TtsCall {
  ok?: boolean;
  kind?: string;
  engine?: string;
  requested?: string;
  fellBack?: boolean;
  ms?: number;
  chars?: number;
  t?: string;
  error?: string;
  /** Spoken text, capped at ~240 chars by the controller. */
  text?: string;
  /** Voicing persona name; null for global kinds (jingle/default). */
  persona?: string | null;
}

export interface DebugTts {
  spoken?: DebugTtsSpoken;
  jingle?: { engine?: string };
  effectivePersona?: { name?: string };
  recentCalls?: TtsCall[];
  error?: string;
}

interface SessionMessage {
  t?: string;
  role?: string;
  kind?: string;
  text?: string;
}

export interface DebugSession {
  kind?: string;
  show?: { name?: string };
  persona?: { name?: string };
  messages?: SessionMessage[];
  handoff?: string;
  error?: string;
}

interface LlmCall {
  ok?: boolean;
  kind?: string;
  model?: string;
  via?: string;
  ms?: number;
  t?: string;
  error?: string;
  user?: string;
  system?: string;
  systemPreview?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  toolCalls?: Array<{ name?: string; args?: unknown; result?: unknown }>;
  response?: string;
  /** What the model said INSTEAD of the expected structured output on a failed call.
   * From the controller's failureDiagnostics(); absent on success (see `response`). */
  responseText?: string;
  steps?: number;
}

export interface DebugLlm {
  activeModel?: string;
  provider?: string;
  budget?: DebugBudget;
  recentCalls?: LlmCall[];
  shortlistContextWindow?: {
    samples?: number;
    peakInputTokens?: number | null;
    suggestedTokens?: number | null;
    headroomPct?: number;
    responseReserveTokens?: number;
    message?: string;
  };
  /** Raw-request capture status — drives the toggle + file-path hint. */
  debug?: {
    enabled?: boolean;
    viaEnv?: boolean;
    file?: string;
    max?: number;
  };
}

interface SubsonicEndpoint {
  endpoint: string;
  calls: number;
}

interface SubsonicCall {
  ok?: boolean;
  endpoint?: string;
  count?: number;
  ms?: number;
  t?: string;
  error?: string;
  params?: Record<string, unknown>;
  songIds?: Array<{ title?: string; artist?: string }>;
}

export interface DebugSubsonic {
  recentCalls?: SubsonicCall[];
  endpoints?: SubsonicEndpoint[];
  error?: string;
}

// Mirrors the controller's getFullContext() snapshot.
export interface DebugContext {
  time?: { period?: string; mood?: string; vibe?: string; show?: string };
  weather?: {
    condition?: string;
    mood?: string | null;
    temp?: number | null;
    tempUnit?: string;
    isDay?: boolean;
    location?: string;
  };
  festival?: { name?: string; mood?: string } | null;
  dominantMood?: string;
  date?: {
    iso?: string;
    dayOfWeek?: number;
    dayLabel?: string;
    monthLabel?: string;
    dayOfMonth?: number;
    season?: string;
  };
  clock?: { hhmm?: string; isWeekend?: boolean; isLateNight?: boolean; isCommute?: boolean };
  activeShow?: { name?: string; mood?: string; topic?: string; persona?: { name?: string } | null } | null;
  listeners?: { count?: number | null };
  error?: string;
}

export interface DebugMount {
  path: string;
  codec: string;
  configured: boolean;
  live: boolean;
  bitrate: number | null;
  listeners: number | null;
  sampleRate: number | null;
  channels: number | null;
  contentType: string | null;
  url: string;
}

export interface DebugMounts {
  list: DebugMount[];
  tuneIn: { entryCount: number; pls: string; m3u: string };
}

/** Daily token budget snapshot (settings.llm.dailyTokenCap), mirroring the controller's
 * budgetMode() tiers: soft mutes optional segments, hard stops model calls. */
export interface DebugBudget {
  enabled?: boolean;
  cap?: number;
  softPct?: number;
  exemptRequests?: boolean;
  usedToday?: number;
  remaining?: number;
  mode?: 'normal' | 'soft' | 'hard';
}

export interface DebugData {
  /** Station IANA zone — render DJ-log timestamps in it (issue #418). */
  timezone?: string;
  locale?: StationLocale;
  icecast?: DebugIcecast;
  liquidsoapLog?: string;
  llm?: DebugLlm;
  queue?: DebugQueue;
  library?: DebugLibrary;
  nowPlaying?: Record<string, unknown> | null;
  context?: DebugContext | null;
  tts?: DebugTts;
  subsonic?: DebugSubsonic;
  session?: DebugSession;
  config?: Record<string, unknown>;
  mounts?: DebugMounts;
  error?: string;
}

