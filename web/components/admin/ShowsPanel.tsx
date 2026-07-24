'use client';

// Show definitions — /admin/shows. A show is a reusable definition (name,
// topic, owner persona, music moods). When the scheduled hour has a show, its
// persona goes on air, its moods (when set — empty means Any/auto) override
// the autonomous mood, and its topic feeds the DJ.
// An empty hour = the station runs autonomously, as it does today.
//
// Shows are created/edited through an in-page editor (ShowEditor, below the
// show list) — the personas pattern: click a show to open it, edit it in place.
// The weekly plan itself lives on its own full-screen page now — The Rundown
// at /admin/shows/schedule (components/admin/schedule/) — which owns the
// board, the on-air listing, takeovers, and PUT /schedule. This page still
// loads the schedule read-only for the per-show hours-a-week counts.
import type { ChangeEvent, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Users, Share2 } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';
import { notify, errorMessage } from '../../lib/notify';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Field } from '../ui/field';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../ui/select';
import { Button } from '../ui/button';
import { Card, Btn, Pill, Eyebrow, Metric, MetaChip, Toggle } from './ui';
import RosterViewToggle from './RosterViewToggle';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { V3AlertDialog } from '../ui/alert-dialog';
import { EditorDialog } from '../ui/editor-dialog';
import { Modal } from '../ui/modal';
import { AiFill } from './AiFill';
import GenreSuggest from './GenreSuggest';
import { PersonaPicker, GuestPersonaPicker, ThemePicker } from './ShowPickers';
import ShowsTable from './ShowsTable';
import type { ShowFacet, ShowRow } from './ShowsTable';
import { cn } from '../../lib/cn';
import { useRosterView } from '../../lib/adminView';
import { showSubmitUrl } from '../../lib/repo';
import { SHOW_COLORS } from './schedule/lib';

const NAME_MAX = 60;
const TOPIC_MAX = 1000;
const SHOWS_MAX = 64;
// Mirrors the controller's GUESTS_PER_SHOW cap (settings.ts).
const GUESTS_MAX = 3;

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
    /** Crossfade-relative floor for a non-zero per-show cap (server-computed). */
    minTrackSeconds?: number;
  };
  tts?: { moods?: string[] };
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
  // Community show catalog + install state (best-effort; null = still loading).
  const [community, setCommunity] = useState<CommunityShow[] | null>(null);
  const [communityOpen, setCommunityOpen] = useState(false);          // catalog modal open?
  // Show definitions as cards (default) or a dense table. Per-surface pref.
  const [view, setView] = useRosterView('shows');
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
  // Theme list for the per-show override dropdown. Public endpoint, no auth
  // needed — same source the player ThemeProvider reads.
  const [themes, setThemes] = useState<ThemeOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [activeThemeId, setActiveThemeId] = useState('');
  // Library genres for the show genre autocomplete. Admin-gated endpoint, so it
  // runs after sign-in; failures are silent (the field still accepts free text).
  const [genres, setGenres] = useState<string[]>([]);
  // Navidrome playlists for the per-show playlist-anchor picker. Admin-gated;
  // failures are silent (the picker just shows no options to choose from).
  const [playlists, setPlaylists] = useState<{ id: string; name: string; songCount: number | null }[]>([]);
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
      }
      const host = added?.personaId ? personaName(added.personaId) : 'your active DJ';
      notify.ok(`Installed “${added?.name || slug}” — added unscheduled with ${host} as host. Assign a persona/guests, then schedule it on the Rundown.`);
    } catch (e) {
      notify.err(`Install failed: ${errorMessage(e)}`);
    } finally { setInstalling(null); }
  };

  // ── validation ───────────────────────────────────────────────────────────
  const scheduledHours = form
    ? Object.values(form.schedule).flat().filter(Boolean).length : 0;
  const countHours = (id: string): number => form
    ? Object.values(form.schedule).flat().filter(c => c === id).length : 0;

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

  // ── error / loading shells ───────────────────────────────────────────────
  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="definitions">
          <ErrorState error={err} onRetry={load} />
        </Card>
      </div>
    );
  }
  if (!form) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="definitions">
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  // The show open in the inline editor. focusIdx can briefly point past the end
  // after a removal — coerce an out-of-range index to "nothing open".
  const focused = focusIdx != null ? (form.shows[focusIdx] ?? null) : null;

  return (
    <div className="grid gap-4">
      {/* ── WEEKLY SCHEDULE — moved to its own page (The Rundown) ────────── */}
      <section className="card">
        <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-4 p-4">
          <div>
            <Eyebrow className="text-vermilion">show plan · the rundown</Eyebrow>
            <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
              Build your shows here. Put them on the air on the Rundown.
            </div>
            <div className="mt-1 max-w-[62ch] text-[11px] leading-[1.6] text-muted">
              This page is the roster — each show&apos;s name, host, brief, and
              sound. The Rundown is the week itself: the board, the on-air
              listing, and takeovers, hour by hour.
            </div>
          </div>
          <div className="flex flex-none flex-col items-end gap-2.5">
            <div className="flex gap-4">
              <Metric n={String(scheduledHours)} l="hours scheduled" />
              <Metric n={String(168 - scheduledHours)} l="silent" accent={scheduledHours < 168} />
            </div>
            <Button asChild variant="accent" size="sm">
              <Link href="/admin/shows/schedule">Open the schedule →</Link>
            </Button>
          </div>
        </div>
      </section>

      {personas.length === 0 && (
        <Card title="Personas required" sub="setup">
          <div className="text-[13px] text-[var(--danger)]">
            No personas defined. Create one under Personas first.
          </div>
        </Card>
      )}

      {/* ── SHOW DEFINITIONS ─────────────────────────────────────────────── */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <span className="caption">show definitions · {form.shows.length}/{SHOWS_MAX} shows</span>
        <div className="flex items-center gap-2">
          <RosterViewToggle view={view} onChange={setView} />
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
        <EmptyState
          title="No shows scheduled"
          description="Add one to start programming the week."
        />
      )}

      {view === 'list' && form.shows.length > 0 && (
        <ShowsTable
          rows={form.shows.map((s, i) => showRow(s, i, personas, apiBase, countHours(s.id)))}
          onEdit={r => focusShow(r.index)}
        />
      )}

      {view === 'cards' && form.shows.map((s, i) => {
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
  // Genres this show asks for that no track actually carries. The controller
  // resolves a free-text genre onto the nearest library tag, which silently
  // broadens the show ("Pop Punk" → "Pop") or drops the filter altogether when
  // nothing is close — invisible on air unless we say it here, at the moment
  // the operator is looking at the field. Mirrors show-filter.normGenre so the
  // UI and the station agree on what counts as "the same tag". Only meaningful
  // once the library list has loaded (empty = not fetched yet, or the endpoint
  // failed — never warn on a fetch failure).
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const knownGenres = useMemo(() => new Set(genres.map(norm)), [genres]);
  const unknownGenres = genres.length
    ? show.genres.filter(g => !knownGenres.has(norm(g)))
    : [];
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
                Optional, up to {GUESTS_MAX}. While this show airs, guests take
                some of the talk breaks (station IDs, time checks, weather and
                news) in their own voice. The host still drives the music and
                track intros.
              </span>

              <div className="mt-1 flex items-start gap-3">
                <div className="pt-0.5">
                  <Toggle
                    on={show.banter && (show.guestPersonaIds?.length ?? 0) > 0}
                    disabled={(show.guestPersonaIds?.length ?? 0) === 0}
                    onClick={() => update({ banter: !show.banter })}
                    ariaLabel="Banter breaks"
                  />
                </div>
                <div className="grid gap-0.5">
                  <Label className={(show.guestPersonaIds?.length ?? 0) === 0 ? 'opacity-40' : undefined}>
                    Banter breaks
                  </Label>
                  <span className="field-hint">
                    Short scripted back-and-forth between the host and guests,
                    each voice rendered separately. Up to twice an hour,
                    depending on the persona&apos;s talk frequency. Needs at
                    least one guest.
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
                  ariaLabel="Programme (produced episode)"
                />
              </div>
              <div className="grid gap-0.5">
                <Label>Programme (produced episode)</Label>
                <span className="field-hint">
                  The DJ produces each airing as a full episode from the topic
                  brief: an intro up top, a planned feature mid-hour, and a
                  sign-off in the closing minutes. Fresh angle every episode.
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
                  <SelectTrigger aria-label="Feature segment skill">
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
                  Optional. Pin the mid-hour feature to one skill, like news for
                  a morning roundup. Producer&apos;s choice lets each episode
                  decide.
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
              Optional. The player switches to this palette while the show airs,
              then back to the station default. Manage themes in
              Settings → Theme.
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
              Pick any that fit; a track matching any of them qualifies. None
              selected = Any (auto), following the station&apos;s own mood.
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
              Pick any decades, even non-adjacent ones ({'"'}90s + 2010s{'"'}).
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
            {unknownGenres.length > 0 && (
              <span role="alert" className="field-hint text-vermilion">
                No track in your library is tagged{' '}
                {unknownGenres.map((g, i) => (
                  <span key={g}>{i > 0 ? ', ' : ''}&ldquo;{g}&rdquo;</span>
                ))}
                . The station falls back to the closest tag it can find, so this show
                will air broader results than you asked for — or, if nothing is close,
                the genre filter switches off entirely. Pick a genre from the
                suggestions, or re-tag the tracks in Navidrome.
              </span>
            )}
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
                ariaLabel="Strict filter"
              />
            </div>
            <div className="grid gap-0.5">
              <Label className={!hasAnyMusicFilter(show) ? 'opacity-40' : undefined}>
                Strict filter
              </Label>
              <span className="field-hint">
                Hard-enforces every filter set above (mood, era, energy,
                genre); off-filter tracks play only as a last resort. When off,
                they&apos;re soft leans the DJ can break for flow. Needs at
                least one filter set.
              </span>
            </div>
          </div>

          <span className="field-hint -mt-1.5">
            Optional steer for this show: mood, genre, era, energy, or any mix.
            Soft by default, so the DJ leans toward them but can break them for
            flow; Strict filter above makes them hard rules. Mood set to Any
            (auto) follows the station&apos;s own mood instead of pinning one.
          </span>

          <Field>
            <Label>playlist anchor</Label>
            <span className="field-hint">
              Pin one or more Navidrome playlists and their combined tracks
              become this show&apos;s pool. The AI DJ still sequences and talks
              over them. Pick none to let genre/era/mood drive selection
              (up to 10).
            </span>
            {playlists.length === 0 ? (
              <span className="field-hint opacity-60">
                No Navidrome playlists found yet. Create some in Navidrome, then
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
                  ariaLabel="Playlist only (strict)"
                />
              </div>
              <div className="grid gap-0.5">
                <Label>Playlist only (strict)</Label>
                <span className="field-hint">
                  On: play only the pinned playlist(s); off-playlist tracks air
                  only as a last resort. Off: the playlist dominates but the DJ
                  can still wander for variety. Listener requests always get
                  through, either way.
                </span>
              </div>
            </div>
          )}

          <Field>
            <Label>excluded playlists</Label>
            <span className="field-hint">
              Tracks from these playlists never play during this show, whatever
              the other filters say. Handy for blocking genres or moods that
              don&apos;t fit: gather them in a Navidrome playlist and exclude it
              here (up to 10).
            </span>
            {playlists.length === 0 ? (
              <span className="field-hint opacity-60">
                No Navidrome playlists found yet. Create some in Navidrome, then
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
              The brief the AI DJ works from. The more you describe, the better
              it picks music and writes links: genres, eras, moods, artists to
              lean into or avoid, time of day, the listener, how the host should
              sound. Write it like you&apos;re briefing a real DJ before their
              slot.
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
              The longest a single track plays during this show; anything longer
              fades out at the limit. Blank uses the station limit, 0 means no
              limit (good for long mixes or DJ sets), or set at
              least {minTrackSeconds ?? 30}s to cap it here.
            </span>
          </Field>
        </Card>
      </div>
    </EditorDialog>
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

// "What it plays" facets — moods, genres, eras, energies as chips, plus the
// hard-lock / playlist / length flags. The visual counterpart to the text
// showFilterSummary() the strip cards still use. Shared by the slate card and
// the table row so the two views can't drift.
function showFacets(s: Show): ShowFacet[] {
  const facets: ShowFacet[] = [];
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
  return facets;
}

// Grammatical name join: "Kai", "Kai & Rae", "Kai, Rae & Sol".
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

// A persona as a table face — resolved avatar URL plus the initials to fall
// back to. `index` is carried on the row because the panel keys colour and
// editing off the show's position in the array.
function faceOf(p: Persona, apiBase: string) {
  return {
    key: p.id,
    initials: abbrev(p.name?.trim() || ''),
    src: p.avatar ? `${apiBase}/persona-avatar/${encodeURIComponent(p.id)}` : null,
  };
}

// Flatten one show into the table's view-model. Everything the row needs is
// derived here, so ShowsTable never has to know the `Show` shape.
function showRow(s: Show, index: number, personas: Persona[], apiBase: string, hrs: number): ShowRow {
  const host = personas.find(p => p.id === s.personaId) ?? null;
  const guests = (s.guestPersonaIds || [])
    .map(id => personas.find(p => p.id === id))
    .filter((p): p is Persona => Boolean(p));
  return {
    id: s.id,
    index,
    name: s.name.trim(),
    colour: SHOW_COLORS[index % SHOW_COLORS.length] ?? '#000',
    programme: !!s.programme,
    skillPin: s.programme && s.segmentSkill ? s.segmentSkill : '',
    banter: !!s.banter,
    host: host ? faceOf(host, apiBase) : null,
    hostName: host ? (host.name?.trim() || 'Unnamed') : (s.personaId ? 'Unnamed' : ''),
    guests: guests.map(g => faceOf(g, apiBase)),
    guestNames: joinNames(guests.map(g => g.name?.trim() || 'Unnamed')),
    facets: showFacets(s),
    hrs,
    ok: showValid(s),
  };
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

  const facets = showFacets(s);

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
