// Shared types for the controller HTTP surface. These mirror the JSON the
// controller writes; runtime guarantees come from the Zod schemas in
// controller/src (pending the TS migration, issue #43).

export type StationLocale = 'en-GB' | 'en-US';

/** `subsonic_id` drives MediaSession artwork via the `/api/cover/:id` proxy;
 *  jingles and scanning have no id. */
export interface NowPlayingTrack {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  duration?: number;
  subsonic_id?: string;
  // Merged in from the library DB. A not-yet-tagged track omits all of these.
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
  /** `avatar` is a full public URL (e.g. `/api/persona-avatar/p_default0`);
   *  the controller serves a transparent 1×1 when no avatar is set. */
  persona?: { id?: string; name?: string; avatar?: string };
  /** Empty or absent = solo show. */
  guests?: { id?: string; name?: string; avatar?: string }[];
}

/** `/schedule` response — listener-safe view of the week. */
export interface SchedulePersona {
  id: string;
  name: string;
  /** '' when the operator hasn't set one; optional only because an older
   *  controller may omit the field entirely. */
  tagline?: string;
  avatar: string;
  /** Present only when settings.privacy.publishPersonaSouls is on. */
  soul?: string;
}
export interface ScheduleShow {
  id: string;
  name: string;
  topic: string;
  /** Lead mood — moods[0], derived server-side for back-compat. */
  mood: string;
  /** Full multi-value mood list (#929). */
  moods?: string[];
  personaId: string;
  /** Ids into the payload's `personas` index, already filtered to personas
   *  that still exist. Empty/absent = solo show. */
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

/** From controller's `context.getFullContext()`. Dominant-mood priority is
 *  festival > weather > time. */
export interface StationContext {
  time?: TimeContext;
  weather?: WeatherContext;
  festival?: FestivalContext;
  dominantMood?: string;
  activeShow?: ActiveShow | null;
}

export interface DjState {
  // Opaque: shape varies per provider/persona. Displayable diagnostics only.
  [key: string]: unknown;
}

export interface ListenerCount {
  current?: number;
  peak?: number;
  total?: number;
  [key: string]: unknown;
}

/** mount/format/bitrate describe the always-served MP3 floor; the *Enabled
 *  flags say which optional mounts are also live. */
export interface StreamInfo {
  mount?: string;
  format?: string;
  bitrate?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
  opusEnabled?: boolean;
  flacEnabled?: boolean;
  aacEnabled?: boolean;
  /** Seconds of audio Icecast bursts on connect — i.e. how far behind the live
   *  edge this listener is for the whole connection. Every timestamp on the
   *  payload is live-edge; subtract this to render listener-time (issue #1114). */
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
  /** Station IANA timezone — render on-air timestamps in it (issue #418). */
  timezone?: string;
  /** Station display locale — UK keeps 24-hour time; US uses AM/PM. */
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
  /** True once the controller has handed this item to Liquidsoap. */
  sent?: boolean;
  /** The track arrives via a pre-rendered stem blend rather than a plain
   *  crossfade. Stamped once the seam's clip is queued, so it's definitive,
   *  not a prediction (#1257). */
  stemSeam?: boolean;
  [key: string]: unknown;
}

export interface PublicLyricLine {
  startMs: number | null;
  text: string;
}

export interface PublicLyricsPayload {
  songId: string | null;
  synced: boolean;
  /** Per-client correction in ms. Positive means lyrics advance sooner. */
  offsetMs: number;
  lines: PublicLyricLine[];
}

/** Status returned by `/request/:id`. */
export type RequestStatus = 'pending' | 'resolved' | 'failed' | 'unknown';

export interface RequestTrack {
  title?: string;
  artist?: string;
  album?: string;
  subsonic_id?: string;
}

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

/** `/state` response. */
export interface StationState {
  upcoming: QueueEntry[];
  history: QueueEntry[];
  djLog: DjLogEntry[];
  timezone?: string;
  locale?: StationLocale;
  /** Operator player defaults. `skin` indexes components/skins;
   *  `tuneInOverlay` gates the tap-to-tune gate (default on). */
  ui?: { boothBuddy?: boolean; skin?: string; tuneInOverlay?: boolean };
  /** Private-station flags (#478) — booleans only, never credentials.
   *  `privatePlayer` swaps the player pages for a "private station" screen;
   *  `listenerAuth` means the mounts demand the shared listener password
   *  before tune-in. Absent on older controllers = fully public. */
  privacy?: { privatePlayer?: boolean; listenerAuth?: boolean };
}

/** `role` arrives as 'segment' for spoken bits and is reclassified to 'voice'
 *  by `turnClass()`. */
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

export interface CloudVoice {
  id: string;
  label: string;
}

export type CloudProvider = 'openai' | 'elevenlabs' | 'fish-audio' | 'openai-compatible';
