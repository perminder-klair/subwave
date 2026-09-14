// Shapes the shows panel and its editor share. Every cap re-exports the shared
// show schema's own constant, so nothing here can drift from the controller.

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
  SHOW_YEAR_MAX,
  SHOW_YEAR_MIN,
  TAGS_PER_SHOW_LIMIT,
  validEraYear,
} from '@/lib/schemas.generated';

export const NAME_MAX = SHOW_NAME_MAX;
export const TOPIC_MAX = SHOW_TOPIC_MAX;
export const SHOWS_MAX = SHOWS_LIMIT;
export const GUESTS_MAX = GUESTS_PER_SHOW;
export const PLAYLISTS_MAX = PLAYLISTS_PER_SHOW;
// Deliberately separate from PLAYLISTS_MAX: same figure today, different rule.
export const EXCLUDED_PLAYLISTS_MAX = EXCLUDED_PLAYLISTS_PER_SHOW;
export const TAGS_MAX = TAGS_PER_SHOW_LIMIT;
export const TAG_MAX = SHOW_TAG_MAX;
export const TAG_RE = SHOW_TAG_RE;
// Year bounds for the <input min/max> and the error copy only. The TEST is the
// schema's own `validEraYear`, imported rather than re-derived from these.
export const YEAR_MIN = SHOW_YEAR_MIN;
export const YEAR_MAX = SHOW_YEAR_MAX;

/** Three states, not a loaded/not-loaded boolean: an empty `playlists` array
 *  means something different in each, and only `ready` licenses the editor to
 *  call a show's pinned id missing. */
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
  /** Long skill segments may pause music and speak in a real gap. */
  pauseTalk: boolean;
  /** [] = Any: the autonomous mood applies while the show is on air.
   *  Multi-value (#929), all selected moods weighted equally. */
  moods: string[];
  /** Empty = station default. A stale id silently falls back too. */
  themeId: string;
  /** Soft leans applied at pick time, each multi-value (#929): OR within the
   *  attribute, AND across attributes. Genres are free text resolved fuzzily. */
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  /** Single-valued: the two states are mutually exclusive. '' = no constraint.
   *  Only steers tracks that have had a vocal-activity pass. */
  vocals: '' | 'instrumental' | 'vocal';
  /** With >=1 music filter set, EVERY set filter becomes HARD instead of a soft
   *  lean. Legacy `genreStrict` shows are NOT auto-migrated; they load soft. */
  filtersStrict: boolean;
  /** Per-show track-length cap (seconds). null = inherit station default,
   *  0 = unlimited, >0 = this show's cap. */
  maxTrackSeconds: number | null;
  /** Per-show minimum track length (seconds) (#1573). null = inherit, 0 = no
   *  floor. A SELECTION filter, unlike the cap: a short track can't be grown. */
  minTrackLengthSeconds: number | null;
  /** Fade the last track out at the show change (#1574). TRI-STATE: null =
   *  inherit the station default. */
  fadeAtShowEnd: boolean | null;
  /** The union of these playlists becomes the show's candidate pool. Empty = no anchor. */
  playlistIds: string[];
  /** With ≥1 playlist pinned, the playlist is the show's ENTIRE universe;
   *  off-playlist tracks only play as a never-starve fallback. */
  playlistStrict: boolean;
  /** Every track in the anchor plays once before any repeats (#1612). Inert
   *  without playlistStrict. */
  playlistExhaust: boolean;
  /** Excluded from the candidate pool regardless of the other filters. */
  excludedPlaylistIds: string[];
  /** The show airs as a produced episode: intro, feature segment, sign-off. */
  programme: boolean;
  /** Pin the feature segment to one skill. Empty = producer picks per episode.
   *  Only used with programme on. */
  segmentSkill: string;
  /** Operator organisation tags. They filter and group this list and nothing
   *  else -- picker, DJ agent and public routes are blind to them. */
  tags: string[];
}

/** Mirrors the controller's EraWindow. Multiple windows let a show span
 *  non-adjacent decades. */
export interface EraWindow { fromYear: number | null; toYear: number | null }

// One entry of GET /shows/community: persona-agnostic, no owner, no schedule.
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
  minTrackLengthSeconds: number | null;
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
// '' is the absent third state and has no chip; clearing the selection gets
// back to it. Only the KEYS come from the schema, so a value added there
// without a label here shows its raw key rather than vanishing.
const VOCAL_LABELS: Record<string, string> = { instrumental: 'instrumental', vocal: 'vocals' };
export const VOCAL_OPTIONS = SHOW_VOCALS.map((key) => ({ key, label: VOCAL_LABELS[key] ?? key }));
export const ANY_SENTINEL = '__any__';
// Radix Select refuses an empty string value and `null` is not a value at all,
// so the tri-state "inherit" needs its own token.
export const INHERIT_SENTINEL = '__inherit__';
export const FILTER_VALUES_MAX = SHOW_FILTER_VALUES_MAX;

export function sameEra(a: EraWindow, b: { from: number | null; to: number | null } | EraWindow): boolean {
  const bf = 'from' in b ? b.from : b.fromYear;
  const bt = 'to' in b ? b.to : b.toYear;
  return a.fromYear === bf && a.toYear === bt;
}
/** Resolve the add-a-range inputs into a window to push onto `eras` (#1599).
 *  Returns a reason rather than throwing. Either bound may be blank (an open
 *  "2026+" is legal) but a window with NO bound is the absent state. Duplicates
 *  are refused so a range spelling out a decade lights that chip. The year test
 *  is the schema's own `validEraYear`, never re-derived from YEAR_MIN/MAX. */
export function resolveEraDraft(
  from: string,
  to: string,
  existing: EraWindow[],
): { window: EraWindow } | { error: string } {
  const parse = (raw: string): number | null | undefined => {
    // The trim is the editor's, not the schema's: a draft box legitimately
    // holds whitespace mid-keystroke.
    const v = raw.trim();
    if (!v) return null;
    const n = Number(v);
    return validEraYear(n) ? n : undefined;
  };
  const fromYear = parse(from);
  const toYear = parse(to);
  if (fromYear === undefined || toYear === undefined) {
    return { error: `Years must be whole numbers between ${YEAR_MIN} and ${YEAR_MAX}.` };
  }
  if (fromYear == null && toYear == null) return { error: 'Enter a start year, an end year, or both.' };
  if (fromYear != null && toYear != null && fromYear > toYear) {
    return { error: 'The start year must not be after the end year.' };
  }
  const w = { fromYear, toYear };
  if (existing.some(e => sameEra(e, w))) return { error: 'That range is already selected.' };
  return { window: w };
}

/** Preset label ("90s") or the raw window ("1975–1984") for a custom one. */
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

// The react-hook-form shape. `schedule` is not form data -- the panel reads it
// for the hours-a-week counts and the Rundown page owns PUT /schedule.
// Hand-written rather than derived from z.input<typeof showSchema>: that input
// type is `unknown` all the way down, so no nested path would type-check as a
// FieldPath. `Show` is what the schema's parse actually produces.
export interface ShowsFormValues {
  shows: Show[];
}

export interface SettingsResponse {
  values?: {
    shows?: Array<Partial<Show>>;
    schedule?: Schedule;
    personas?: Persona[];
    /** Crossfade-relative floor for a non-zero per-show cap or minimum track
     *  length (server-computed). */
    minTrackSeconds?: number;
    /** Station-wide picking windows; `minTrackLengthSeconds` is the default a
     *  show inherits when its own field is null. */
    picker?: { albumHours?: number; minTrackLengthSeconds?: number };
  };
  tts?: { moods?: string[] };
}
