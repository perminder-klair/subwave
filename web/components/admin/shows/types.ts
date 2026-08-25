// Shapes the shows panel and its editor share.
//
// Every cap below re-exports the shared show schema's own constant under a
// local name, so nothing here can drift from the controller.

import {
  EXCLUDED_PLAYLISTS_PER_SHOW,
  GUESTS_PER_SHOW,
  PLAYLISTS_PER_SHOW,
  SHOWS_LIMIT,
  SHOW_ENERGY,
  SHOW_FILTER_VALUES_MAX,
  SHOW_NAME_MAX,
  SHOW_TAG_MAX,
  SHOW_TAG_RE,
  SHOW_TOPIC_MAX,
  SHOW_VOCALS,
  TAGS_PER_SHOW_LIMIT,
} from '@/lib/schemas.generated';

export const NAME_MAX = SHOW_NAME_MAX;
export const TOPIC_MAX = SHOW_TOPIC_MAX;
export const SHOWS_MAX = SHOWS_LIMIT;
export const GUESTS_MAX = GUESTS_PER_SHOW;
export const PLAYLISTS_MAX = PLAYLISTS_PER_SHOW;
// Deliberately separate from PLAYLISTS_MAX: the same figure today, but one name
// covering both is how they would silently stop being.
export const EXCLUDED_PLAYLISTS_MAX = EXCLUDED_PLAYLISTS_PER_SHOW;
export const TAGS_MAX = TAGS_PER_SHOW_LIMIT;
export const TAG_MAX = SHOW_TAG_MAX;
export const TAG_RE = SHOW_TAG_RE;

/** How much the panel knows about the live Navidrome playlist index.
 *
 * Three states, not a loaded/not-loaded boolean: an empty `playlists` array
 * means something different in each, and only `ready` licenses the editor to
 * call a show's pinned id missing. A boolean collapses `loading` and `error`
 * into one bucket, and whichever way that bucket renders is wrong for the other
 * half of it — a spinner that never resolves, or a "no playlists" line shown
 * while the fetch is still in flight. */
export type PlaylistIndexStatus = 'loading' | 'ready' | 'error';

export interface Show {
  id: string;
  name: string;
  topic: string;
  personaId: string;
  /** Guest co-host persona ids (max 3, host excluded). Empty = solo show. */
  guestPersonaIds: string[];
  /** Multi-voice exchanges, up to twice an hour. Only meaningful with guests set. */
  banter: boolean;
  /** [] = Any — the show pins no mood; the autonomous mood (festival >
   *  weather > time of day) applies while it's on air. Multi-value (#929):
   *  any selected mood satisfies the filter, all weighted equally. */
  moods: string[];
  /** Empty = fall back to the station default. Validated against the live theme
   *  registry by the controller; a stale id silently falls back too. */
  themeId: string;
  /** Soft leans applied at pick time, each multi-value (#929): OR within the
   *  attribute, AND across attributes. Empty = no constraint. Genres are free text
   *  resolved fuzzily against the library. */
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  /** Single-valued, unlike the lists above: the two states are mutually
   *  exclusive. '' = no constraint, and is what every show predating the field
   *  carries. Backed by vocal-activity analysis, so it only steers tracks that
   *  have had a vocal pass. */
  vocals: '' | 'instrumental' | 'vocal';
  /** With ≥1 music filter set, EVERY set filter becomes HARD instead of a soft
   *  lean; off-filter tracks only play as a last resort. The controller does NOT
   *  auto-migrate legacy `genreStrict` shows — they load soft. */
  filtersStrict: boolean;
  /** Per-show track-length cap (seconds). null = inherit the station default;
   *  0 = unlimited (opt this show out of the cap so it can air long mixes);
   *  >0 = this show's own cap. */
  maxTrackSeconds: number | null;
  /** The union of these playlists becomes the show's candidate pool. Empty = no anchor. */
  playlistIds: string[];
  /** With ≥1 playlist pinned, the playlist is the show's ENTIRE universe;
   *  off-playlist tracks only play as a never-starve fallback. */
  playlistStrict: boolean;
  /** Excluded from the candidate pool regardless of the other filters. */
  excludedPlaylistIds: string[];
  /** The show airs as a produced episode: intro, a planned feature segment
   *  mid-hour, a sign-off, all driven by the topic brief. */
  programme: boolean;
  /** Pin the feature segment to one skill. Empty = the producer picks per episode.
   *  Only used with programme on. */
  segmentSkill: string;
  /** Operator organisation tags. They filter and group this list and nothing
   *  else — the picker, the DJ agent and every public route are blind to them. */
  tags: string[];
}

/** Mirrors the controller's EraWindow. Multiple windows let a show span
 *  non-adjacent decades ("90s + 2010s"). */
export interface EraWindow { fromYear: number | null; toYear: number | null }

// One entry of GET /shows/community: persona-agnostic, no owner and no schedule.
// Install drops it in as a fresh unscheduled show owned by the active persona.
export interface CommunityShow {
  slug: string;
  name: string;
  topic: string;
  moods: string[];
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  filtersStrict: boolean;
  banter: boolean;
  programme: boolean;
  segmentSkill: string;
  maxTrackSeconds: number | null;
  submittedBy?: string;   // GitHub login of the contributor who submitted it
  dateAdded?: string;     // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string;  // ISO date (YYYY-MM-DD) of the last catalog change
}

// One EraWindow each. Empty selection = any era.
export const DECADES: { key: string; label: string; from: number; to: number }[] = [
  { key: '2020', label: '2020s', from: 2020, to: 2029 },
  { key: '2010', label: '2010s', from: 2010, to: 2019 },
  { key: '2000', label: '2000s', from: 2000, to: 2009 },
  { key: '1990', label: '90s', from: 1990, to: 1999 },
  { key: '1980', label: '80s', from: 1980, to: 1989 },
  { key: '1970', label: '70s', from: 1970, to: 1979 },
  { key: '1960', label: '60s', from: 1960, to: 1969 },
  { key: '1950', label: '50s', from: 1950, to: 1959 },
];
export const ENERGY_OPTIONS: readonly string[] = SHOW_ENERGY;
// '' is the absent third state and deliberately has no chip — clearing the
// selection is how you get back to it. Labels are UI copy ("vocals" reads
// better as a chip than the schema's "vocal"), so only the KEYS come from the
// schema; a value added there without a label here shows its raw key rather
// than vanishing.
const VOCAL_LABELS: Record<string, string> = { instrumental: 'instrumental', vocal: 'vocals' };
export const VOCAL_OPTIONS = SHOW_VOCALS.map((key) => ({ key, label: VOCAL_LABELS[key] ?? key }));
export const ANY_SENTINEL = '__any__';
export const FILTER_VALUES_MAX = SHOW_FILTER_VALUES_MAX;

export function sameEra(a: EraWindow, b: { from: number | null; to: number | null } | EraWindow): boolean {
  const bf = 'from' in b ? b.from : b.fromYear;
  const bt = 'to' in b ? b.to : b.toYear;
  return a.fromYear === bf && a.toYear === bt;
}
/** Preset label ("90s") or the raw window ("1975–1984") for a custom one set via API. */
export function eraLabelOf(e: EraWindow): string {
  const hit = DECADES.find(d => sameEra(e, d));
  if (hit) return hit.label;
  if (e.fromYear != null && e.toYear != null) return `${e.fromYear}–${e.toYear}`;
  return e.fromYear != null ? `${e.fromYear}+` : `≤${e.toYear}`;
}

// From GET /themes. The token map is kept so the picker can render real colour
// swatches (ShowPickers.ThemePicker).
export interface ThemeOption {
  id: string;
  name: string;
  mode?: string;
  description?: string;
  tokens?: Record<string, string>;
}

/** From /dj/skills; disabled skills are filtered out on fetch. */
export interface SkillOption {
  kind: string;
  label?: string;
  name?: string;
  enabled?: boolean;
}

export interface Persona {
  id: string;
  name?: string;
  tagline?: string;
  avatar?: string;
  tts?: { engine?: string; voice?: string };
}

export interface Schedule {
  [day: number]: (string | null)[];
}

export interface FormState {
  shows: Show[];
  schedule: Schedule;
}

// The react-hook-form shape. `schedule` is not form data — the panel reads it
// for the hours-a-week counts and the Rundown page owns PUT /schedule.
//
// Hand-written rather than derived from z.input<typeof showSchema>: that input
// type is `unknown` all the way down (the legacy-field migration wraps the
// object in a z.preprocess, and most fields are pipelines of their own), so no
// nested path would type-check as a FieldPath. `Show` is what the schema's
// parse actually produces.
export interface ShowsFormValues {
  shows: Show[];
}

export interface SettingsResponse {
  values?: {
    shows?: Array<Partial<Show>>;
    schedule?: Schedule;
    personas?: Persona[];
    /** Crossfade-relative floor for a non-zero per-show cap (server-computed). */
    minTrackSeconds?: number;
  };
  tts?: { moods?: string[] };
}

