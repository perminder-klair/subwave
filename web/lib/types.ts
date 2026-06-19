// Shared types for the controller HTTP surface (`/now-playing`, `/state`,
// `/session`) and the live DJ session. These mirror the JSON the controller
// writes — for runtime guarantees, see the Zod schemas in controller/src
// (when controller TS migration lands per issue #43).

/** A track currently airing. `subsonic_id` is present for library tracks and
 *  drives MediaSession artwork via the `/api/cover/:id` proxy. Jingles +
 *  scanning have no id. */
export interface NowPlayingTrack {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  duration?: number;
  subsonic_id?: string;
  // Analysis/tag data merged in by the controller's /now-playing handler from
  // the library DB. All optional — a not-yet-tagged track omits them and the
  // player's metadata strip renders nothing.
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
  /** `id` and `avatar` are surfaced so the player can paint the on-air host
   *  next to the now-playing card and on the lock screen. `avatar` is the
   *  full public URL (e.g. `/api/persona-avatar/p_default0`) — the controller
   *  serves a transparent 1×1 placeholder when no avatar is set. */
  persona?: { id?: string; name?: string; avatar?: string };
}

/** `/dj` response used by Landing + lock-screen artwork. */
export interface DjPublic {
  name?: string;
  tagline?: string;
  soul?: string;
  frequency?: string;
  avatar?: string;
  station?: string;
  location?: string;
}

/** `/schedule` response — listener-safe view of the week. */
export interface SchedulePersona {
  id: string;
  name: string;
  avatar: string;
}
export interface ScheduleShow {
  id: string;
  name: string;
  topic: string;
  mood: string;
  personaId: string;
}
/** 7 entries (Sun=0..Sat=6), each a 24-slot array of showId|null. */
export type ScheduleGrid = Record<number, Array<string | null>>;
export interface SchedulePayload {
  personas: SchedulePersona[];
  shows: ScheduleShow[];
  schedule: ScheduleGrid;
  timezone?: string | null;
}

/** Context envelope returned by `/now-playing` — driven by controller's
 *  `context.getFullContext()`. Priority for the dominant mood is
 *  festival > weather > time. */
export interface StationContext {
  time?: TimeContext;
  weather?: WeatherContext;
  festival?: FestivalContext;
  dominantMood?: string;
  activeShow?: ActiveShow | null;
}

export interface DjState {
  // Opaque DJ status blob — shape varies per provider/persona. Consumers treat
  // it as displayable diagnostics.
  [key: string]: unknown;
}

export interface ListenerCount {
  current?: number;
  peak?: number;
  total?: number;
  [key: string]: unknown;
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
  /** Cumulative since-boot LLM token total — the player's token ticker. */
  llmTokens?: number | null;
  /** Station IANA timezone — render on-air timestamps in it (issue #418). */
  timezone?: string;
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

/** Result of a listener request — drives the RequestDrawer card. */
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

export interface DjLogEntry {
  t?: string;
  text?: string;
  [key: string]: unknown;
}

/** `/state` response — controller's upcoming queue + recent history + DJ log. */
export interface StationState {
  upcoming: QueueEntry[];
  history: QueueEntry[];
  djLog: DjLogEntry[];
}

/** A single turn in the live DJ session — `voice` (spoken on-air), `dj` (the
 *  agent's reasoning), `track` (something that aired), `system` (state events).
 *  `role` originates as 'segment' for spoken bits and is reclassified to
 *  'voice' by `turnClass()`. */
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

/** Cloud TTS provider option. */
export interface CloudVoice {
  id: string;
  label: string;
}

export type CloudProvider = 'openai' | 'elevenlabs' | 'openai-compatible';
