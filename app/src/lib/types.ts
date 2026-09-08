// Types for the controller HTTP surface. Source of truth is
// web/web/lib/types.ts; keep this copy in sync. Pure interfaces only.

import type { StationLocale } from './format';

export type { StationLocale };

/** A track currently airing. `subsonic_id` is present for library tracks and
 *  drives lock-screen artwork via the `/api/cover/:id` proxy. */
export interface NowPlayingTrack {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  duration?: number;
  subsonic_id?: string;
  // Tag data merged in from the library DB; an untagged track omits all of it.
  genre?: string | null;
  bpm?: number | null;
  musicalKey?: string | null;
  moods?: string[];
  energy?: 'low' | 'medium' | 'high' | null;
}

export interface WeatherContext {
  condition?: string;
  temp?: number;
  location?: string;
}

export interface FestivalContext {
  name?: string;
  mood?: string;
}

export interface TimeContext {
  show?: string;
  vibe?: string;
}

export interface ActiveShow {
  name?: string;
  /** `avatar` is the full public path; the controller serves a transparent
   *  1×1 placeholder when none is set. */
  persona?: { id?: string; name?: string; avatar?: string };
  /** Guest co-hosts. Empty or absent = solo show. */
  guests?: { id?: string; name?: string; avatar?: string }[];
}

/** `/dj` response — station identity. */
export interface DjPublic {
  name?: string;
  tagline?: string;
  soul?: string;
  frequency?: string;
  avatar?: string;
  station?: string;
  location?: string;
  locale?: StationLocale;
}

/** `/schedule` response — listener-safe view of the week. */
export interface SchedulePersona {
  id: string;
  name: string;
  /** Public one-liner; '' when unset, absent on an older controller. */
  tagline?: string;
  avatar: string;
  /** Present only when settings.privacy.publishPersonaSouls is on. */
  soul?: string;
}
export interface ScheduleShow {
  id: string;
  name: string;
  topic: string;
  /** Lead mood, derived server-side from moods[0] for back-compat. */
  mood: string;
  /** Full multi-value mood list (#929). */
  moods?: string[];
  personaId: string;
  /** Ids into the payload's `personas` index, pre-filtered to ones that still
   *  exist. Empty or absent = solo show. */
  guestPersonaIds?: string[];
}
/** 7 entries (Sun=0..Sat=6), each a 24-slot array of showId|null. */
export type ScheduleGrid = Record<number, Array<string | null>>;
export interface SchedulePayload {
  personas: SchedulePersona[];
  shows: ScheduleShow[];
  schedule: ScheduleGrid;
  /** Whether persona `soul` fields are included (same flag /personas reports). */
  soulsPublished?: boolean;
  timezone?: string | null;
  locale?: StationLocale;
}

/** Context envelope returned by `/now-playing`. Dominant mood priority is
 *  festival > weather > time. */
export interface StationContext {
  time?: TimeContext;
  weather?: WeatherContext;
  festival?: FestivalContext;
  dominantMood?: string;
  activeShow?: ActiveShow | null;
}

export interface DjState {
  [key: string]: unknown;
}

export interface ListenerCount {
  current?: number;
  peak?: number;
  total?: number;
  [key: string]: unknown;
}

/** `stream` on `/now-playing`. mount/format/bitrate describe the always-served
 *  MP3 floor; the *Enabled flags say which optional mounts are also live. */
export interface StreamInfo {
  mount?: string;
  format?: string;
  bitrate?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  opusEnabled?: boolean;
  flacEnabled?: boolean;
  aacEnabled?: boolean;
  /** Seconds Icecast bursts on connect, so how far behind the live edge the
   *  listener sits for the whole connection. Every controller timestamp is
   *  live-edge; shift by this to render listener-time (#1114). */
  bufferSeconds?: number | null;
}

/** `/now-playing` response. */
export interface NowPlayingResponse {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  dj?: DjState;
  activeShow?: ActiveShow | null;
  listeners?: ListenerCount | number;
  streamOnline?: boolean;
  /** kbps of the first attached broadcast mount; null when offline. */
  streamBitrate?: number | null;
  /** Drives the listener stream-format picker. */
  stream?: StreamInfo;
  /** Cumulative since-boot LLM token total. */
  llmTokens?: number | null;
  /** Station IANA timezone. Render on-air timestamps in it, not the device's,
   *  so they match what the DJ speaks (#418). */
  timezone?: string;
  /** UK keeps 24-hour time; US uses AM/PM. */
  locale?: StationLocale;
}

export interface QueueEntry {
  title?: string;
  artist?: string;
  album?: string;
  subsonic_id?: string;
  requestedBy?: string;
  /** ISO timestamp present on history entries. */
  t?: string;
  [key: string]: unknown;
}

/** Status returned by `/request/:id`. */
export type RequestStatus = 'pending' | 'resolved' | 'failed' | 'unknown';

export interface RequestTrack {
  title?: string;
  artist?: string;
  album?: string;
  subsonic_id?: string;
}

/** Result of a listener request. */
export interface RequestResult {
  success: boolean;
  pending?: boolean;
  ack?: string;
  track?: RequestTrack;
  queuePosition?: number;
  requestId?: string;
  requestText?: string;
  message?: string;
  status?: RequestStatus;
}

/** `POST /like` outcome (#991). Error statuses (403 disabled, 409 stale/no
 *  track, 429 throttled) still carry a JSON body with `error`. */
export interface LikeResult {
  ok?: boolean;
  songId?: string | null;
  liked?: boolean;
  alreadyLiked?: boolean;
  count?: number;
  error?: string;
}

/** `GET /like` — liked-state for the current airing, per listener (server-side
 *  dedup key, no account needed). */
export interface LikeStatus {
  enabled: boolean;
  songId?: string | null;
  liked?: boolean;
  count?: number;
}

export interface DjLogEntry {
  t?: string;
  text?: string;
  [key: string]: unknown;
}

/** `/state` response. */
export interface StationState {
  upcoming: QueueEntry[];
  history: QueueEntry[];
  djLog: DjLogEntry[];
  /** The on-air track, stamped at the LIVE EDGE. The authoritative start time,
   *  as opposed to when this client first saw the track. Shifted into
   *  listener-time before display (#1114). */
  current?: { title?: string; artist?: string; startedAt?: string } | null;
  timezone?: string;
  locale?: StationLocale;
  /** Station-wide listener-player UI toggles (from GET /state). */
  ui?: { boothBuddy?: boolean };
}

/** A single turn in the live DJ session. */
export type SessionRole = 'segment' | 'dj' | 'track' | 'system' | string;

export interface SessionTurn {
  t?: string | number;
  role?: SessionRole;
  kind?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

export interface SessionInfo {
  id?: string;
  [key: string]: unknown;
}

/** `/session` response. */
export interface SessionPayload {
  session: SessionInfo | null;
  messages: SessionTurn[];
}

/** Theme registry served by `/themes`. */
export type ThemeMode = 'light' | 'dark';
export interface Theme {
  id: string;
  name: string;
  description?: string;
  mode: ThemeMode;
  tokens: Record<string, string>;
}
export interface ThemesPayload {
  themes: Theme[];
  active?: string;
}
