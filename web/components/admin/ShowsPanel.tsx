'use client';

// Shows scheduler — /admin/shows. A show is a reusable definition (name,
// topic, owner persona, music mood). The weekly grid assigns a show to any
// 1-hour cell, Mon–Sun. When the current hour has a show, its persona goes on
// air, its mood overrides the autonomous mood, and its topic feeds the DJ.
// An empty hour = the station runs autonomously, as it does today.
// Everything POSTs to /settings and applies live.
//
// Shows are created/edited through a centered modal (components/ui/modal).
// The weekly grid is drag-paintable: pick a brush, then click-drag across
// cells; click a day label or hour header to fill a whole row/column.
import type { ChangeEvent, TouchEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
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
import { Card, Btn, Pill, Eyebrow, Metric, Toggle } from './ui';
import { Modal } from '../ui/modal';
import { AiFill } from './AiFill';
import { cn } from '../../lib/cn';

const NAME_MAX = 60;
const TOPIC_MAX = 1000;
const SHOWS_MAX = 64;

// Radix Select rejects an empty-string item value, so the "no override"
// choice round-trips through this sentinel. Form state still stores the
// real empty string ('' = use station default).
const THEME_DEFAULT_SENTINEL = '__station_default__';

// Storage keys are 0=Sun..6=Sat (JS getDay); display Mon-first.
const DAYS = [
  { key: 1, label: 'Mon' }, { key: 2, label: 'Tue' }, { key: 3, label: 'Wed' },
  { key: 4, label: 'Thu' }, { key: 5, label: 'Fri' }, { key: 6, label: 'Sat' },
  { key: 0, label: 'Sun' },
];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const SHOW_COLORS = [
  '#c5302a', '#2f6f4f', '#3a5fa8', '#9a5b1f', '#6b4a8a', '#1f7a7a',
  '#a83a6b', '#4a6b1f', '#8a6a1f', '#3a3a8a', '#7a2f5a', '#2f7a3a',
];

interface Show {
  id: string;
  name: string;
  topic: string;
  personaId: string;
  mood: string;
  /** Optional theme override — empty string means "fall back to the station
   *  default while this show is on air". Validated against the live theme
   *  registry by the controller; a stale id silently falls back too. */
  themeId: string;
  /** Optional music-steering filters — soft lean applied at pick time. Empty
   *  string / null means "no constraint". Genre is free text resolved fuzzily
   *  against the library; fromYear/toYear are a decade window; energy is one of
   *  low|medium|high. */
  genre: string;
  fromYear: number | null;
  toYear: number | null;
  energy: string;
  /** When true (and a genre is set) the genre becomes a HARD filter on the pick
   *  pool instead of a soft lean — off-genre tracks only play as a last resort
   *  to avoid silence. Defaults off. */
  genreStrict: boolean;
  /** Per-show track-length cap (seconds). null = inherit the station default;
   *  0 = unlimited (opt this show out of the cap so it can air long mixes);
   *  >0 = this show's own cap. */
  maxTrackSeconds: number | null;
}

// Decade presets for the era dropdown → fromYear/toYear. 'any' clears the window.
const DECADES: { key: string; label: string; from: number | null; to: number | null }[] = [
  { key: 'any', label: 'Any era', from: null, to: null },
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

function decadeKeyOf(s: { fromYear: number | null; toYear: number | null }): string {
  const hit = DECADES.find(d => d.from === s.fromYear && d.to === s.toYear);
  return hit ? hit.key : 'any';
}
function decadeLabelOf(s: { fromYear: number | null; toYear: number | null }): string | null {
  const hit = DECADES.find(d => d.from === s.fromYear && d.to === s.toYear);
  return hit && hit.from != null ? hit.label : null;
}

// Slim view of a theme returned by GET /themes — only the bits the picker
// needs. Token maps are dropped here; we don't render swatches in the
// shows panel (the admin Settings → Theme page is the gallery).
interface ThemeOption {
  id: string;
  name: string;
  mode?: string;
}

interface Persona {
  id: string;
  name?: string;
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
          ? <>persona · {personaLabel} · mood · {show.mood}{showFilterSummary(show)}</>
          : 'station runs on its own picker'}
      </div>
    </div>
  );
}

// Compact " · genre · 80s · high" suffix for the show summary lines, omitting
// whatever the show doesn't pin. A strict genre is flagged inline so the hard
// lock is visible at a glance.
function showFilterSummary(s: { genre: string; fromYear: number | null; toYear: number | null; energy: string; genreStrict?: boolean; maxTrackSeconds?: number | null }): string {
  const genre = s.genre ? (s.genreStrict ? `${s.genre} (strict)` : s.genre) : '';
  const len = s.maxTrackSeconds == null ? '' : s.maxTrackSeconds === 0 ? 'any length' : `≤${s.maxTrackSeconds}s`;
  const bits = [genre, decadeLabelOf(s), s.energy, len].filter(Boolean);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 's_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
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
  return s.name.trim().length >= 1 && s.name.trim().length <= NAME_MAX
    && !!s.personaId && !!s.mood && s.topic.trim().length <= TOPIC_MAX;
}

export default function ShowsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brush, setBrush] = useState<string | 'erase' | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Modal state: `editIndex` is null (closed), -1 (new show), or a show index.
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<Show | null>(null);
  // Theme list for the per-show override dropdown. Public endpoint, no auth
  // needed — same source the player ThemeBootstrap reads.
  const [themes, setThemes] = useState<ThemeOption[]>([]);
  // Library genres for the show genre autocomplete. Admin-gated endpoint, so it
  // runs after sign-in; failures are silent (the field still accepts free text).
  const [genres, setGenres] = useState<string[]>([]);

  // Drag-paint stroke: { active, value } — value is the showId/null painted
  // for the whole stroke, decided on mousedown so a drag doesn't flicker.
  const strokeRef = useRef<{ active: boolean; value: string | null | undefined }>({
    active: false,
    value: undefined,
  });

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

  // End any drag-paint stroke when the pointer is released anywhere.
  useEffect(() => {
    const end = () => { strokeRef.current.active = false; };
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
    return () => {
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchend', end);
    };
  }, []);

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
        const shows: Show[] = (j.values.shows || []).map(s => ({
          id: s.id ?? clientMintId(),
          name: s.name ?? '',
          topic: s.topic ?? '',
          personaId: s.personaId ?? '',
          mood: s.mood ?? '',
          themeId: s.themeId ?? '',
          genre: s.genre ?? '',
          fromYear: s.fromYear ?? null,
          toYear: s.toYear ?? null,
          energy: s.energy ?? '',
          genreStrict: s.genreStrict ?? false,
          maxTrackSeconds: s.maxTrackSeconds ?? null,
        }));
        setForm({ shows, schedule: week });
        // Arm the first valid show as the brush so the grid is paintable at once.
        const firstValid = shows.find(showValid);
        if (firstValid) setBrush(b => b ?? firstValid.id);
      }
    })();
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
        const j = (await r.json()) as { themes?: ThemeOption[] };
        if (Array.isArray(j.themes)) setThemes(j.themes);
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

  const personas: Persona[] = data?.values?.personas || [];
  const moods: string[] = data?.tts?.moods || [];
  const colorOf = (showId: string | null | undefined): string => {
    const idx = form && showId ? form.shows.findIndex(s => s.id === showId) : -1;
    return idx >= 0 ? (SHOW_COLORS[idx % SHOW_COLORS.length] ?? 'transparent') : 'transparent';
  };
  const showById = (id: string | null | undefined): Show | null =>
    (id && form?.shows.find(s => s.id === id)) || null;
  const personaName = (id: string): string => personas.find(p => p.id === id)?.name || '—';

  // ── show modal ───────────────────────────────────────────────────────────
  const openNew = () => {
    if (!form || form.shows.length >= SHOWS_MAX || personas.length === 0) return;
    setEditIndex(-1);
    setDraft({
      id: '', name: '', topic: '',
      personaId: personas[0]?.id || '', mood: moods[0] || '',
      themeId: '',
      genre: '', fromYear: null, toYear: null, energy: '', genreStrict: false,
      maxTrackSeconds: null,
    });
  };
  const openEdit = (i: number) => {
    if (!form) return;
    const s = form.shows[i];
    if (!s) return;
    setEditIndex(i);
    setDraft({
      id: s.id, name: s.name, topic: s.topic,
      personaId: s.personaId, mood: s.mood,
      themeId: s.themeId || '',
      genre: s.genre || '', fromYear: s.fromYear ?? null, toYear: s.toYear ?? null, energy: s.energy || '',
      genreStrict: s.genreStrict ?? false,
      maxTrackSeconds: s.maxTrackSeconds ?? null,
    });
  };
  const closeModal = () => { setEditIndex(null); setDraft(null); };
  const setDraftField = (patch: Partial<Show>) => setDraft(d => d ? ({ ...d, ...patch }) : d);
  const commitDraft = () => {
    if (!draft || !showValid(draft)) return;
    const clean = {
      name: draft.name.trim(), topic: draft.topic.trim(),
      personaId: draft.personaId, mood: draft.mood,
      themeId: draft.themeId || '',
      genre: draft.genre.trim(), fromYear: draft.fromYear, toYear: draft.toYear, energy: draft.energy || '',
      // Strict is only meaningful with a genre to lock to — drop it otherwise.
      genreStrict: !!draft.genre.trim() && draft.genreStrict,
      maxTrackSeconds: draft.maxTrackSeconds,
    };
    if (editIndex === -1) {
      const id = clientMintId();
      setForm(f => {
        if (!f) return f;
        return f.shows.length >= SHOWS_MAX
          ? f
          : { ...f, shows: [...f.shows, { id, ...clean }] };
      });
      // arm the new show as the brush if nothing is armed yet
      setBrush(b => b ?? id);
    } else {
      setForm(f => f ? ({
        ...f,
        shows: f.shows.map((s, idx) => (idx === editIndex ? { ...s, ...clean } : s)),
      }) : f);
    }
    closeModal();
  };

  const removeShow = (i: number) =>
    setForm(f => {
      if (!f) return f;
      const target = f.shows[i];
      if (!target) return f;
      const week: Schedule = JSON.parse(JSON.stringify(f.schedule));
      for (let d = 0; d < 7; d++)
        for (let h = 0; h < 24; h++)
          if (week[d]![h] === target.id) week[d]![h] = null;
      if (brush === target.id) setBrush(null);
      return { ...f, shows: f.shows.filter((_, idx) => idx !== i), schedule: week };
    });

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

  // Touch drag — translate the moving touch point into a grid cell.
  const onGridTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!strokeRef.current.active) return;
    const t = e.touches[0];
    if (!t) return;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const cell = el?.closest?.('[data-cell]') as HTMLElement | null;
    if (cell) {
      e.preventDefault();
      extendStroke(Number(cell.dataset.day), Number(cell.dataset.hour));
    }
  };

  // ── validation ───────────────────────────────────────────────────────────
  const allShowsOk = form ? form.shows.every(showValid) : false;
  const canSave = !!form && allShowsOk;
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

  const save = async () => {
    if (!canSave || !form) return;
    setBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shows: form.shows.map(s => ({
            id: s.id, name: s.name.trim(), topic: s.topic.trim(),
            personaId: s.personaId, mood: s.mood,
            themeId: s.themeId || '',
            genre: s.genre.trim(), fromYear: s.fromYear, toYear: s.toYear, energy: s.energy || '',
            genreStrict: !!s.genre.trim() && s.genreStrict,
            maxTrackSeconds: s.maxTrackSeconds,
          })),
          schedule: form.schedule,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('schedule saved, the current hour applies on the next pick');
      await load();
    } catch (e) {
      notify.err(errorMessage(e));
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
  const draftValid = draft ? showValid(draft) : false;

  return (
    <div className="grid gap-4">
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="stack-mobile grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-ink p-4">
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
          <Btn lg tone="accent" onClick={openNew}
            disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}>
            + New show
          </Btn>
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
        right={<Btn sm onClick={clearWeek}>Clear week</Btn>}
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
          className="overflow-x-auto"
          onTouchMove={onGridTouchMove}
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
          Pick a brush, then <b>click or drag</b> across cells to paint. Click a
          {' '}<b>day name</b> to fill that day, or an <b>hour</b> to fill that hour
          {' '}across the week. Painting over a matching cell clears it. The
          {' '}vermilion-ringed cell is the hour on air.
        </p>
      </Card>

      {/* ── SHOW DEFINITIONS ─────────────────────────────────────────────── */}
      <Card
        title="Show definitions"
        sub={`${form.shows.length}/${SHOWS_MAX} shows`}
        right={<Btn sm tone="accent" onClick={openNew}
          disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}>
          + Add show
        </Btn>}
      >
        {form.shows.length === 0 && (
          <p className="text-[12px] text-muted">
            No shows yet. Add one to start programming the week.
          </p>
        )}
        <div className="grid gap-2">
          {form.shows.map((s, i) => {
            const ok = showValid(s);
            const hrs = countHours(s.id);
            return (
              <ShowDefRow
                key={s.id}
                show={s}
                index={i}
                ok={ok}
                hrs={hrs}
                personaLabel={personaName(s.personaId)}
                onEdit={() => openEdit(i)}
                onRemove={() => removeShow(i)}
              />
            );
          })}
        </div>
      </Card>

      {/* ── SAVE ─────────────────────────────────────────────────────────── */}
      <Card title="Apply" sub="POST /settings">
        <div className="flex flex-wrap items-center gap-3">
          <Btn lg tone="accent" onClick={save} disabled={busy || !canSave}>
            {busy ? 'saving…' : 'Save schedule'}
          </Btn>
          {!canSave && !busy && (
            <span className="text-[11px] text-[var(--danger)]">
              every show needs a name, persona, and mood
            </span>
          )}
        </div>
      </Card>

      {/* ── ADD / EDIT SHOW MODAL ────────────────────────────────────────── */}
      <Modal
        open={editIndex !== null}
        onOpenChange={(o) => { if (!o) closeModal(); }}
        title={editIndex === -1 ? 'New show' : 'Edit show'}
        sub={editIndex === -1 ? 'define a show' : (draft?.name?.trim() || '')}
        footer={draft && (
          <>
            <Btn onClick={closeModal}>Cancel</Btn>
            <Btn tone="accent" onClick={commitDraft} disabled={!draftValid}>
              {editIndex === -1 ? 'Add show' : 'Save changes'}
            </Btn>
          </>
        )}
      >
        {draft && (
          <div className="grid gap-3.5">
            <AiFill<Partial<Omit<Show, 'personaId' | 'themeId'>> & { personaId?: string | null; themeId?: string | null }>
              endpoint="/generate/show"
              resultKey="show"
              adminFetch={adminFetch}
              placeholder="e.g. a Sunday-morning gospel hour, warm and uplifting"
              onApply={(s) => setDraftField({
                ...s,
                personaId: s.personaId ?? draft.personaId ?? '',
                themeId: s.themeId ?? '',
              })}
            />
            <Field>
              <Label htmlFor="show-name">show name</Label>
              <Input
                id="show-name"
                type="text" value={draft.name} maxLength={NAME_MAX}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftField({ name: e.target.value })}
                placeholder="e.g. The Late Shift"
                className="text-[15px] font-bold"
                autoFocus
              />
              <span className="field-hint">{draft.name.trim().length}/{NAME_MAX}</span>
            </Field>

            <div className="stack-mobile grid grid-cols-[1fr_1fr] gap-3">
              <Field>
                <Label>persona owner</Label>
                <Select
                  value={draft.personaId || undefined}
                  onValueChange={val => setDraftField({ personaId: val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="— pick persona —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {personas.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label>music mood</Label>
                <Select
                  value={draft.mood || undefined}
                  onValueChange={val => setDraftField({ mood: val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="— pick mood —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {moods.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <Label>theme override (applied while this show is on air)</Label>
              <Select
                value={draft.themeId || THEME_DEFAULT_SENTINEL}
                onValueChange={val =>
                  setDraftField({ themeId: val === THEME_DEFAULT_SENTINEL ? '' : val })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={THEME_DEFAULT_SENTINEL}>Station default</SelectItem>
                    {themes.map(t => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}{t.mode ? ` — ${t.mode}` : ''}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <span className="field-hint">
                Optional. When this show goes on air the player switches to
                this palette; back to the station default when the hour ends.
                Manage themes in admin → Settings → Theme.
              </span>
            </Field>

            <div className="stack-mobile grid grid-cols-[1.2fr_1fr_1fr] gap-3">
              <Field>
                <Label htmlFor="show-genre">genre lean</Label>
                <Input
                  id="show-genre"
                  type="text" value={draft.genre} maxLength={64}
                  list="show-genre-options"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftField({ genre: e.target.value })}
                  placeholder="e.g. Jazz (optional)"
                />
                <datalist id="show-genre-options">
                  {genres.map(g => <option key={g} value={g} />)}
                </datalist>
              </Field>
              <Field>
                <Label>era</Label>
                <Select
                  value={decadeKeyOf(draft)}
                  onValueChange={val => {
                    const d = DECADES.find(x => x.key === val);
                    setDraftField({ fromYear: d?.from ?? null, toYear: d?.to ?? null });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {DECADES.map(d => <SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label>energy</Label>
                <Select
                  value={draft.energy || ANY_SENTINEL}
                  onValueChange={val => setDraftField({ energy: val === ANY_SENTINEL ? '' : val })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ANY_SENTINEL}>Any</SelectItem>
                      {ENERGY_OPTIONS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="flex items-start gap-3">
              <div className="pt-0.5">
                <Toggle
                  on={draft.genreStrict}
                  disabled={!draft.genre.trim()}
                  onClick={() => setDraftField({ genreStrict: !draft.genreStrict })}
                />
              </div>
              <div className="grid gap-0.5">
                <Label className={!draft.genre.trim() ? 'opacity-40' : undefined}>
                  Strict genre
                </Label>
                <span className="field-hint">
                  Stay strictly within this genre (off-genre tracks only as a last
                  resort to avoid silence). Needs a genre lean set above.
                </span>
              </div>
            </div>

            <span className="field-hint -mt-1.5">
              Optional soft music steer for this show: a genre, an era, an energy
              band, or any mix. The DJ leans toward these but can break them for
              flow; leave blank to let the topic and mood drive selection.
            </span>

            <Field>
              <Label htmlFor="show-maxlen">max track length (seconds)</Label>
              <Input
                id="show-maxlen"
                type="number"
                min={0}
                max={36000}
                placeholder="inherit"
                value={draft.maxTrackSeconds ?? ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const raw = e.target.value.trim();
                  setDraftField({ maxTrackSeconds: raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0) });
                }}
              />
              <span className="field-hint">
                The longest a single track can run while this show is on air. The
                DJ skips anything longer when it picks, so this is a hard limit,
                not a lean like the fields above. Leave it blank to use the
                station limit, enter 0 to allow any length (good for a show built
                around long mixes or DJ sets), or set a number to cap it just for
                this show.
              </span>
            </Field>

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
                rows={7} value={draft.topic} maxLength={TOPIC_MAX}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraftField({ topic: e.target.value })}
                placeholder="e.g. Slow ambient, modern classical and downtempo for the late shift. Think Nils Frahm, Hammock, Bonobo's quieter side, nothing with a hard beat. Keep the host calm and unhurried, like a friend talking you down at 1am."
              />
              <span className="field-hint">{draft.topic.trim().length}/{TOPIC_MAX}</span>
            </Field>

            {!draftValid && (
              <div className="text-[11px] text-[var(--danger)]">
                A show needs a name, a persona, and a mood.
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
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
  showById: (id: string | null | undefined) => Show | null;
  colorOf: (id: string | null | undefined) => string;
}

function DayRow({
  dayKey, label, brush, form, nowDay, nowHour,
  fillDay, beginStroke, extendStroke, showById, colorOf,
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
            onTouchStart={() => beginStroke(dayKey, h)}
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
  onTouchStart: () => void;
}

function GridCell({
  day, hour, label, show, color, isNow, brush,
  onMouseDown, onMouseEnter, onTouchStart,
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
      title={
        (show ? `${show.name} (${show.mood})` : `${label} ${String(hour).padStart(2, '0')}:00, empty`)
        + (isNow ? ' · on air now' : '')
      }
      className={cn(
        'relative -mt-px -ml-px flex h-8 items-center justify-center border border-separator-strong p-0 font-[inherit] text-[9px] font-bold tracking-[0.15em] uppercase',
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

interface ShowDefRowProps {
  show: Show;
  index: number;
  ok: boolean;
  hrs: number;
  personaLabel: string;
  onEdit: () => void;
  onRemove: () => void;
}

function ShowDefRow({ show: s, index: i, ok, hrs, personaLabel, onEdit, onRemove }: ShowDefRowProps) {
  const stripeRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(stripeRef, { background: SHOW_COLORS[i % SHOW_COLORS.length] ?? '#000' });
  return (
    <div
      className={cn(
        'flex items-center gap-3 border py-2.5 pr-3',
        ok ? 'border-separator-strong' : 'border-[var(--danger)]',
      )}
    >
      <div ref={stripeRef} className="w-1 self-stretch" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="overflow-hidden text-[14px] font-extrabold tracking-[-0.01em] text-ellipsis whitespace-nowrap">
          {s.name.trim() || 'untitled'}
        </div>
        <div className="text-[11px] text-muted">
          persona · {personaLabel} · mood · {s.mood || '—'}{showFilterSummary(s)}
        </div>
        {s.topic.trim() && (
          <div className="overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted italic">
            {s.topic.trim()}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!ok && <Pill tone="accent">incomplete</Pill>}
        {hrs > 0
          ? <Pill tone="ink">{hrs}h / week</Pill>
          : <Pill>unscheduled</Pill>}
        <Btn sm onClick={onEdit}>Edit</Btn>
        <Btn sm tone="danger" onClick={onRemove} title="Remove this show">
          ✕
        </Btn>
      </div>
    </div>
  );
}
