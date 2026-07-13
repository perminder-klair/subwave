'use client';

// Shows scheduler — /admin/shows. A show is a reusable definition (name,
// topic, owner persona, music moods). The weekly grid assigns a show to any
// 1-hour cell, Mon–Sun. When the current hour has a show, its persona goes on
// air, its moods (when set — empty means Any/auto) override the autonomous
// mood, and its topic feeds the DJ.
// An empty hour = the station runs autonomously, as it does today.
// Everything POSTs to /settings and applies live.
//
// Shows are created/edited through an in-page editor (ShowEditor, below the
// show list) — the personas pattern: click a show to open it, edit it in place.
// The weekly grid is drag-paintable: pick a brush, then click-drag across
// cells; click a day label or hour header to fill a whole row/column. On
// touch, a tap toggles one cell and a long-press arms drag-painting — a
// plain swipe only scrolls (see HOLD_MS below).
import type { ChangeEvent, RefObject, TouchEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, Share2 } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../lib/notify';
import { fmtClock, normalizeStationLocale, zonedDayHour } from '../../lib/format';
import type { StationLocale } from '../../lib/types';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Field } from '../ui/field';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Metric, MetaChip, Toggle } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';
import { EditorDialog } from '../ui/editor-dialog';
import { Modal } from '../ui/modal';
import { AiFill } from './AiFill';
import GenreSuggest from './GenreSuggest';
import { PersonaPicker, GuestPersonaPicker, ThemePicker } from './ShowPickers';
import { cn } from '../../lib/cn';
import { showSubmitUrl } from '../../lib/repo';

const NAME_MAX = 60;
const TOPIC_MAX = 1000;
const SHOWS_MAX = 64;
// Mirrors the controller's GUESTS_PER_SHOW cap (settings.ts).
const GUESTS_MAX = 3;

// Storage keys are 0=Sun..6=Sat (JS getDay); display Mon-first.
const DAYS = [
  { key: 1, label: 'Mon' }, { key: 2, label: 'Tue' }, { key: 3, label: 'Wed' },
  { key: 4, label: 'Thu' }, { key: 5, label: 'Fri' }, { key: 6, label: 'Sat' },
  { key: 0, label: 'Sun' },
];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Touch paint gesture: holding a cell this long (without drifting past the
// slop) arms a paint stroke; releasing earlier is a tap (single-cell toggle,
// committed on release); drifting past the slop first is a scroll and paints
// nothing. Mouse painting is immediate and unaffected.
const HOLD_MS = 300;
const PRESS_SLOP_PX = 8;

const SHOW_COLORS = [
  '#c5302a', '#2f6f4f', '#3a5fa8', '#9a5b1f', '#6b4a8a', '#1f7a7a',
  '#a83a6b', '#4a6b1f', '#8a6a1f', '#3a3a8a', '#7a2f5a', '#2f7a3a',
];

interface Show {
  id: string;
  name: string;
  topic: string;
  personaId: string;
  /** Guest co-host persona ids (max 3, host excluded). While the show is on
   *  air the speaker rotation hands some standalone talk breaks (station IDs,
   *  hourly checks, weather/news segments) to a guest, in their own voice.
   *  Empty = solo show, exactly today's behaviour. */
  guestPersonaIds: string[];
  /** Scripted banter breaks: short multi-voice exchanges between the host and
   *  guests, aired up to twice an hour. Only meaningful with guests set. */
  banter: boolean;
  /** [] = Any — the show pins no mood; the autonomous mood (festival >
   *  weather > time of day) applies while it's on air. Multi-value (#929):
   *  any selected mood satisfies the filter, all weighted equally. */
  moods: string[];
  /** Optional theme override — empty string means "fall back to the station
   *  default while this show is on air". Validated against the live theme
   *  registry by the controller; a stale id silently falls back too. */
  themeId: string;
  /** Optional music-steering filters — soft leans applied at pick time, each a
   *  multi-value list (#929): OR within the attribute, AND across attributes.
   *  Empty list means "no constraint". Genres are free text resolved fuzzily
   *  against the library; eras are decade/year windows; energies come from
   *  low|medium|high. */
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  /** When true (and ≥1 music filter is set) EVERY set filter — mood, genre,
   *  era, energy — becomes a HARD filter on the pick pool instead of a soft
   *  lean; off-filter tracks only play as a last resort to avoid silence.
   *  Defaults off. (Replaces the genre-only `genreStrict`; the controller does
   *  NOT auto-migrate legacy strict shows — they load soft, opt back in here.) */
  filtersStrict: boolean;
  /** Per-show track-length cap (seconds). null = inherit the station default;
   *  0 = unlimited (opt this show out of the cap so it can air long mixes);
   *  >0 = this show's own cap. */
  maxTrackSeconds: number | null;
  /** Navidrome playlist anchor — the union of these playlists becomes the show's
   *  candidate pool. Empty = no anchor (behaves as before). */
  playlistIds: string[];
  /** When true (and ≥1 playlist is pinned) the playlist is the show's ENTIRE
   *  universe; off-playlist tracks only play as a never-starve fallback. When
   *  false, the playlist just dominates the pool. Defaults off. */
  playlistStrict: boolean;
  /** Navidrome playlist blocklist — tracks from these playlists are excluded
   *  from the candidate pool regardless of other filters. Empty = no exclusions. */
  excludedPlaylistIds: string[];
  /** Programme mode: the show airs as a produced episode — intro at the top,
   *  a planned feature segment mid-hour, a sign-off in the final minutes —
   *  all driven by the topic brief via a per-episode producer plan. */
  programme: boolean;
  /** Optional: pin the feature segment to one skill (e.g. news for a morning
   *  roundup). Empty = the producer picks per episode. Only used with
   *  programme on. */
  segmentSkill: string;
}

/** One era window (mirrors the controller's EraWindow). Multiple windows let a
 *  show span non-adjacent decades ("90s + 2010s"). */
interface EraWindow { fromYear: number | null; toYear: number | null }

// One entry in the shipped community show catalog (GET /shows/community). A
// portable, persona-agnostic show definition: no owner, no schedule — Install
// drops it in as a fresh unscheduled show owned by the active persona.
interface CommunityShow {
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

// Decade presets for the era chips → one EraWindow each. Empty selection = any era.
const DECADES: { key: string; label: string; from: number; to: number }[] = [
  { key: '2020', label: '2020s', from: 2020, to: 2029 },
  { key: '2010', label: '2010s', from: 2010, to: 2019 },
  { key: '2000', label: '2000s', from: 2000, to: 2009 },
  { key: '1990', label: '90s', from: 1990, to: 1999 },
  { key: '1980', label: '80s', from: 1980, to: 1989 },
  { key: '1970', label: '70s', from: 1970, to: 1979 },
  { key: '1960', label: '60s', from: 1960, to: 1969 },
  { key: '1950', label: '50s', from: 1950, to: 1959 },
];
const ENERGY_OPTIONS = ['low', 'medium', 'high'];
const ANY_SENTINEL = '__any__';
// Mirrors the controller's SHOW_FILTER_VALUES_MAX cap (settings.ts).
const FILTER_VALUES_MAX = 6;

function sameEra(a: EraWindow, b: { from: number | null; to: number | null } | EraWindow): boolean {
  const bf = 'from' in b ? b.from : b.fromYear;
  const bt = 'to' in b ? b.to : b.toYear;
  return a.fromYear === bf && a.toYear === bt;
}
/** Preset label ("90s") or the raw window ("1975–1984") for a custom one set via API. */
function eraLabelOf(e: EraWindow): string {
  const hit = DECADES.find(d => sameEra(e, d));
  if (hit) return hit.label;
  if (e.fromYear != null && e.toYear != null) return `${e.fromYear}–${e.toYear}`;
  return e.fromYear != null ? `${e.fromYear}+` : `≤${e.toYear}`;
}

// View of a theme returned by GET /themes. We keep the token map here so the
// theme picker can render real colour swatches (see ShowPickers.ThemePicker).
interface ThemeOption {
  id: string;
  name: string;
  mode?: string;
  description?: string;
  tokens?: Record<string, string>;
}

/** One entry of the /dj/skills catalogue — the programme feature-segment pin
 *  only needs the kind + a label; disabled skills are filtered on fetch. */
interface SkillOption {
  kind: string;
  label?: string;
  name?: string;
  enabled?: boolean;
}

interface Persona {
  id: string;
  name?: string;
  tagline?: string;
  avatar?: string;
  tts?: { engine?: string; voice?: string };
}

interface Schedule {
  [day: number]: (string | null)[];
}

interface FormState {
  shows: Show[];
  schedule: Schedule;
}

interface SettingsResponse {
  values?: {
    shows?: Array<Partial<Show>>;
    schedule?: Schedule;
    personas?: Persona[];
    /** Configured station zone; '' means Auto (use serverTimezone). */
    timezone?: string;
    locale?: StationLocale;
    /** Crossfade-relative floor for a non-zero per-show cap (server-computed). */
    minTrackSeconds?: number;
  };
  /** Effective zone when timezone is '' (Auto) — the container's own TZ. */
  serverTimezone?: string;
  tts?: { moods?: string[] };
}


interface NowCardProps {
  label: string;
  accent?: boolean;
  slotHour: number;
  show: Show | null;
  color: string;
  personaLabel: string;
}

function NowCard({ label, accent, slotHour, show, color, personaLabel }: NowCardProps) {
  const swatchRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(swatchRef, { background: color });
  return (
    <div className="grid gap-1.5 border-l border-separator-strong p-3.5">
      <div className="flex items-center gap-1.5">
        <Eyebrow className={accent ? 'text-vermilion' : 'text-muted'}>{label}</Eyebrow>
        <span className="caption ml-auto">
          {String(slotHour).padStart(2, '0')}:00
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        {show && <span ref={swatchRef} className="inline-block size-4 shrink-0" />}
        <span
          className={cn(
            'text-[16px] font-extrabold tracking-[-0.01em]',
            show ? 'text-ink' : 'text-muted',
          )}
        >
          {show ? show.name : '(no show, autonomous)'}
        </span>
      </div>
      <div className="text-[11px] text-muted">
        {show
          ? <>persona · {personaLabel} · mood · {show.moods.length ? show.moods.join(', ') : 'any'}{showFilterSummary(show)}</>
          : 'station runs on its own picker'}
      </div>
    </div>
  );
}

// Compact " · genre · 80s · high" suffix for the show summary lines, omitting
// whatever the show doesn't pin. Strict filters are flagged inline so the hard
// lock is visible at a glance.
function showFilterSummary(s: { moods: string[]; genres: string[]; eras: EraWindow[]; energies: string[]; filtersStrict?: boolean; maxTrackSeconds?: number | null; playlistIds?: string[]; playlistStrict?: boolean; excludedPlaylistIds?: string[] }): string {
  const len = s.maxTrackSeconds == null ? '' : s.maxTrackSeconds === 0 ? 'any length' : `≤${s.maxTrackSeconds}s`;
  const nPl = s.playlistIds?.length ?? 0;
  const playlist = nPl ? `${nPl} playlist${nPl > 1 ? 's' : ''}${s.playlistStrict ? ' (strict)' : ''}` : '';
  const nEx = s.excludedPlaylistIds?.length ?? 0;
  const excluded = nEx ? `${nEx} excluded` : '';
  // The strict chip covers every music filter (mood included) — only shown when
  // there's actually a filter for it to bite on.
  const strict = s.filtersStrict && (s.moods.length || s.genres.length || s.energies.length || s.eras.length)
    ? 'strict filters' : '';
  const bits = [
    s.genres.join(', '),
    s.eras.map(eraLabelOf).join(', '),
    s.energies.join(', '),
    strict, len, playlist, excluded,
  ].filter(Boolean);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

// Toggleable chip row for the multi-select music filters (#929). Selected
// chips invert; unselected ones grey out once the cap is hit. Same visual
// language as the LibraryPanel energy pills.
function ChipRow({ options, selected, onToggle, cap = FILTER_VALUES_MAX }: {
  options: { key: string; label: string }[];
  selected: string[];
  onToggle: (key: string) => void;
  cap?: number;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(o => {
        const on = selected.includes(o.key);
        const atCap = !on && selected.length >= cap;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            disabled={atCap}
            onClick={() => onToggle(o.key)}
            className={cn(
              'border border-ink px-2 py-0.5 text-[12px]',
              on ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
              atCap && 'cursor-not-allowed opacity-40',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 's_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Hydrate a raw/partial show (from GET /settings or a community install
// response) into a fully-defaulted Show. Kept in one place so the initial load
// and the community install share the exact same legacy-field coercion (#929).
function hydrateShow(s: Partial<Show>): Show {
  return {
    id: s.id ?? clientMintId(),
    name: s.name ?? '',
    topic: s.topic ?? '',
    personaId: s.personaId ?? '',
    guestPersonaIds: Array.isArray(s.guestPersonaIds) ? s.guestPersonaIds : [],
    banter: s.banter ?? false,
    // Plural lists are canonical (#929); a legacy singular field from a stale
    // response still hydrates as a one-element list.
    moods: Array.isArray(s.moods) ? s.moods : (s as { mood?: string }).mood ? [(s as { mood?: string }).mood!] : [],
    themeId: s.themeId ?? '',
    genres: Array.isArray(s.genres) ? s.genres : (s as { genre?: string }).genre ? [(s as { genre?: string }).genre!] : [],
    eras: Array.isArray(s.eras) ? s.eras : (() => {
      const { fromYear = null, toYear = null } = s as { fromYear?: number | null; toYear?: number | null };
      return fromYear != null || toYear != null ? [{ fromYear, toYear }] : [];
    })(),
    energies: Array.isArray(s.energies) ? s.energies : (s as { energy?: string }).energy ? [(s as { energy?: string }).energy!] : [],
    filtersStrict: s.filtersStrict ?? false,
    maxTrackSeconds: s.maxTrackSeconds ?? null,
    playlistIds: Array.isArray(s.playlistIds) ? s.playlistIds : [],
    playlistStrict: s.playlistStrict ?? false,
    excludedPlaylistIds: Array.isArray(s.excludedPlaylistIds) ? s.excludedPlaylistIds : [],
    programme: s.programme ?? false,
    segmentSkill: s.segmentSkill ?? '',
  };
}

function emptyWeek(): Schedule {
  const w: Schedule = {};
  for (let d = 0; d < 7; d++) w[d] = Array(24).fill(null);
  return w;
}

function abbrev(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

function showValid(s: Show): boolean {
  // mood is deliberately not required — '' means "Any" (autonomous mood).
  return s.name.trim().length >= 1 && s.name.trim().length <= NAME_MAX
    && !!s.personaId && s.topic.trim().length <= TOPIC_MAX;
}

// At least one music filter set — the Strict filter toggle only means
// something when there's a filter for it to harden.
function hasAnyMusicFilter(s: Show): boolean {
  return !!(s.moods.length || s.genres.length || s.energies.length || s.eras.length);
}

// The wire shape for one show — trimmed + the "only-means-something-with"
// conditionals the server also enforces. Shared by the editor's Save show
// (POST /shows) and the community install path so they stay identical.
function showPayload(s: Show) {
  return {
    id: s.id,
    name: s.name.trim(),
    topic: s.topic.trim(),
    personaId: s.personaId,
    // The host can be switched after guests were picked; the server rejects a
    // guest that duplicates the host, so filter it here too.
    guestPersonaIds: (s.guestPersonaIds || []).filter(id => id !== s.personaId),
    // Banter only means something with guests in the studio.
    banter: (s.guestPersonaIds?.length ?? 0) > 0 && s.banter,
    moods: s.moods,
    themeId: s.themeId || '',
    genres: s.genres.map(g => g.trim()).filter(Boolean),
    eras: s.eras,
    energies: s.energies,
    // Strict only means something with at least one music filter set.
    filtersStrict: hasAnyMusicFilter(s) && s.filtersStrict,
    maxTrackSeconds: s.maxTrackSeconds,
    playlistIds: s.playlistIds || [],
    // Strict only means something with at least one playlist pinned.
    playlistStrict: (s.playlistIds?.length ?? 0) > 0 && s.playlistStrict,
    excludedPlaylistIds: s.excludedPlaylistIds || [],
    programme: s.programme ?? false,
    // A skill pin only means something in programme mode.
    segmentSkill: s.programme ? (s.segmentSkill || '') : '',
  };
}

export default function ShowsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brush, setBrush] = useState<string | 'erase' | null>(null);
  const [now, setNow] = useState(() => new Date());
  // Community show catalog + install state (best-effort; null = still loading).
  const [community, setCommunity] = useState<CommunityShow[] | null>(null);
  const [communityOpen, setCommunityOpen] = useState(false);          // catalog modal open?
  const [installing, setInstalling] = useState<string | null>(null);  // community slug installing, or null

  // Inline editor: `focusIdx` is the show open in the editor below the list
  // (null = none open). Shows are edited in place — no modal, no draft copy;
  // edits land straight on `form.shows[focusIdx]` and persist on Save show.
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  // id of a freshly-added show — the AI-draft field shows only while creating.
  const [creatingId, setCreatingId] = useState<string | null>(null);
  // The editor block, scrolled into view when a show is opened (add / edit) so
  // the operator actually sees it — it stacks below the list and would else be
  // off-screen. The flag gates the scroll to deliberate opens (not re-renders).
  const editorRef = useRef<HTMLDivElement | null>(null);
  const scrollToEditorRef = useRef(false);
  // Index of the show pending a delete-confirm (null = no dialog open). Both the
  // list ✕ and the editor's Remove route through it so deletes need confirming.
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  // Open-state for the "clear the whole week" confirm — wiping every painted
  // cell is destructive enough to gate behind a yes/no.
  const [confirmClearWeek, setConfirmClearWeek] = useState(false);
  // Theme list for the per-show override dropdown. Public endpoint, no auth
  // needed — same source the player ThemeBootstrap reads.
  const [themes, setThemes] = useState<ThemeOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [activeThemeId, setActiveThemeId] = useState('');
  // Library genres for the show genre autocomplete. Admin-gated endpoint, so it
  // runs after sign-in; failures are silent (the field still accepts free text).
  const [genres, setGenres] = useState<string[]>([]);
  // Navidrome playlists for the per-show playlist-anchor picker. Admin-gated;
  // failures are silent (the picker just shows no options to choose from).
  const [playlists, setPlaylists] = useState<{ id: string; name: string; songCount: number | null }[]>([]);

  // Drag-paint stroke: { active, value } — value is the showId/null painted
  // for the whole stroke, decided on mousedown so a drag doesn't flicker.
  const strokeRef = useRef<{ active: boolean; value: string | null | undefined }>({
    active: false,
    value: undefined,
  });
  // Pending touch press — a finger is down on a cell but the gesture hasn't
  // resolved yet into tap (release early), paint (hold HOLD_MS) or scroll
  // (drift past PRESS_SLOP_PX). Nothing is painted until it resolves, so a
  // scroll that merely starts on a cell can never toggle it.
  const pressRef = useRef<{
    day: number; hour: number; x: number; y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Detach for the grid's non-passive touchmove listener (set by the callback
  // ref below when the grid mounts/unmounts).
  const gridTouchMoveCleanup = useRef<(() => void) | null>(null);
  // Latest extendStroke for the once-attached touchmove listener.
  const extendStrokeRef = useRef<(day: number, hour: number) => void>(() => {});

  // Live clock — the grid highlights the cell the station is in right now.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // The grid + the controller both interpret the schedule in the station's
  // zone (configured, or the container's own when Auto), so the "now" cell must
  // be derived in that zone too — not the operator's browser zone (issue #418).
  const stationTz = data?.values?.timezone || data?.serverTimezone;
  const stationLocale = normalizeStationLocale(data?.values?.locale);
  const { dow: nowDay, hour: nowHour } = zonedDayHour(now, stationTz);

  // End any drag-paint stroke when the pointer is released anywhere. A
  // touchcancel (OS took the gesture — notification shade, browser nav) also
  // discards any pending press so no stray paint lands after the fact.
  useEffect(() => {
    const end = () => { strokeRef.current.active = false; };
    const cancel = () => {
      strokeRef.current.active = false;
      if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null; }
    };
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', cancel);
    return () => {
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', cancel);
      cancel();
    };
  }, []);

  // When a show is opened (add / Edit click sets the flag), bring the editor
  // into view. Guarded by scrollToEditorRef so unrelated re-renders don't yank.
  useEffect(() => {
    if (!scrollToEditorRef.current) return;
    scrollToEditorRef.current = false;
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusIdx]);

  const load = async (): Promise<SettingsResponse | null> => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return null;
      const j = (await r.json()) as SettingsResponse;
      setData(j); setErr(null);
      return j;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    (async () => {
      const j = await load();
      if (j?.values) {
        const week = emptyWeek();
        const sched: Schedule | Record<string, (string | null)[]> = j.values.schedule || {};
        for (let d = 0; d < 7; d++) {
          const day = (sched as Record<number, (string | null)[] | undefined>)[d];
          if (Array.isArray(day)) for (let h = 0; h < 24; h++) week[d]![h] = day[h] ?? null;
        }
        const shows: Show[] = (j.values.shows || []).map(hydrateShow);
        setForm({ shows, schedule: week });
        // Arm the first valid show as the brush so the grid is paintable at once.
        const firstValid = shows.find(showValid);
        if (firstValid) setBrush(b => b ?? firstValid.id);
      }
    })();
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the skill catalogue once for the programme feature-segment pin.
  // Admin endpoint, so it waits for sign-in. Failures are silent: the picker
  // just shows "Producer's choice" with no pin options.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/dj/skills');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { skills?: SkillOption[] };
        if (Array.isArray(j.skills)) setSkills(j.skills.filter(s => s.enabled !== false));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the theme list once for the per-show override dropdown. Public
  // endpoint — runs even before sign-in. Failures are silent: the picker
  // just shows "Station default" with no override choices.
  useEffect(() => {
    if (!hydrated) return;
    const API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/themes`);
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { themes?: ThemeOption[]; active?: string };
        if (Array.isArray(j.themes)) setThemes(j.themes);
        if (typeof j.active === 'string') setActiveThemeId(j.active);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated]);

  // Fetch library genres once for the show genre autocomplete (admin-gated).
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/library/genres');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { genres?: { value: string }[] };
        if (Array.isArray(j.genres)) setGenres(j.genres.map(g => g.value).filter(Boolean));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch Navidrome playlists once for the show playlist-anchor picker (admin-gated).
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/dj/playlists');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { results?: { id: string; name: string; songCount: number | null }[] };
        if (Array.isArray(j.results)) setPlaylists(j.results);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the community show catalog once for the browse-and-install modal.
  // Best-effort like the other catalogs — any failure just leaves it empty so
  // the Community button stays enabled and shows the empty state.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/shows/community');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as { community?: CommunityShow[] };
        if (!cancelled) setCommunity(Array.isArray(j.community) ? j.community : []);
      } catch {
        if (!cancelled) setCommunity([]);
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  const personas: Persona[] = data?.values?.personas || [];
  const moods: string[] = data?.tts?.moods || [];
  const apiBase = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
  const colorOf = (showId: string | null | undefined): string => {
    const idx = form && showId ? form.shows.findIndex(s => s.id === showId) : -1;
    return idx >= 0 ? (SHOW_COLORS[idx % SHOW_COLORS.length] ?? 'transparent') : 'transparent';
  };
  const showById = (id: string | null | undefined): Show | null =>
    (id && form?.shows.find(s => s.id === id)) || null;
  const personaName = (id: string): string => personas.find(p => p.id === id)?.name || '—';

  // ── inline show editor ─────────────────────────────────────────────────
  // Edits land straight on the show in form state (no draft) — same live-edit
  // model as PersonasPanel. Trimming/cleaning happens once, at Save show.
  const setShow = (i: number, patch: Partial<Show>) =>
    setForm(f => f ? ({ ...f, shows: f.shows.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }) : f);

  // Open an existing show in the editor below the list, scrolling it into view.
  const focusShow = (i: number) => { scrollToEditorRef.current = true; setCreatingId(null); setFocusIdx(i); };

  // Append a fresh show (persona + mood pre-filled, name blank so it reads as
  // incomplete until named) and open it for editing.
  const addShow = () => {
    if (!form || form.shows.length >= SHOWS_MAX || personas.length === 0) return;
    const id = clientMintId();
    const newIdx = form.shows.length;
    setForm(f => {
      if (!f) return f;
      if (f.shows.length >= SHOWS_MAX) return f;
      return {
        ...f,
        shows: [...f.shows, {
          id, name: '', topic: '',
          personaId: personas[0]?.id || '', guestPersonaIds: [], banter: false, moods: [],
          themeId: '', genres: [], eras: [], energies: [],
          filtersStrict: false, maxTrackSeconds: null,
          playlistIds: [], playlistStrict: false, excludedPlaylistIds: [],
          programme: false, segmentSkill: '',
        }],
      };
    });
    // arm the new show as the brush if nothing is armed yet
    setBrush(b => b ?? id);
    scrollToEditorRef.current = true;
    setCreatingId(id);
    setFocusIdx(newIdx);
    notify.ok('New show added — give it a name and a persona, then Save show.');
  };

  const removeShow = async (i: number) => {
    if (!form) return;
    const target = form.shows[i];
    if (!target) return;
    // Persist the delete immediately — on its own, not waiting for Save schedule.
    // The server removes the show and unschedules it from the grid in one update.
    // A 404 means it's a locally-added show never saved server-side, so the local
    // splice below is all that's needed.
    try {
      const r = await adminFetch(`/shows/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `failed (${r.status})`);
      }
    } catch (e) {
      notify.err(`Delete failed: ${errorMessage(e)}`);
      return;
    }
    // Remove locally + clear the show from the grid, preserving any unsaved edits
    // to other shows. Splice by id (not index) since the await may have elapsed.
    setForm(f => {
      if (!f) return f;
      const week: Schedule = JSON.parse(JSON.stringify(f.schedule));
      for (let d = 0; d < 7; d++)
        for (let h = 0; h < 24; h++)
          if (week[d]![h] === target.id) week[d]![h] = null;
      return { ...f, shows: f.shows.filter(sh => sh.id !== target.id), schedule: week };
    });
    if (brush === target.id) setBrush(null);
    // Keep the editor focus aligned with the shifted list: close it if the open
    // show was removed, decrement if an earlier one was.
    setFocusIdx(cur => (cur == null ? cur : cur === i ? null : cur > i ? cur - 1 : cur));
    notify.ok(`Deleted “${target.name.trim() || 'show'}”.`);
  };

  // Install a community show: the controller appends it to the persisted show
  // list (unscheduled, owned by the active persona) and returns { shows, show }.
  // We append the returned show to the local form — mapped through the same
  // hydrateShow as the initial load — so any unsaved edits to other shows
  // survive, then arm it as the paint brush and nudge the operator to schedule.
  const install = async (slug: string) => {
    setInstalling(slug);
    try {
      const r = await adminFetch(`/shows/community/${encodeURIComponent(slug)}/install`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; shows?: Array<Partial<Show>>; show?: Partial<Show> | null };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const added = j.show ? hydrateShow(j.show) : null;
      if (added) {
        setForm(f => f ? { ...f, shows: [...f.shows, added] } : f);
        // Arm the new show as the brush if nothing is armed yet, so the grid is
        // paintable at once — same as addShow.
        setBrush(b => b ?? added.id);
      }
      const host = added?.personaId ? personaName(added.personaId) : 'your active DJ';
      notify.ok(`Installed “${added?.name || slug}” — added unscheduled with ${host} as host. Assign a persona/guests, then paint it into the week.`);
    } catch (e) {
      notify.err(`Install failed: ${errorMessage(e)}`);
    } finally { setInstalling(null); }
  };

  // ── grid helpers ─────────────────────────────────────────────────────────
  const setCell = (day: number, hour: number, value: string | null) =>
    setForm(f => {
      if (!f) return f;
      if (f.schedule[day]![hour] === value) return f;
      const week: Schedule = { ...f.schedule, [day]: f.schedule[day]!.slice() };
      week[day]![hour] = value;
      return { ...f, schedule: week };
    });

  // The value a stroke paints: erase brush → null; clicking a cell that already
  // holds the brush → null (toggle off); otherwise the brushed show id.
  const strokeValueFor = (day: number, hour: number): string | null => {
    if (brush === 'erase' || brush == null) return null;
    return form && form.schedule[day]![hour] === brush ? null : brush;
  };
  const beginStroke = (day: number, hour: number) => {
    if (brush == null) return;
    const v = strokeValueFor(day, hour);
    strokeRef.current = { active: true, value: v };
    setCell(day, hour, v);
  };
  const extendStroke = (day: number, hour: number) => {
    if (!strokeRef.current.active) return;
    setCell(day, hour, strokeRef.current.value ?? null);
  };

  // Fill a whole day (row) or hour (column). Toggles: if every target cell
  // already holds the brush, clear them instead.
  const fillDay = (day: number) => {
    if (brush == null) return;
    setForm(f => {
      if (!f) return f;
      const cells = f.schedule[day]!;
      const allSet = brush !== 'erase' && cells.every(c => c === brush);
      const v = brush === 'erase' || allSet ? null : brush;
      return { ...f, schedule: { ...f.schedule, [day]: Array(24).fill(v) } };
    });
  };
  const fillHour = (hour: number) => {
    if (brush == null) return;
    setForm(f => {
      if (!f) return f;
      const allSet = brush !== 'erase'
        && DAYS.every(({ key }) => f.schedule[key]![hour] === brush);
      const v = brush === 'erase' || allSet ? null : brush;
      const week: Schedule = {};
      for (let d = 0; d < 7; d++) {
        week[d] = f.schedule[d]!.slice();
        week[d]![hour] = v;
      }
      return { ...f, schedule: week };
    });
  };
  const clearWeek = () => setForm(f => f ? ({ ...f, schedule: emptyWeek() }) : f);

  // ── touch paint (long-press to arm; see HOLD_MS above) ──────────────────
  const clearPress = () => {
    if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null; }
  };
  // Finger down on a cell: don't paint yet — start the hold timer. If it
  // fires (finger still down, within slop) the stroke arms from this cell and
  // the touchmove listener below takes over.
  const onCellTouchStart = (day: number, hour: number, e: TouchEvent<HTMLButtonElement>) => {
    clearPress();
    if (brush == null || e.touches.length > 1) return;
    const t = e.touches[0];
    if (!t) return;
    const timer = setTimeout(() => {
      pressRef.current = null;
      beginStroke(day, hour);
      navigator.vibrate?.(10);
    }, HOLD_MS);
    pressRef.current = { day, hour, x: t.clientX, y: t.clientY, timer };
  };
  // Finger up before the hold timer fired and without drifting → a tap:
  // toggle just that cell, committed on release so scrolls never toggle.
  // preventDefault() stops the browser's compatibility mousedown that follows
  // touchend — it would re-enter beginStroke and toggle the cell right back.
  const onCellTouchEnd = (e: TouchEvent<HTMLButtonElement>) => {
    const press = pressRef.current;
    if (press) {
      clearPress();
      if (e.cancelable) e.preventDefault();
      beginStroke(press.day, press.hour);
      strokeRef.current.active = false;
    } else if (strokeRef.current.active) {
      // End of a long-press paint stroke — same synthetic-mouse suppression;
      // the window touchend listener clears the stroke itself.
      if (e.cancelable) e.preventDefault();
    }
  };
  extendStrokeRef.current = extendStroke;
  // Touch drag — translate the moving touch point into a grid cell. Attached
  // imperatively with passive:false because React registers root touchmove
  // listeners passively, which silently ignores preventDefault() — the pan
  // and the paint used to run at once, spraying cells while scrolling. A
  // callback ref (not an effect) because the grid only mounts once /settings
  // has loaded. The handler reads refs only, so the [] memo is safe.
  const gridScrollRef = useCallback((el: HTMLDivElement | null) => {
    gridTouchMoveCleanup.current?.();
    gridTouchMoveCleanup.current = null;
    if (!el) return;
    const onMove = (e: globalThis.TouchEvent) => {
      const t = e.touches[0];
      const press = pressRef.current;
      if (press) {
        // Still deciding: a drift past the slop means it's a scroll — drop
        // the press and let the browser pan natively (no preventDefault).
        if (!t || e.touches.length > 1
          || Math.abs(t.clientX - press.x) > PRESS_SLOP_PX
          || Math.abs(t.clientY - press.y) > PRESS_SLOP_PX) {
          clearTimeout(press.timer);
          pressRef.current = null;
        }
        return;
      }
      if (!strokeRef.current.active || !t) return;
      e.preventDefault(); // stroke armed: suppress the pan, paint instead
      const cell = document.elementFromPoint(t.clientX, t.clientY)
        ?.closest?.('[data-cell]') as HTMLElement | null;
      if (cell) extendStrokeRef.current(Number(cell.dataset.day), Number(cell.dataset.hour));
    };
    el.addEventListener('touchmove', onMove, { passive: false });
    gridTouchMoveCleanup.current = () => el.removeEventListener('touchmove', onMove);
  }, []);

  // ── validation ───────────────────────────────────────────────────────────
  const scheduledHours = form
    ? Object.values(form.schedule).flat().filter(Boolean).length : 0;
  const countHours = (id: string): number => form
    ? Object.values(form.schedule).flat().filter(c => c === id).length : 0;

  // ── now / up next / after that — derived from the live schedule ──────────
  const slotAhead = (offset: number): { day: number; hour: number; showId: string | null } => {
    let d = nowDay, h = nowHour, seen = 0, hopped = 0;
    while (seen < offset && hopped < 168) {
      const cur = form?.schedule?.[d]?.[h] ?? null;
      h++; if (h > 23) { h = 0; d = (d + 1) % 7; }
      hopped++;
      const nxt = form?.schedule?.[d]?.[h] ?? null;
      if (nxt !== cur) seen++;
    }
    return { day: d, hour: h, showId: form?.schedule?.[d]?.[h] ?? null };
  };

  // Persist ONE show (add or edit) via POST /shows — independent of any other
  // unsaved / half-finished show in the panel. Only requires THIS show to be
  // valid. On success we swap the local entry for the server's normalized copy
  // (same id — a client-minted s_ id is kept server-side), so unsaved edits to
  // other shows survive.
  const saveShow = async (s: Show): Promise<boolean> => {
    if (!showValid(s)) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/shows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show: showPayload(s) }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; show?: Partial<Show> | null };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const saved = j.show ? hydrateShow(j.show) : null;
      if (saved) setForm(f => f ? { ...f, shows: f.shows.map(x => (x.id === s.id ? saved : x)) } : f);
      notify.ok('Show saved.');
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  // Persist ONLY the weekly grid via PUT /schedule — the "Save schedule" button
  // writes the schedule and nothing else. Slots pointing at a show that isn't
  // saved yet are dropped server-side (reported as `dropped`), so a half-defined
  // show never blocks saving the schedule.
  const saveSchedule = async (): Promise<boolean> => {
    if (!form) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: form.schedule }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; dropped?: number };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(j.dropped
        ? `Schedule saved — ${j.dropped} slot(s) skipped (unsaved shows). The current hour applies on the next pick.`
        : 'Schedule saved — the current hour applies on the next pick.');
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  // ── error / loading shells ───────────────────────────────────────────────
  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="weekly grid">
          <div className="text-[13px] text-[var(--danger)]">controller error: {err}</div>
        </Card>
      </div>
    );
  }
  if (!form) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="weekly grid">
          <div className="text-[13px] text-muted italic">loading…</div>
        </Card>
      </div>
    );
  }

  const validBrushes = form.shows.filter(showValid);
  const nowShow = showById(form.schedule[nowDay]?.[nowHour] ?? null);
  const upNext = slotAhead(1);
  const after = slotAhead(2);
  const upNextShow = upNext.showId ? showById(upNext.showId) : null;
  const afterShow = after.showId ? showById(after.showId) : null;
  // The show open in the inline editor. focusIdx can briefly point past the end
  // after a removal — coerce an out-of-range index to "nothing open".
  const focused = focusIdx != null ? (form.shows[focusIdx] ?? null) : null;

  return (
    <div className="grid gap-4">
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-4 border-b border-ink p-4">
          <div>
            <div className="flex flex-wrap items-baseline gap-2.5">
              <Eyebrow className="text-vermilion">shows · weekly grid</Eyebrow>
              <span className="mono-num text-[12px] font-bold tracking-[0.04em] text-ink">
                {now.toLocaleDateString(stationLocale, {
                  weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
                  timeZone: stationTz || undefined,
                })}
                {' · '}
                {fmtClock(now.getTime(), stationTz, stationLocale)}
                {stationTz ? ` · ${stationTz}` : ''}
              </span>
            </div>
            <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
              Programme the week, one hour at a time.
            </div>
            <div className="mt-1 text-[11px] text-muted">
              Empty hours run autonomously. Each show owns a persona and a mood.
              {' '}Changes apply live on save.
            </div>
          </div>
          <Metric n={String(scheduledHours)} l="hours scheduled" />
        </div>

        {/* Now / Up next / After that strip */}
        <div className="stack-mobile grid grid-cols-3 border-b border-separator-strong">
          <NowCard label="On air" accent slotHour={nowHour} show={nowShow}
            color={colorOf(form.schedule[nowDay]?.[nowHour])}
            personaLabel={nowShow ? personaName(nowShow.personaId) : ''} />
          <NowCard label="Up next" slotHour={upNext.hour} show={upNextShow}
            color={colorOf(upNext.showId)}
            personaLabel={upNextShow ? personaName(upNextShow.personaId) : ''} />
          <NowCard label="After that" slotHour={after.hour} show={afterShow}
            color={colorOf(after.showId)}
            personaLabel={afterShow ? personaName(afterShow.personaId) : ''} />
        </div>
      </section>

      {personas.length === 0 && (
        <Card title="Personas required" sub="setup">
          <div className="text-[13px] text-[var(--danger)]">
            No personas defined. Create one under Personas first.
          </div>
        </Card>
      )}

      {/* ── WEEKLY SCHEDULE GRID ─────────────────────────────────────────── */}
      <Card
        title="Weekly schedule"
        sub="Mon–Sun · 24h"
        right={
          <span className="flex gap-2">
            <Btn sm tone="accent" onClick={saveSchedule} disabled={busy || !form}>
              {busy ? 'saving…' : 'Save schedule'}
            </Btn>
            <Btn sm onClick={() => setConfirmClearWeek(true)}>Clear week</Btn>
          </span>
        }
      >
        {/* brush picker — colour-swatched, click to arm */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="caption mr-0.5">brush</span>
          {validBrushes.length === 0 && (
            <span className="text-[11px] text-muted italic">
              add a show to start painting
            </span>
          )}
          {validBrushes.map((s) => (
            <BrushButton
              key={s.id}
              active={brush === s.id}
              color={colorOf(s.id)}
              label={s.name.trim() || 'untitled'}
              onClick={() => setBrush(brush === s.id ? null : s.id)}
            />
          ))}
          {validBrushes.length > 0 && (
            <EraseButton
              active={brush === 'erase'}
              onClick={() => setBrush(brush === 'erase' ? null : 'erase')}
            />
          )}
        </div>

        <div
          ref={gridScrollRef}
          className="overflow-x-auto"
          onContextMenu={e => {
            // Long-press opens the context menu on Android — swallow it while
            // a press is resolving or a stroke is being painted.
            if (pressRef.current || strokeRef.current.active) e.preventDefault();
          }}
        >
          <div className="grid min-w-[760px] touch-pan-x grid-cols-[44px_repeat(24,minmax(28px,1fr))] gap-0 select-none">
            <span />
            {HOURS.map(h => (
              <button
                key={h}
                type="button"
                onClick={() => fillHour(h)}
                title={brush == null
                  ? `${String(h).padStart(2, '0')}:00`
                  : `Fill ${String(h).padStart(2, '0')}:00 across all days`}
                className={cn(
                  'mono-num border-none bg-transparent py-1.5 text-center font-[inherit] text-[9px]',
                  h === nowHour ? 'font-bold text-vermilion' : 'text-muted',
                  brush == null ? 'cursor-default' : 'cursor-pointer',
                )}
              >
                {String(h).padStart(2, '0')}
              </button>
            ))}
            {DAYS.map(({ key, label }) => (
              <DayRow
                key={key}
                dayKey={key}
                label={label}
                brush={brush}
                form={form}
                nowDay={nowDay}
                nowHour={nowHour}
                fillDay={fillDay}
                beginStroke={beginStroke}
                extendStroke={extendStroke}
                onCellTouchStart={onCellTouchStart}
                onCellTouchEnd={onCellTouchEnd}
                showById={showById}
                colorOf={colorOf}
              />
            ))}
          </div>
        </div>

        {/* legend */}
        <div className="mt-3.5 flex flex-wrap gap-4 text-[10px] tracking-[0.18em] text-muted uppercase">
          {form.shows.map((s, i) => (
            <LegendItem key={s.id} color={SHOW_COLORS[i % SHOW_COLORS.length] ?? '#000'}>
              {s.name.trim() || 'untitled'}
            </LegendItem>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5">
            <span className="inline-block size-3 border border-separator-strong" />
            autonomous
          </span>
        </div>

        <p className="mt-2.5 text-[11px] leading-[1.5] text-muted">
          Pick a brush, then <b>click or drag</b> across cells to paint — on a
          {' '}touch screen, <b>tap</b> a cell or <b>hold it</b> a moment to start
          {' '}painting (a quick swipe just scrolls). Click a <b>day name</b> to
          {' '}fill that day, or an <b>hour</b> to fill that hour across the week.
          {' '}Painting over a matching cell clears it. The vermilion-ringed cell
          {' '}is the hour on air.
        </p>
      </Card>

      {/* ── SHOW DEFINITIONS ─────────────────────────────────────────────── */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <span className="caption">show definitions · {form.shows.length}/{SHOWS_MAX} shows</span>
        <div className="flex items-center gap-2">
          <Btn
            onClick={() => setCommunityOpen(true)}
            disabled={!community}
            title="Browse and install shows shared by other stations"
          >
            <Users size={14} /> Community
            {community && community.length > 0 && (
              <span className="ml-1 text-vermilion">{community.length}</span>
            )}
          </Btn>
          <Btn
            tone="accent"
            onClick={addShow}
            disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}
          >
            + Add show
          </Btn>
        </div>
      </div>
      {form.shows.length === 0 && (
        <p className="text-[12px] text-muted">
          No shows yet. Add one to start programming the week.
        </p>
      )}

      {form.shows.map((s, i) => {
        const ok = showValid(s);
        const hrs = countHours(s.id);
        const host = personas.find(p => p.id === s.personaId) ?? null;
        const guests = (s.guestPersonaIds || [])
          .map(id => personas.find(p => p.id === id))
          .filter((p): p is Persona => Boolean(p));
        return (
          <ShowDefRow
            key={s.id}
            show={s}
            index={i}
            ok={ok}
            hrs={hrs}
            host={host}
            guests={guests}
            apiBase={apiBase}
            onEdit={() => focusShow(i)}
          />
        );
      })}

      {/* ── INLINE SHOW EDITOR ───────────────────────────────────────────── */}
      {focused && focusIdx != null && (
        <ShowEditor
          key={focused.id}
          show={focused}
          editorRef={editorRef}
          personas={personas}
          moods={moods}
          themes={themes}
          skills={skills}
          activeThemeId={activeThemeId}
          genres={genres}
          playlists={playlists}
          apiBase={apiBase}
          adminFetch={adminFetch}
          minTrackSeconds={data?.values?.minTrackSeconds}
          busy={busy}
          isNew={focused.id === creatingId}
          update={(patch) => setShow(focusIdx, patch)}
          onSave={async () => { if (focused && await saveShow(focused)) setFocusIdx(null); }}
          onClose={() => setFocusIdx(null)}
          onRemove={() => setConfirmDeleteIdx(focusIdx)}
        />
      )}

      {/* ── DELETE CONFIRM ───────────────────────────────────────────────── */}
      <V3AlertDialog
        open={confirmDeleteIdx !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteIdx(null); }}
        title="Delete show"
        description={
          <>
            Remove{' '}
            <b>{confirmDeleteIdx !== null ? (form.shows[confirmDeleteIdx]?.name.trim() || 'this show') : 'this show'}</b>
            ? This deletes it right away and clears it from any scheduled hours.
            You don&apos;t need to Save schedule.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (confirmDeleteIdx !== null) removeShow(confirmDeleteIdx);
          setConfirmDeleteIdx(null);
        }}
      />

      {/* ── CLEAR-WEEK CONFIRM ───────────────────────────────────────────── */}
      <V3AlertDialog
        open={confirmClearWeek}
        onOpenChange={setConfirmClearWeek}
        title="Clear week"
        description={
          <>
            Empty every hour on the grid? Your shows stay defined, but the whole
            week unschedules. Nothing is permanent until you Save schedule.
          </>
        }
        confirmLabel="Clear week"
        cancelLabel="Cancel"
        danger
        onConfirm={() => { clearWeek(); setConfirmClearWeek(false); }}
      />

      {/* ── COMMUNITY CATALOG MODAL ──────────────────────────────────────── */}
      <Modal
        open={communityOpen}
        onOpenChange={setCommunityOpen}
        title="community"
        sub="shows shared by other stations"
        width={640}
        footer={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-[11px] leading-[1.5] text-muted">
              Made a show worth sharing? Submit it to the community catalog — a
              maintainer reviews it, then it ships to every station.
            </span>
            <Btn
              onClick={() => window.open(showSubmitUrl(), '_blank', 'noopener,noreferrer')}
              title="Open a prefilled community submission on GitHub"
            >
              <Share2 size={14} /> Share a show
            </Btn>
          </div>
        }
      >
        <div className="text-[12px] leading-[1.65] text-muted">
          These shows are shared by other stations and ship with SUB/WAVE.
          <strong> Install</strong> adds one to your show list as your own
          editable show — it arrives <strong>unscheduled</strong> with your
          active persona as host, so assign a persona (and any guest co-hosts),
          then paint it into the weekly grid above.
        </div>
        <div className="mt-4 grid gap-3">
          {community && community.length > 0 ? (
            community.map(c => {
              // Shows can't be installed twice — the controller 409s on a name
              // clash — so flag ones already in your list instead of a button.
              const inShows = form.shows.some(
                s => s.name.trim().toLowerCase() === c.name.trim().toLowerCase(),
              );
              const tags = [...c.moods, ...c.genres, ...c.energies].slice(0, 6);
              return (
                <div key={c.slug} className="grid grid-cols-[1fr_auto] items-center gap-4 border border-ink p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-extrabold">{c.name}</span>
                      {c.programme && <Pill className="text-[8px]">programme</Pill>}
                      {c.banter && <Pill className="text-[8px]">banter</Pill>}
                      {c.filtersStrict && <Pill className="text-[8px]">strict filters</Pill>}
                    </div>
                    {c.topic && (
                      <div className="mt-1 line-clamp-3 text-[12px] leading-[1.6] text-muted">{c.topic}</div>
                    )}
                    {tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {tags.map((t, i) => (
                          <Pill key={`${t}-${i}`} className="text-[8px]">{t}</Pill>
                        ))}
                      </div>
                    )}
                    {(c.submittedBy || c.dateAdded) && (
                      <div className="mt-1.5 text-[10px] leading-[1.5] text-muted">
                        {c.submittedBy && (
                          <>
                            by{' '}
                            <a
                              href={`https://github.com/${c.submittedBy}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                            >
                              @{c.submittedBy}
                            </a>
                          </>
                        )}
                        {c.submittedBy && c.dateAdded && ' · '}
                        {c.dateAdded && <>added {c.dateAdded}</>}
                        {c.dateAdded && c.dateModified && c.dateModified !== c.dateAdded && (
                          <> · updated {c.dateModified}</>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {inShows ? (
                      <Pill tone="accent" dot>in your shows</Pill>
                    ) : (
                      <Btn
                        tone="accent"
                        onClick={() => install(c.slug)}
                        disabled={installing === c.slug || form.shows.length >= SHOWS_MAX}
                        title={form.shows.length >= SHOWS_MAX ? 'The show list is full' : undefined}
                      >
                        {installing === c.slug ? 'Installing…' : 'Install'}
                      </Btn>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-6 text-center text-[13px] text-muted italic">
              No community shows yet.
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

// ── inline show editor ─────────────────────────────────────────────────────
// The former modal body, lifted to an in-page editor (the personas pattern).
// Edits are written straight through `update` onto form state; nothing is saved
// here — the page's "Save schedule" persists shows + schedule together. Keyed by
// show id at the call site so switching shows remounts it (resets the AiFill box).
interface ShowEditorProps {
  show: Show;
  editorRef: RefObject<HTMLDivElement | null>;
  personas: Persona[];
  moods: string[];
  themes: ThemeOption[];
  skills: SkillOption[];
  activeThemeId: string;
  genres: string[];
  playlists: { id: string; name: string; songCount: number | null }[];
  apiBase: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  minTrackSeconds?: number;
  busy: boolean;
  isNew: boolean;       // show the AI-draft field only while creating
  update: (patch: Partial<Show>) => void;
  onSave: () => void;   // Save show — persists just this show (POST /shows)
  onClose: () => void;
  onRemove: () => void;
}

function ShowEditor({
  show, editorRef, personas, moods, themes, skills, activeThemeId, genres, playlists, apiBase,
  adminFetch, minTrackSeconds, busy, isNew,
  update, onSave, onClose, onRemove,
}: ShowEditorProps) {
  // Save show gates on THIS show only — other unsaved shows don't block it.
  const valid = showValid(show);
  // Free-text genre being typed before it's added as a chip. The editor is
  // remounted per show (keyed at the call site), so this resets on switch.
  const [genreDraft, setGenreDraft] = useState('');
  const addGenre = (g: string) => {
    const v = g.trim().slice(0, 64);
    if (!v || show.genres.length >= FILTER_VALUES_MAX) return;
    if (show.genres.some(x => x.toLowerCase() === v.toLowerCase())) { setGenreDraft(''); return; }
    update({ genres: [...show.genres, v] });
    setGenreDraft('');
  };
  return (
    <EditorDialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<Eyebrow className="text-vermilion">{isNew ? 'New show' : 'Edit show'}</Eyebrow>}
      sub={<span className="caption truncate">{show.name.trim() || 'define a show'}</span>}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          {/* left — destructive action */}
          <Btn lg tone="danger" onClick={onRemove}>Remove</Btn>
          {/* right — status + close/save */}
          <span className="ml-auto flex items-center gap-3">
            <span
              className={cn(
                'size-1.5 flex-none rounded-full',
                valid ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
              )}
            />
            <span className="text-[11px] text-muted">
              {!valid
                ? <span className="text-[var(--danger)]">this show needs a name and a persona</span>
                : 'saves this show · schedule it on the grid, then Save schedule'}
            </span>
            <Btn lg onClick={onClose}>Close</Btn>
            <Btn lg tone="accent" onClick={onSave} disabled={busy || !valid}>
              {busy ? 'Saving…' : 'Save show'}
            </Btn>
          </span>
        </div>
      }
    >
      <div ref={editorRef} className="grid">
        <Card flat title="Identity" bodyClass="grid gap-3.5">
          {isNew && (
            <AiFill<Partial<Omit<Show, 'personaId' | 'themeId'>> & { personaId?: string | null; themeId?: string | null }>
              endpoint="/generate/show"
              resultKey="show"
              adminFetch={adminFetch}
              placeholder="e.g. a Sunday-morning gospel hour, warm and uplifting"
              onApply={(s) => update({
                ...s,
                personaId: s.personaId ?? show.personaId ?? '',
                themeId: s.themeId ?? '',
              })}
            />
          )}
          <Field>
            <Label htmlFor="show-name">show name</Label>
            <Input
              id="show-name"
              type="text" value={show.name} maxLength={NAME_MAX}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update({ name: e.target.value })}
              placeholder="e.g. The Late Shift"
              className="text-[15px] font-bold"
            />
            <span className="field-hint">{show.name.trim().length}/{NAME_MAX}</span>
          </Field>

          <Field>
            <Label>persona owner</Label>
            <PersonaPicker
              personas={personas}
              value={show.personaId}
              onChange={id => update({
                personaId: id,
                // The new host can't also sit in the guest chairs.
                guestPersonaIds: (show.guestPersonaIds || []).filter(g => g !== id),
              })}
              apiBase={apiBase}
            />
          </Field>

          {personas.length > 1 && (
            <Field>
              <Label>guest co-hosts</Label>
              <GuestPersonaPicker
                personas={personas.filter(p => p.id !== show.personaId)}
                value={show.guestPersonaIds || []}
                onChange={ids => update({ guestPersonaIds: ids })}
                apiBase={apiBase}
                max={GUESTS_MAX}
              />
              <span className="field-hint">
                Optional, up to {GUESTS_MAX}. While this show is on air, guests
                take some of the talk breaks — station IDs, time checks,
                weather/news segments — in their own voice. The host still
                drives the music and the track intros.
              </span>

              <div className="mt-1 flex items-start gap-3">
                <div className="pt-0.5">
                  <Toggle
                    on={show.banter && (show.guestPersonaIds?.length ?? 0) > 0}
                    disabled={(show.guestPersonaIds?.length ?? 0) === 0}
                    onClick={() => update({ banter: !show.banter })}
                  />
                </div>
                <div className="grid gap-0.5">
                  <Label className={(show.guestPersonaIds?.length ?? 0) === 0 ? 'opacity-40' : undefined}>
                    Banter breaks
                  </Label>
                  <span className="field-hint">
                    Short scripted exchanges between the host and guests — a few
                    lines of real back-and-forth, each voice rendered
                    separately — up to twice an hour depending on the
                    persona&apos;s talk frequency. Needs at least one guest.
                  </span>
                </div>
              </div>
            </Field>
          )}

          <Field>
            <div className="flex items-start gap-3">
              <div className="pt-0.5">
                <Toggle
                  on={show.programme}
                  onClick={() => update({ programme: !show.programme })}
                />
              </div>
              <div className="grid gap-0.5">
                <Label>Programme (produced episode)</Label>
                <span className="field-hint">
                  The DJ produces each airing as a coherent episode from the
                  topic brief: an intro at the top of the show, a planned
                  feature segment mid-hour, and a sign-off in the closing
                  minutes — with a fresh angle every episode.
                </span>
              </div>
            </div>
            {show.programme && (
              <div className="mt-2 grid gap-1">
                <Label>feature segment skill</Label>
                <Select
                  value={show.segmentSkill || ANY_SENTINEL}
                  onValueChange={val => update({ segmentSkill: val === ANY_SENTINEL ? '' : val })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ANY_SENTINEL}>Producer&apos;s choice</SelectItem>
                      {skills.map(s => (
                        <SelectItem key={s.kind} value={s.kind}>{s.label || s.name || s.kind}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <span className="field-hint">
                  Optional. Pin the mid-hour feature to one skill — e.g. news
                  for a morning roundup. Producer&apos;s choice lets each
                  episode&apos;s plan decide.
                </span>
              </div>
            )}
          </Field>

          <Field>
            <Label>theme override (applied while this show is on air)</Label>
            <ThemePicker
              themes={themes}
              activeThemeId={activeThemeId}
              value={show.themeId}
              onChange={id => update({ themeId: id })}
            />
            <span className="field-hint">
              Optional. When this show goes on air the player switches to
              this palette; back to the station default when the hour ends.
              Manage themes in admin → Settings → Theme.
            </span>
          </Field>
        </Card>

        <Card flat title="Music" bodyClass="grid gap-3.5">
          <Field>
            <Label>music moods</Label>
            <ChipRow
              options={moods.map(m => ({ key: m, label: m }))}
              selected={show.moods}
              onToggle={m => update({
                moods: show.moods.includes(m)
                  ? show.moods.filter(x => x !== m)
                  : [...show.moods, m],
              })}
            />
            <span className="field-hint">
              Pick any that fit — a track matching any selected mood qualifies.
              None selected = Any (auto): the station&apos;s autonomous mood applies.
            </span>
          </Field>

          <Field>
            <Label>eras</Label>
            <ChipRow
              options={DECADES.map(d => ({ key: d.key, label: d.label }))}
              selected={DECADES.filter(d => show.eras.some(e => sameEra(e, d))).map(d => d.key)}
              onToggle={key => {
                const d = DECADES.find(x => x.key === key)!;
                const existing = show.eras.find(e => sameEra(e, d));
                update({
                  eras: existing
                    ? show.eras.filter(e => e !== existing)
                    : [...show.eras, { fromYear: d.from, toYear: d.to }],
                });
              }}
            />
            {/* Custom windows (set via the API — no preset matches) stay
                visible and removable so they can't silently constrain picks. */}
            {show.eras.some(e => !DECADES.some(d => sameEra(e, d))) && (
              <div className="flex flex-wrap gap-1">
                {show.eras.filter(e => !DECADES.some(d => sameEra(e, d))).map((e, i) => (
                  <button
                    key={`${e.fromYear ?? ''}-${e.toYear ?? ''}-${i}`}
                    type="button"
                    onClick={() => update({ eras: show.eras.filter(x => x !== e) })}
                    className="border border-ink bg-ink px-2 py-0.5 text-[12px] text-bg"
                    title="Remove this custom era window"
                  >
                    {eraLabelOf(e)} ×
                  </button>
                ))}
              </div>
            )}
            <span className="field-hint">
              Pick any decades — non-adjacent ones work ({'"'}90s + 2010s{'"'}).
              None selected = any era.
            </span>
          </Field>

          <Field>
            <Label>energy</Label>
            <ChipRow
              options={ENERGY_OPTIONS.map(e => ({ key: e, label: e }))}
              selected={show.energies}
              onToggle={e => update({
                energies: show.energies.includes(e)
                  ? show.energies.filter(x => x !== e)
                  : [...show.energies, e],
              })}
              cap={ENERGY_OPTIONS.length}
            />
          </Field>

          <Field>
            <Label htmlFor="show-genre">genre leans</Label>
            {show.genres.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {show.genres.map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => update({ genres: show.genres.filter(x => x !== g) })}
                    className="border border-ink bg-ink px-2 py-0.5 text-[12px] text-bg"
                    title="Remove this genre"
                  >
                    {g} ×
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input
                id="show-genre"
                type="text" value={genreDraft} maxLength={64}
                list="show-genre-options"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setGenreDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGenre(genreDraft); } }}
                placeholder={show.genres.length ? 'add another genre' : 'e.g. Jazz (optional)'}
                disabled={show.genres.length >= FILTER_VALUES_MAX}
              />
              <Btn
                onClick={() => addGenre(genreDraft)}
                disabled={!genreDraft.trim() || show.genres.length >= FILTER_VALUES_MAX}
              >
                Add
              </Btn>
            </div>
            <datalist id="show-genre-options">
              {[...genres].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(g => <option key={g} value={g} />)}
            </datalist>
            <span className="field-hint">
              Up to {FILTER_VALUES_MAX}; a track matching any of them qualifies.
            </span>
          </Field>

          <GenreSuggest
            adminFetch={adminFetch}
            value={genreDraft}
            onSelect={addGenre}
          />

          <div className="flex items-start gap-3">
            <div className="pt-0.5">
              <Toggle
                on={show.filtersStrict}
                disabled={!hasAnyMusicFilter(show)}
                onClick={() => update({ filtersStrict: !show.filtersStrict })}
              />
            </div>
            <div className="grid gap-0.5">
              <Label className={!hasAnyMusicFilter(show) ? 'opacity-40' : undefined}>
                Strict filter
              </Label>
              <span className="field-hint">
                Hard-enforce every filter set above — mood, era, energy and
                genre. Off-filter tracks only play as a last resort to avoid
                silence. When off, they&apos;re all soft leans the DJ can break
                for flow. Needs at least one filter set.
              </span>
            </div>
          </div>

          <span className="field-hint -mt-1.5">
            Optional music steer for this show: a mood, a genre, an era, an
            energy band, or any mix. Soft by default — the DJ leans toward them
            but can break them for flow; Strict filter above turns every set
            one into a hard rule. Mood set to Any (auto) follows the
            station&apos;s autonomous mood — time of day, weather, festivals —
            instead of pinning one.
          </span>

          <Field>
            <Label>playlist anchor</Label>
            <span className="field-hint">
              Pin one or more Navidrome playlists: their combined tracks become
              this show&apos;s pool. The AI DJ still sequences and talks over
              them. Pick none to let genre/era/mood drive selection (up to 10).
            </span>
            {playlists.length === 0 ? (
              <span className="field-hint opacity-60">
                No Navidrome playlists found yet — create some in Navidrome and
                reopen this panel.
              </span>
            ) : (
              <div className="grid max-h-44 gap-1 overflow-y-auto border border-ink bg-[var(--ink-softer)] p-2">
                {playlists.map(pl => {
                  const checked = show.playlistIds.includes(pl.id);
                  const atCap = !checked && show.playlistIds.length >= 10;
                  return (
                    <label
                      key={pl.id}
                      className={`flex items-center gap-2 text-sm ${atCap ? 'opacity-40' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={atCap}
                        onChange={() => update({
                          playlistIds: checked
                            ? show.playlistIds.filter(id => id !== pl.id)
                            : [...show.playlistIds, pl.id],
                        })}
                      />
                      <span className="truncate">{pl.name}</span>
                      {pl.songCount != null && (
                        <span className="field-hint">({pl.songCount})</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>

          {show.playlistIds.length > 0 && (
            <div className="flex items-start gap-3">
              <div className="pt-0.5">
                <Toggle
                  on={show.playlistStrict}
                  onClick={() => update({ playlistStrict: !show.playlistStrict })}
                />
              </div>
              <div className="grid gap-0.5">
                <Label>Playlist only (strict)</Label>
                <span className="field-hint">
                  Play ONLY tracks from the pinned playlist(s) — off-playlist
                  tracks air only as a last resort to avoid silence. Off: the
                  playlist dominates but the DJ can still wander for variety.
                  Listener requests are always allowed through, either way.
                </span>
              </div>
            </div>
          )}

          <Field>
            <Label>excluded playlists</Label>
            <span className="field-hint">
              Tracks from these playlists will never play during this show,
              regardless of other filters. Useful for blocking genres or moods
              that don&apos;t fit — add them to a Navidrome playlist and
              exclude it here (up to 10).
            </span>
            {playlists.length === 0 ? (
              <span className="field-hint opacity-60">
                No Navidrome playlists found yet — create some in Navidrome and
                reopen this panel.
              </span>
            ) : (
              <div className="grid max-h-44 gap-1 overflow-y-auto border border-ink bg-[var(--ink-softer)] p-2">
                {playlists.map(pl => {
                  const checked = show.excludedPlaylistIds.includes(pl.id);
                  const atCap = !checked && show.excludedPlaylistIds.length >= 10;
                  return (
                    <label
                      key={pl.id}
                      className={`flex items-center gap-2 text-sm ${atCap ? 'opacity-40' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={atCap}
                        onChange={() => update({
                          excludedPlaylistIds: checked
                            ? show.excludedPlaylistIds.filter(id => id !== pl.id)
                            : [...show.excludedPlaylistIds, pl.id],
                        })}
                      />
                      <span className="truncate">{pl.name}</span>
                      {pl.songCount != null && (
                        <span className="field-hint">({pl.songCount})</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
        </Card>

        <Card flat title="Brief" bodyClass="grid gap-3.5">
          <Field>
            <Label htmlFor="show-topic">topic (fed to the DJ as the show theme)</Label>
            <span className="field-hint">
              This is the brief the AI DJ works from. The more you describe,
              the better it picks music and writes links: name genres, eras,
              moods, artists to lean into or avoid, the time of day, the kind
              of listener, and how the host should sound. Write it like
              you&apos;re briefing a real DJ before their slot.
            </span>
            <Textarea
              id="show-topic"
              rows={7} value={show.topic} maxLength={TOPIC_MAX}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => update({ topic: e.target.value })}
              placeholder="e.g. Slow ambient, modern classical and downtempo for the late shift. Think Nils Frahm, Hammock, Bonobo's quieter side, nothing with a hard beat. Keep the host calm and unhurried, like a friend talking you down at 1am."
            />
            <span className="field-hint">{show.topic.trim().length}/{TOPIC_MAX}</span>
          </Field>

          <Field>
            <Label htmlFor="show-maxlen">max track length (seconds)</Label>
            <Input
              id="show-maxlen"
              type="number"
              min={0}
              max={36000}
              placeholder="inherit"
              value={show.maxTrackSeconds ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value.trim();
                update({ maxTrackSeconds: raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0) });
              }}
            />
            <span className="field-hint">
              The longest a single track plays while this show is on air —
              anything longer fades out at the limit. Leave it blank to use the
              station limit, enter 0 for no limit (good for long mixes or DJ
              sets), or set at least {minTrackSeconds ?? 30}s to
              cap it for this show.
            </span>
          </Field>
        </Card>
      </div>
    </EditorDialog>
  );
}

interface BrushButtonProps {
  active: boolean;
  color: string;
  label: string;
  onClick: () => void;
}

function BrushButton({ active, color, label, onClick }: BrushButtonProps) {
  const swatchRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(swatchRef, { background: color });
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 px-2.5 py-1 font-[inherit] text-[11px] font-bold tracking-[0.02em]',
        active
          ? 'border border-ink bg-ink text-bg'
          : 'border border-separator-strong bg-transparent text-ink',
      )}
    >
      <span
        ref={swatchRef}
        className={cn('size-3 shrink-0', active && 'outline-1 outline-bg')}
      />
      {label}
    </button>
  );
}

interface EraseButtonProps {
  active: boolean;
  onClick: () => void;
}

function EraseButton({ active, onClick }: EraseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 px-2.5 py-1 font-[inherit] text-[11px] font-bold tracking-[0.02em]',
        active
          ? 'border border-ink bg-ink text-bg'
          : 'border border-separator-strong bg-transparent text-muted',
      )}
    >
      <span className="inline-block size-3 shrink-0 border border-current bg-[repeating-linear-gradient(45deg,currentColor_0_2px,transparent_2px_4px)]" />
      Erase
    </button>
  );
}

interface LegendItemProps {
  color: string;
  children?: React.ReactNode;
}

function LegendItem({ color, children }: LegendItemProps) {
  const swatchRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(swatchRef, { background: color });
  return (
    <span className="inline-flex items-center gap-1.5">
      <span ref={swatchRef} className="inline-block size-3" />
      {children}
    </span>
  );
}

interface DayRowProps {
  dayKey: number;
  label: string;
  brush: string | 'erase' | null;
  form: FormState;
  nowDay: number;
  nowHour: number;
  fillDay: (day: number) => void;
  beginStroke: (day: number, hour: number) => void;
  extendStroke: (day: number, hour: number) => void;
  onCellTouchStart: (day: number, hour: number, e: TouchEvent<HTMLButtonElement>) => void;
  onCellTouchEnd: (e: TouchEvent<HTMLButtonElement>) => void;
  showById: (id: string | null | undefined) => Show | null;
  colorOf: (id: string | null | undefined) => string;
}

function DayRow({
  dayKey, label, brush, form, nowDay, nowHour,
  fillDay, beginStroke, extendStroke, onCellTouchStart, onCellTouchEnd,
  showById, colorOf,
}: DayRowProps) {
  return (
    <>
      <button
        type="button"
        onClick={() => fillDay(dayKey)}
        title={brush == null ? label : `Fill ${label} with the current brush`}
        className={cn(
          'self-stretch border-none bg-transparent px-2 text-right font-[inherit] text-[10px] font-bold tracking-[0.2em] uppercase',
          dayKey === nowDay ? 'text-vermilion' : 'text-ink',
          brush == null ? 'cursor-default' : 'cursor-pointer',
        )}
      >
        {label}
      </button>
      {HOURS.map(h => {
        const showId = form.schedule[dayKey]?.[h] ?? null;
        const show = showId ? showById(showId) : null;
        const isNow = dayKey === nowDay && h === nowHour;
        return (
          <GridCell
            key={h}
            day={dayKey}
            hour={h}
            label={label}
            show={show}
            color={colorOf(showId)}
            isNow={isNow}
            brush={brush}
            onMouseDown={() => beginStroke(dayKey, h)}
            onMouseEnter={() => extendStroke(dayKey, h)}
            onTouchStart={e => onCellTouchStart(dayKey, h, e)}
            onTouchEnd={onCellTouchEnd}
          />
        );
      })}
    </>
  );
}

interface GridCellProps {
  day: number;
  hour: number;
  label: string;
  show: Show | null;
  color: string;
  isNow: boolean;
  brush: string | 'erase' | null;
  onMouseDown: () => void;
  onMouseEnter: () => void;
  onTouchStart: (e: TouchEvent<HTMLButtonElement>) => void;
  onTouchEnd: (e: TouchEvent<HTMLButtonElement>) => void;
}

function GridCell({
  day, hour, label, show, color, isNow, brush,
  onMouseDown, onMouseEnter, onTouchStart, onTouchEnd,
}: GridCellProps) {
  const cellRef = useRef<HTMLButtonElement>(null);
  useDynamicStyle(cellRef, {
    background: show ? color : 'transparent',
  });
  return (
    <button
      type="button"
      ref={cellRef}
      data-cell=""
      data-day={day}
      data-hour={hour}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      title={
        (show ? `${show.name}${show.moods.length ? ` (${show.moods.join(', ')})` : ''}` : `${label} ${String(hour).padStart(2, '0')}:00, empty`)
        + (isNow ? ' · on air now' : '')
      }
      className={cn(
        'relative -mt-px -ml-px flex h-8 items-center justify-center border border-separator-strong p-0 font-[inherit] text-[9px] font-bold tracking-[0.15em] uppercase [-webkit-touch-callout:none]',
        show ? 'text-white' : 'text-muted',
        brush == null ? 'cursor-default' : 'cursor-pointer',
      )}
    >
      {show ? abbrev(show.name) : ''}
      {isNow && (
        <span className="pointer-events-none absolute -inset-0.5 z-10 border-2 border-[var(--accent)] shadow-[0_0_0_1px_var(--bg)]" />
      )}
      {isNow && (
        <span className="absolute -top-2.5 left-1/2 z-20 -translate-x-1/2 text-[8px] tracking-[0.22em] text-vermilion">
          now
        </span>
      )}
    </button>
  );
}

// A persona avatar — the initials-behind-<img> pattern shared with the show
// pickers (a broken/absent avatar falls back to readable initials). Two sizes:
// 'lg' anchors the host; 'sm' builds the overlapping guest cluster.
function ShowAvatar({
  persona, apiBase, size, className,
}: {
  persona: Persona | null;
  apiBase: string;
  size: 'lg' | 'sm';
  className?: string;
}) {
  const src = persona?.avatar
    ? `${apiBase}/persona-avatar/${encodeURIComponent(persona.id)}`
    : null;
  const name = persona?.name?.trim();
  return (
    <span
      className={cn(
        'relative grid flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]',
        size === 'lg' ? 'size-12' : 'size-6',
        className,
      )}
    >
      <span className={cn('font-extrabold text-muted', size === 'lg' ? 'text-[13px]' : 'text-[8px]')}>
        {name ? abbrev(name) : '—'}
      </span>
      {src && (
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
        />
      )}
    </span>
  );
}

// Grammatical name join: "Kai", "Kai & Rae", "Kai, Rae & Sol".
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

interface ShowDefRowProps {
  show: Show;
  index: number;
  ok: boolean;
  hrs: number;
  host: Persona | null;
  guests: Persona[];
  apiBase: string;
  onEdit: () => void;
}

// One show as a "broadcast slate": a colour spine keyed to the weekly grid, the
// host — and any guest co-hosts overlapping beneath — as faces, mode kickers
// (Programme / Banter), the weekly airtime as a metric, and a scannable row of
// music facets over the DJ brief. The whole card is the edit target (the
// personas "click a show to open it" pattern); Remove lives inside the editor.
function ShowDefRow({ show: s, index: i, ok, hrs, host, guests, apiBase, onEdit }: ShowDefRowProps) {
  const spineRef = useRef<HTMLSpanElement>(null);
  useDynamicStyle(spineRef, { background: SHOW_COLORS[i % SHOW_COLORS.length] ?? '#000' });

  const hostName = host?.name?.trim() || (s.personaId ? 'Unnamed' : '');
  const guestNames = guests.map(g => g.name?.trim() || 'Unnamed');
  const skillPin = s.programme && s.segmentSkill ? s.segmentSkill : '';

  // "What it plays" facets — moods, genres, eras, energies as chips, plus the
  // hard-lock / playlist / length flags. The visual counterpart to the text
  // showFilterSummary() the strip cards still use.
  const facets: { key: string; label: string; accent?: boolean }[] = [];
  if (s.moods.length) s.moods.forEach(m => facets.push({ key: `mood-${m}`, label: m }));
  else facets.push({ key: 'mood-any', label: 'any mood' });
  s.genres.forEach(g => facets.push({ key: `genre-${g}`, label: g }));
  s.eras.forEach((e, idx) => facets.push({ key: `era-${idx}`, label: eraLabelOf(e) }));
  s.energies.forEach(en => facets.push({ key: `energy-${en}`, label: en }));
  if (s.filtersStrict && hasAnyMusicFilter(s)) facets.push({ key: 'strict', label: 'strict', accent: true });
  const nPl = s.playlistIds?.length ?? 0;
  if (nPl) facets.push({ key: 'playlists', label: `${nPl} playlist${nPl > 1 ? 's' : ''}${s.playlistStrict ? ' · strict' : ''}` });
  const nEx = s.excludedPlaylistIds?.length ?? 0;
  if (nEx) facets.push({ key: 'excluded', label: `${nEx} excluded` });
  if (s.maxTrackSeconds != null) {
    facets.push({ key: 'length', label: s.maxTrackSeconds === 0 ? 'any length' : `≤${s.maxTrackSeconds}s` });
  }

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Edit ${s.name.trim() || 'untitled show'}`}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); }
      }}
      className={cn(
        'group card relative cursor-pointer transition-colors hover:bg-[var(--ink-softer)]',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]',
      )}
    >
      {/* colour spine — the same per-show colour the weekly grid paints with */}
      <span
        ref={spineRef}
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1 transition-[width] group-hover:w-1.5"
      />

      <div className="card-body flex gap-3.5">
        {/* faces — host, then any guest co-hosts overlapping beneath, centred */}
        <div className="flex flex-none flex-col items-center">
          <ShowAvatar persona={host} apiBase={apiBase} size="lg" />
          {guests.length > 0 && (
            <div className="mt-1 flex">
              {guests.map((g, gi) => (
                <ShowAvatar
                  key={g.id}
                  persona={g}
                  apiBase={apiBase}
                  size="sm"
                  className={cn('ring-2 ring-[var(--card-bg)]', gi > 0 && '-ml-2')}
                />
              ))}
            </div>
          )}
        </div>

        {/* body */}
        <div className="grid min-w-0 flex-1 gap-2.5">
          <div className="flex items-start gap-3">
            {/* name + roster */}
            <div className="min-w-0 flex-1">
              {(s.programme || (s.banter && guests.length > 0)) && (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {s.programme && (
                    <Pill tone="solid" dot>
                      Programme{skillPin ? ` · ${skillPin}` : ''}
                    </Pill>
                  )}
                  {s.banter && guests.length > 0 && <Pill>Banter</Pill>}
                </div>
              )}
              <div className="truncate text-[17px] font-extrabold tracking-[-0.01em] text-ink">
                {s.name.trim() || 'untitled'}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-muted">
                {host
                  ? <>host · <span className="font-semibold text-ink">{hostName}</span></>
                  : <span className="text-[var(--danger)]">no persona set</span>}
                {guests.length > 0 && <> · with {joinNames(guestNames)}</>}
              </div>
            </div>

            {/* right rail — status, weekly airtime, edit affordance */}
            <div className="flex flex-none flex-col items-end gap-1.5 text-right">
              {!ok && <Pill tone="accent">incomplete</Pill>}
              {hrs > 0 ? (
                <div className="leading-none">
                  <span className="mono-num text-[20px] font-extrabold text-ink">{hrs}</span>
                  <span className="caption ml-1">h / wk</span>
                </div>
              ) : (
                <span className="caption">unscheduled</span>
              )}
              <span className="inline-flex items-center gap-1 text-[10px] font-bold tracking-[0.16em] text-muted uppercase transition-colors group-hover:text-vermilion">
                Edit <span aria-hidden="true">→</span>
              </span>
            </div>
          </div>

          {/* facets — what this show plays */}
          <div className="flex flex-wrap gap-1">
            {facets.map(f => (
              <MetaChip key={f.key} accent={f.accent}>{f.label}</MetaChip>
            ))}
          </div>

          {/* brief */}
          {s.topic.trim() && (
            <p className="line-clamp-2 text-[12px] leading-[1.55] text-muted italic">
              {s.topic.trim()}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
