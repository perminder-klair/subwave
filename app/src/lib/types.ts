// Shared types for the controller HTTP surface (`/now-playing`, `/state`,
// `/session`) and the live DJ session.
//
// SOURCE OF TRUTH: web/web/lib/types.ts in the SUB/WAVE repo. Keep this copy in
// sync — it's duplicated (not shared via a package) because the web hooks that
// also use it are DOM-coupled and can't be imported here. Pure interfaces only.

/** A track currently airing. `subsonic_id` is present for library tracks and
 *  drives lock-screen artwork via the `/api/cover/:id` proxy. */
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
  /** `avatar` is the full public path (e.g. `/api/persona-avatar/p_default0`) —
   *  the controller serves a transparent 1×1 placeholder when none is set. */
  persona?: { id?: string; name?: string; avatar?: string };
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

/** `/now-playing` response. */
export interface NowPlayingResponse {
  nowPlaying: NowPlayingTrack | null;
  context: StationContext | null;
  dj?: DjState;
  activeShow?: ActiveShow | null;
  listeners?: ListenerCount | number;
  streamOnline?: boolean;
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

/** `/state` response — upcoming queue + recent history + DJ log. */
export interface StationState {
  upcoming: QueueEntry[];
  history: QueueEntry[];
  djLog: DjLogEntry[];
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
