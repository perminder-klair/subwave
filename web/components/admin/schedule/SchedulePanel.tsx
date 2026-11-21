'use client';


import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAdminAuth } from '../../../lib/adminAuth';
import { AdminResponseError, adminJson, useAdminMutation } from '../../../lib/admin-query';
import { BOARD_HOUR_PX, useBoardDensity } from '../../../lib/adminView';
import { notify, errorMessage } from '../../../lib/notify';
import { fmtClock, normalizeStationLocale, zonedDayHour } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';
import { cn } from '../../../lib/cn';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Modal } from '../../ui/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Card } from '../ui';
import { GuestPersonaPicker } from '../shows/ShowPickers';
import Board from './Board';
import SaveBar from './SaveBar';
import EditorBand, { LineEditor } from './EditorBand';
import type { AirtimeRow, EditorLine, Suggestion } from './EditorBand';
import { ColorChip, Mu } from './bits';
import type { Block, DragPlan, GeneratedTemplateId, Schedule } from './lib';
import {
  DAYS, GENERATED_SHOW_TEMPLATES, SHOW_COLORS,
  applyRunDrag, blockAhead, blockAt, bookedHours, cloneWeek, dayBlocks, generatedShowColor, generatedShowLabel,
  dayName, diffCells, diffRanges, emptyWeek, fillDayToggle, fillHourToggle,
  hhmm, resizeBlock, setRange, showHours, weekOrders,
} from './lib';
import { settingsKeys, useSettingsQuery } from '../settings/queries';
import { scheduleKeys, useScheduleOverrideQuery } from './queries';
import { isDefaultTakeover, takeoverShowId } from '@/lib/schemas.generated';
import type { ShowGenerationConfig } from '@/lib/schemas.generated';
import { clientMintId, hydrateShow as hydrateFullShow, showPayload } from '../shows/lib';
import type { Show } from '../shows/types';
import { GUESTS_MAX, SHOWS_MAX } from '../shows/types';
import { patchShowSettings } from '../shows/queries';

/** The airtime-bar tick — hours a show "should" get in a week. */
const WEEKLY_TARGET = 12;
const RANDOM_HOST = '__random_host__';
const API_BASE = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';

function scheduleWriteError(error: unknown): string {
  if (error instanceof AdminResponseError) {
    return typeof error.body.error === 'string' && error.body.error
      ? error.body.error
      : `failed (${error.status})`;
  }
  return errorMessage(error);
}

interface Persona {
  id: string;
  name?: string;
}

interface SettingsResponse {
  values?: {
    shows?: Array<Partial<Show>>;
    schedule?: Schedule;
    personas?: Persona[];
    timezone?: string;
    locale?: StationLocale;
    subShows?: { eligibleHostPersonaIds?: string[] | null };
  };
  serverTimezone?: string;
}

export default function SchedulePanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const router = useRouter();
  const [shows, setShows] = useState<Show[]>([]);
  const [serverShows, setServerShows] = useState<Show[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [serverSchedule, setServerSchedule] = useState<Schedule | null>(null);
  const [tz, setTz] = useState<string | undefined>(undefined);
  const [locale, setLocale] = useState<StationLocale>(normalizeStationLocale(undefined));
  const [now, setNow] = useState(() => new Date());
  const queryEnabled = hydrated && !needsAuth;
  const settingsQuery = useSettingsQuery<SettingsResponse>({
    adminFetch,
    enabled: queryEnabled,
    refetchOnMount: 'always',
  });
  const overrideQuery = useScheduleOverrideQuery(adminFetch, queryEnabled);
  const commonGroundPool = settingsQuery.data?.values?.subShows?.eligibleHostPersonaIds;
  const commonGroundPersonas = personas.filter(persona => commonGroundPool == null || commonGroundPool.includes(persona.id));
  const err = settingsQuery.error && !schedule ? errorMessage(settingsQuery.error) : null;

  // Board columns collapsed to rails, keyed by storage day (0=Sun..6=Sat).
  const [folded, setFolded] = useState<Record<number, boolean>>({});
  // The line editor sits above the fold, so a pick has to scroll it into view.
  const bandRef = useRef<HTMLDivElement>(null);

  const [line, setLine] = useState<EditorLine>({ day: 6, start: 16, end: 18 });
  const [lineShowId, setLineShowId] = useState<string | null>(null);
  const [lineDays, setLineDays] = useState<number[]>([6]);

  // The armed show — the shelf chip acting as a brush (#1204). Deliberately not
  // `lineShowId`, which every card click sets: bulk fills must not ride on that.
  const [armedShowId, setArmedShowId] = useState<string | null>(null);
  const [armedTemplateId, setArmedTemplateId] = useState<GeneratedTemplateId | null>(null);
  const [generatedOptionsDraft, setGeneratedOptionsDraft] = useState<Show | null>(null);
  // One page-local preset; selecting another template discards it.
  const [templateOptions, setTemplateOptions] = useState<Show | null>(null);
  const [editingTemplateOptions, setEditingTemplateOptions] = useState(false);
  const [density, setDensity] = useBoardDensity();

  const [dismissed, setDismissed] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // The live takeover (#930), read-only here; pin/cancel live on the dash.
  const override = overrideQuery.data?.override ?? null;

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const applySettings = (j: SettingsResponse) => {
    if (!j.values) return;
      const week = emptyWeek();
      const sched = j.values?.schedule || {};
      for (let d = 0; d < 7; d++) {
        const day = (sched as Record<number, (string | null)[] | undefined>)[d];
        if (Array.isArray(day)) for (let h = 0; h < 24; h++) week[d]![h] = day[h] ?? null;
      }
      const loaded = (j.values?.shows || [])
        .filter(show => typeof show.id === 'string' && !!show.id)
        .map(show => hydrateFullShow(show));
      setShows(loaded);
      setServerShows(loaded);
      setPersonas(j.values?.personas || []);
      setTz(j.values?.timezone || j.serverTimezone);
      setLocale(normalizeStationLocale(j.values?.locale));
      setSchedule(week);
      setServerSchedule(cloneWeek(week));
      const { dow, hour } = zonedDayHour(new Date(), j.values?.timezone || j.serverTimezone);
      const b = blockAt(week, dow, hour);
      setLine({ day: b.day, start: b.start, end: b.start + b.span });
      setLineDays([b.day]);
      setLineShowId(b.showId ?? loaded[0]?.id ?? null);
  };

  const load = async () => {
    const result = await settingsQuery.refetch();
    if (result.data && !result.error && !schedule) applySettings(result.data);
  };

  // A query refresh may update roster metadata but never this mount's unsaved week.
  const settingsAppliedRef = useRef(false);
  useEffect(() => {
    if (
      !settingsQuery.data
      || settingsQuery.error
      || settingsQuery.isFetching
      || settingsAppliedRef.current
    ) return;
    settingsAppliedRef.current = true;
    applySettings(settingsQuery.data);
  }, [settingsQuery.data, settingsQuery.error, settingsQuery.isFetching]);

  const { dow: nowDay, hour: nowHour } = zonedDayHour(now, tz);
  const stationMinute = useMemo(() => {
    try {
      return Number(new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: tz || undefined }).format(now));
    } catch {
      return now.getMinutes();
    }
  }, [now, tz]);

  const colorOf = (id: string | null | undefined): string => {
    const show = id ? shows.find(s => s.id === id) : null;
    if (show?.generation?.mode === 'generated') return generatedShowColor(show.generation.template);
    const idx = id ? shows.findIndex(s => s.id === id) : -1;
    return idx >= 0 ? (SHOW_COLORS[idx % SHOW_COLORS.length] ?? 'transparent') : 'transparent';
  };
  const showById = (id: string | null) => shows.find(s => s.id === id) ?? null;
  const personaName = (id: string) => personas.find(p => p.id === id)?.name || '—';
  const showLabel = (show: Show | null | undefined) => show?.generation?.mode === 'generated'
    ? generatedShowLabel(show, personas)
    : show?.name ?? 'show';
  const showLabelOf = (id: string | null) => showLabel(showById(id));
  // Bare values only — "Saaya · night · low", no field labels.
  const metaOf = (id: string | null): string => {
    const s = showById(id);
    if (!s) return 'the station runs itself';
    if (s.generation?.mode === 'generated') {
      const host = s.generation.hostMode === 'random' ? 'Random host' : personaName(s.personaId);
      const guests = s.generation.guestMode === 'none'
        ? 'No guests'
        : s.generation.guestMode === 'random'
          ? s.generation.template === 'common-ground' ? 'Random guest' : `Random guests (${s.generation.guestCount.min}–${s.generation.guestCount.max})`
          : 'Selected guests';
      return `${host} · ${guests}`;
    }
    const bits = [personaName(s.personaId), s.moods.join(', ')];
    if (s.energies.length) bits.push(s.energies.join(', '));
    return bits.filter(Boolean).join(' · ');
  };
  const hoursOf = (id: string) => (schedule ? showHours(schedule, id) : 0);

  const booked = schedule ? bookedHours(schedule) : 0;
  const orders = useMemo(() => (schedule ? weekOrders(schedule) : []), [schedule]);
  const serverShowById = new Map(serverShows.map(show => [show.id, show]));
  const dirtyGeneratedShows = shows.filter(show => {
    if (show.generation?.mode !== 'generated') return false;
    const saved = serverShowById.get(show.id);
    return !saved || JSON.stringify(showPayload(show)) !== JSON.stringify(showPayload(saved));
  });
  const dirty = (schedule && serverSchedule ? diffCells(schedule, serverSchedule) : 0)
    + dirtyGeneratedShows.length;

  const liveOverride = override && override.expiresAt > now.getTime() ? override : null;
  const pinnedShowId = takeoverShowId(liveOverride);
  const pinnedShow = pinnedShowId ? showById(pinnedShowId) : null;
  const defaultTakeover = isDefaultTakeover(liveOverride);
  // A takeover owns this header only when it resolves to a roster show or Default
  // programming; anything else voids it, matching getScheduleOverride (#1507).
  const airingTakeover = liveOverride && (pinnedShow || defaultTakeover) ? liveOverride : null;

  // Resolve through the roster: a show deleted in another tab leaves a dangling brush.
  const armedShow = armedShowId ? showById(armedShowId) : null;
  const armedId = armedShow?.id ?? null;

  /** The sentence editor follows the brush so the two editing paths agree. */
  const armShow = (id: string) => {
    setArmedShowId(cur => (cur === id ? null : id));
    setArmedTemplateId(null);
    setLineShowId(id);
  };

  const armTemplate = (templateId: GeneratedTemplateId) => {
    const draft = makeGeneratedShow(templateId);
    if (!draft) return;
    if (templateOptions?.generation?.template !== templateId) setTemplateOptions(null);
    setArmedShowId(null);
    setArmedTemplateId(templateId);
    setEditingTemplateOptions(true);
    setGeneratedOptionsDraft(draft);
  };

  useEffect(() => {
    if (!armedId && !armedTemplateId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Radix consumes Escape in a capture listener; closing an overlay must
      // not also drop the brush.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        setArmedShowId(null);
        setArmedTemplateId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [armedId, armedTemplateId]);

  /** Day header with a show armed: all 24 hours, or clear when the day already
   *  runs nothing else, so a second click undoes the first. */
  const fillDay = (day: number) => {
    if (!schedule || !armedShow) return;
    const next = fillDayToggle(schedule, day, armedShow.id);
    setSchedule(next);
    const cleared = (next[day] ?? []).every(c => c == null);
    notify.ok(cleared
      ? `${dayName(day)} cleared — unsaved until you save the week.`
      : `“${showLabel(armedShow)}” across ${dayName(day)} — unsaved until you save the week.`);
  };

  /** Gutter hour with a show armed: that hour every day, same toggle-off rule. */
  const fillHour = (hour: number) => {
    if (!schedule || !armedShow) return;
    const next = fillHourToggle(schedule, hour, armedShow.id);
    setSchedule(next);
    const cleared = DAYS.every(d => next[d.key]?.[hour] == null);
    notify.ok(cleared
      ? `${hhmm(hour)} cleared all week — unsaved until you save the week.`
      : `“${showLabel(armedShow)}” at ${hhmm(hour)} every day — unsaved until you save the week.`);
  };

  const pick = (b: Block) => {
    const show = showById(b.showId);
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(b.showId ?? lineShowId ?? shows[0]?.id ?? null);
    if (show?.generation?.mode === 'generated') {
      setEditingTemplateOptions(false);
      setGeneratedOptionsDraft({
        ...show,
        generation: {
          ...show.generation,
          guestCount: { ...show.generation.guestCount },
        },
      });
      return;
    }
    // block: 'nearest' makes this a no-op when the order desk is already visible.
    bandRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const applyLine = (value: string | null) => {
    if (!schedule) return;
    const days = lineDays.includes(line.day) ? lineDays : [...lineDays, line.day];
    setSchedule(setRange(schedule, days, line.start, line.end, value));
  };

  // Toasts here are the live region, so every booking must confirm like its siblings.
  const dropShow = (b: Block, showId: string) => {
    if (!schedule || !showById(showId)) return;
    setSchedule(setRange(schedule, [b.day], b.start, b.start + b.span, showId));
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(showId);
    notify.ok(
      `“${showLabelOf(showId)}” now ${dayName(b.day)} ${hhmm(b.start)} – ${hhmm(b.start + b.span)} — unsaved until you save the week.`,
    );
  };

  const makeGeneratedShow = (templateId: GeneratedTemplateId): Show | null => {
    const template = GENERATED_SHOW_TEMPLATES.find(item => item.id === templateId);
    const personaIds = (templateId === 'common-ground' || templateId === 'outside-comfort-zone' ? commonGroundPersonas : personas).map(persona => persona.id).filter(Boolean);
    if (templateId === 'common-ground' && personaIds.length < 2) {
      notify.err('Enable at least two DJs in Sub/Shows → Random Hosts before adding Common Ground.');
      return null;
    }
    if (!template || personaIds.length === 0) {
      notify.err('Enable at least one DJ in Sub/Shows → Random Hosts before scheduling a generated show.');
      return null;
    }
    if (shows.length >= SHOWS_MAX) {
      notify.err(`The show list is full (${SHOWS_MAX} shows max). Remove one before adding a generated show.`);
      return null;
    }
    if (templateOptions?.generation?.template === templateId) {
      return hydrateFullShow({
        ...templateOptions,
        id: clientMintId(),
        guestPersonaIds: [...templateOptions.guestPersonaIds],
        generation: { ...templateOptions.generation, guestCount: { ...templateOptions.generation.guestCount } },
      });
    }
    const generation: ShowGenerationConfig = {
      mode: 'generated',
      template: templateId,
      planningPrompt: '',
      nameMode: 'random',
      customName: '',
      hostMode: 'random',
      guestMode: templateId === 'outside-comfort-zone' ? 'none' : 'random',
      guestCount: templateId === 'outside-comfort-zone' ? { min: 0, max: 0 } : templateId === 'common-ground' ? { min: 1, max: 1 } : { min: 0, max: GUESTS_MAX },
      minimumCoverage: null,
    };
    return hydrateFullShow({
      id: clientMintId(),
      name: template.label,
      topic: '',
      personaId: personaIds[0]!,
      programme: false,
      generation,
    });
  };

  const dropTemplate = (b: Block, templateId: GeneratedTemplateId) => {
    if (!schedule) return;
    const show = makeGeneratedShow(templateId);
    if (!show) return;
    setShows(current => [...current, show]);
    setSchedule(setRange(schedule, [b.day], b.start, b.start + b.span, show.id));
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(show.id);
    setArmedShowId(show.id);
    setArmedTemplateId(null);
    notify.ok(
      `“${showLabel(show)}” now ${dayName(b.day)} ${hhmm(b.start)} – ${hhmm(b.start + b.span)} — unsaved until you save the week.`,
    );
  };

  // Vacated hours fall silent; gained ones overwrite, so a run grows into its neighbour.
  const resizeRun = (b: Block, start: number, end: number) => {
    if (!schedule || !b.showId) return;
    setSchedule(resizeBlock(schedule, b, start, end));
    setLine({ day: b.day, start, end });
    setLineDays([b.day]);
    setLineShowId(b.showId);
    notify.ok(
      `“${showLabelOf(b.showId)}” now ${dayName(b.day)} ${hhmm(start)} – ${hhmm(end)} — unsaved until you save the week.`,
    );
  };

  const dragRun = (b: Block, plan: DragPlan) => {
    if (!schedule || !b.showId) return null;
    const r = applyRunDrag(schedule, b, plan);
    if (r.week === schedule) return null;
    setSchedule(r.week);
    setLine({ day: b.day, start: r.start, end: r.end });
    setLineDays([b.day]);
    setLineShowId(b.showId);
    notify.ok(
      `“${showLabelOf(b.showId)}” now ${dayName(b.day)} ${hhmm(r.start)} – ${hhmm(r.end)}`
      + (r.shifted ? ` (${r.shifted} other show${r.shifted === 1 ? '' : 's'} shifted)` : '')
      + ' — unsaved until you save the week.',
    );
    return r;
  };

  // The removed line lands in the order desk preselected, so a mis-click is one undo away.
  const removeRun = (b: Block) => {
    if (!schedule || !b.showId) return;
    setSchedule(setRange(schedule, [b.day], b.start, b.start + b.span, null));
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(b.showId);
    notify.ok(
      `“${showLabelOf(b.showId)}” off ${dayName(b.day)} ${hhmm(b.start)} – ${hhmm(b.start + b.span)} — unsaved until you save the week.`,
    );
  };

  // Where the edited line would sit in the week's order stack.
  const orderNo = useMemo(() => {
    const dayIdx = (d: number) => DAYS.findIndex(x => x.key === d);
    return orders.filter(o =>
      dayIdx(o.day) < dayIdx(line.day) ||
      (o.day === line.day && o.start < line.start),
    ).length + 1;
  }, [orders, line]);

  const saveScheduleMutation = useAdminMutation<{
    schedule: Schedule;
    dropped?: number;
  }, Schedule>({
    adminFetch,
    request: (week, fetcher) => adminJson(fetcher, '/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: week }),
    }),
    onDone: async (result, _week, client) => {
      client.setQueryData<SettingsResponse>(settingsKeys.detail(), previous => {
        if (!previous?.values) return previous;
        return {
          ...previous,
          values: { ...previous.values, schedule: result.schedule },
        };
      });
      await client.invalidateQueries({ queryKey: scheduleKeys.override(), exact: true });
    },
    toastOnError: false,
  });
  const saveGeneratedShowMutation = useAdminMutation<{
    shows?: Array<Partial<Show>>;
    show?: Partial<Show> | null;
  }, Show>({
    adminFetch,
    request: (show, fetcher) => adminJson(fetcher, '/shows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show: showPayload(show) }),
    }),
    onDone: (result, submitted, client) => {
      const saved = result.show ? hydrateFullShow(result.show) : submitted;
      setServerShows(current => {
        const all = result.shows?.map(hydrateFullShow) ?? current;
        return all.some(show => show.id === saved.id)
          ? all
          : [...all, saved];
      });
      setShows(current => current.some(show => show.id === saved.id)
        ? current.map(show => show.id === saved.id ? saved : show)
        : [...current, saved]);
      if (result.shows) patchShowSettings(client, { shows: result.shows });
    },
    toastOnError: false,
  });
  const busy = saveScheduleMutation.isPending || saveGeneratedShowMutation.isPending;

  const saveWeek = async (): Promise<boolean> => {
    if (!schedule) return false;
    try {
      for (const show of dirtyGeneratedShows) {
        await saveGeneratedShowMutation.mutateAsync(show);
      }
      const j = await saveScheduleMutation.mutateAsync(cloneWeek(schedule));
      setSchedule(cloneWeek(j.schedule));
      setServerSchedule(cloneWeek(j.schedule));
      notify.ok(j.dropped
        ? `Week saved — ${j.dropped} slot(s) skipped (unsaved shows). The current hour applies on the next pick.`
        : dirtyGeneratedShows.length
          ? 'Week and generated show options saved — the current hour applies on the next pick.'
          : 'Week saved — the current hour applies on the next pick.');
      return true;
    } catch (e) {
      notify.err(scheduleWriteError(e));
      return false;
    }
  };

  const discardEdits = () => {
    if (serverSchedule) setSchedule(cloneWeek(serverSchedule));
    setShows(serverShows);
    setArmedShowId(null);
    setArmedTemplateId(null);
    setGeneratedOptionsDraft(null);
  };

  // ⌘S / Ctrl+S saves. Ref-held so the listener registers once but sees the current week.
  const chordSaveRef = useRef<() => boolean>(() => false);
  chordSaveRef.current = () => {
    if (dirty === 0 || busy) return false;
    void saveWeek();
    return true;
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return;
      // Swallow the browser's Save-page chord only when a week went out with it.
      if (chordSaveRef.current()) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useUnsavedGuard(dirty > 0, setPendingHref);

  const leaveTo = (href: string) => {
    setPendingHref(null);
    router.push(href);
  };

  const updateGeneratedDraft = (patch: Partial<ShowGenerationConfig>) => {
    setGeneratedOptionsDraft(current => current?.generation
      ? { ...current, generation: { ...current.generation, ...patch } }
      : current);
  };
  const updateGeneratedGuestCount = (patch: Partial<ShowGenerationConfig['guestCount']>) => {
    setGeneratedOptionsDraft(current => current?.generation
      ? {
          ...current,
          generation: {
            ...current.generation,
            guestCount: { ...current.generation.guestCount, ...patch },
          },
        }
      : current);
  };
  const applyGeneratedOptions = () => {
    if (!generatedOptionsDraft) return;
    if (generatedOptionsDraft.generation?.nameMode === 'custom' && !generatedOptionsDraft.generation.customName.trim()) {
      notify.err('Enter a custom episode name before applying these options.');
      return;
    }
    if (generatedOptionsDraft.generation?.template === 'common-ground') {
      const draft = generatedOptionsDraft;
      const eligibleIds = new Set(commonGroundPersonas.map(persona => persona.id));
      if (eligibleIds.size < 2 || (draft.generation!.hostMode === 'fixed' && !eligibleIds.has(draft.personaId))
        || (draft.generation!.guestMode === 'fixed' && (draft.guestPersonaIds.length !== 1
          || !eligibleIds.has(draft.guestPersonaIds[0]!)
          || (draft.generation!.hostMode === 'fixed' && draft.guestPersonaIds[0] === draft.personaId)))) {
        notify.err('Common Ground needs two distinct DJs enabled in Random Hosts. Choose one eligible guest.');
        return;
      }
    }
    if (editingTemplateOptions) {
      setTemplateOptions(generatedOptionsDraft);
      setArmedShowId(null);
      setArmedTemplateId(generatedOptionsDraft.generation!.template as GeneratedTemplateId);
      notify.ok('Template options ready — drag into the grid, then save the week.');
    } else {
      setShows(current => current.map(show => show.id === generatedOptionsDraft.id ? generatedOptionsDraft : show));
      notify.ok('Episode name, host and guest options updated — save the week to keep them.');
    }
    setGeneratedOptionsDraft(null);
  };

  const suggestions: Suggestion[] = useMemo(() => {
    if (!schedule) return [];
    const out: Suggestion[] = [];
    // Gap: a silent block some show already covers at the same hours on ≥4 other days.
    for (const d of DAYS) {
      for (const b of dayBlocks(schedule, d.key).filter(x => !x.showId)) {
        let best: { show: Show; count: number } | null = null;
        for (const s of shows) {
          let count = 0;
          for (const od of DAYS) {
            if (od.key === b.day) continue;
            let all = true;
            for (let h = b.start; h < b.start + b.span; h++)
              if (schedule[od.key]?.[h] !== s.id) { all = false; break; }
            if (all) count++;
          }
          if (count >= 4 && (!best || count > best.count)) best = { show: s, count };
        }
        if (best) {
          const { show } = best;
          out.push({
            key: `gap-${b.day}-${b.start}`,
            kind: 'Gap',
            text: `${dayName(b.day)} ${hhmm(b.start)} → ${hhmm(b.start + b.span)} is silent. ${showLabel(show)} covers that slot most other days.`,
            actionLabel: `Extend ${showLabel(show)}`,
            onAction: () => setSchedule(cur => cur ? setRange(cur, [b.day], b.start, b.start + b.span, show.id) : cur),
            dismissLabel: 'Leave it quiet',
          });
        }
      }
    }
    // Balance: a defined show with no airtime at all.
    for (const s of shows) {
      if (showHours(schedule, s.id) > 0) continue;
      const firstSilent = DAYS.flatMap(d => dayBlocks(schedule, d.key)).find(b => !b.showId);
      if (!firstSilent) continue;
      out.push({
        key: `bal-${s.id}`,
        kind: 'Balance',
        text: `${s.name} isn't on the schedule at all. Give it some airtime?`,
        actionLabel: 'Pick a slot',
        onAction: () => {
          pick(firstSilent);
          setLineShowId(s.id);
        },
        dismissLabel: 'Dismiss',
      });
    }
    return out.filter(sug => !dismissed.includes(sug.key)).slice(0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [schedule, shows, personas, dismissed]);

  const airtime = useMemo(() => {
    if (!schedule) return { rows: [], tickPct: 0 };
    const totals = new Map<string, Omit<AirtimeRow, 'pct' | 'under'>>();
    for (const show of shows) {
      const template = show.generation?.mode === 'generated' ? show.generation.template : null;
      const id = template ? `template:${template}` : show.id;
      const hours = showHours(schedule, show.id);
      const previous = totals.get(id);
      if (previous) previous.hours += hours;
      else totals.set(id, {
        id, hours,
        name: template ? GENERATED_SHOW_TEMPLATES.find(item => item.id === template)?.label ?? show.name : show.name,
        color: template ? generatedShowColor(template) : colorOf(show.id),
      });
    }
    const withHours = [...totals.values()];
    const maxHours = Math.max(0, ...withHours.map(row => row.hours));
    const scale = Math.max(maxHours, WEEKLY_TARGET * 1.4) * 1.06;
    return {
      rows: withHours
        .sort((a, b) => b.hours - a.hours)
        .map(row => ({
          ...row,
          pct: scale ? (row.hours / scale) * 100 : 0,
          under: row.hours < WEEKLY_TARGET,
        })),
      tickPct: scale ? (WEEKLY_TARGET / scale) * 100 : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [schedule, shows, personas]);

  if (err) {
    return (
      <div className="p-5">
        <Card title="Schedule" sub="the rundown">
          <ErrorState error={err} onRetry={load} />
        </Card>
      </div>
    );
  }
  if (!schedule) {
    return (
      <div className="p-5">
        <Card title="Schedule" sub="the rundown">
          <SkeletonRows rows={6} />
        </Card>
      </div>
    );
  }

  const curBlock = blockAt(schedule, nowDay, nowHour);
  const nextBlock = blockAhead(schedule, nowDay, nowHour, 1);
  const laterBlock = blockAhead(schedule, nowDay, nowHour, 2);
  const elapsedMin = (nowHour - curBlock.start) * 60 + stationMinute;
  const totalMin = curBlock.span * 60;
  const leftMin = Math.max(0, totalMin - elapsedMin);
  const leftLabel = leftMin > 59
    ? `${Math.floor(leftMin / 60)} h ${leftMin % 60} min left`
    : `${leftMin} min left`;

  const onAirShow = defaultTakeover ? null : pinnedShow ?? showById(curBlock.showId);
  const onAirColor = defaultTakeover
    ? null
    : pinnedShow ? colorOf(pinnedShow.id) : curBlock.showId ? colorOf(curBlock.showId) : null;

  const clockLabel = `${now.toLocaleDateString(locale, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: tz || undefined,
  })} · ${now.toLocaleTimeString(locale, { timeZone: tz || undefined })}`;
  const zoneLabel = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const editedRanges = serverSchedule ? diffRanges(schedule, serverSchedule) : [];
  const lineCurrent = blockAt(schedule, line.day, line.start);

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col bg-[var(--card-bg)]">
      <div className="border-b border-ink px-5 pt-4 pb-3.5 sm:px-[30px]">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="eyebrow whitespace-nowrap text-vermilion">Show plan · The Rundown</span>
            <span aria-hidden="true" className="hidden h-px w-[18px] bg-[color-mix(in_oklab,var(--ink)_28%,transparent)] sm:block" />
            <span className="font-mono text-[11.5px] font-bold tracking-[0.06em] text-ink">{clockLabel}</span>
            <Mu className="text-[9px]">{zoneLabel}</Mu>
          </div>
          <div className="ml-auto flex flex-none flex-wrap items-center gap-3 sm:flex-nowrap">
            <span className="hidden flex-none items-center gap-2 sm:flex">
              {dirty > 0 && <span aria-hidden="true" className="size-1.5 bg-[var(--accent)]" />}
              <Mu className={cn('text-[9px] whitespace-nowrap', dirty > 0 && 'text-ink')}>
                {dirty > 0 ? `${dirty} unsaved edit${dirty === 1 ? '' : 's'}` : 'all changes saved'}
              </Mu>
              {dirty > 0 && (
                <button
                  type="button"
                  onClick={() => setReviewOpen(true)}
                  className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[9px] tracking-[0.16em] text-muted uppercase underline hover:text-ink"
                >
                  Review
                </button>
              )}
            </span>
            <Button asChild variant="default" size="sm" className="min-h-9 sm:min-h-0">
              <Link href="/admin/shows">New show →</Link>
            </Button>
            <Button
              variant="accent"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={saveWeek}
              disabled={busy || dirty === 0}
            >
              {busy ? 'Saving…' : 'Save the week'}
            </Button>
          </div>
        </div>
        <h1 className="sr-only">The Rundown — programme the week, one hour at a time</h1>
        <Mu className="mt-1.5 block text-[9px] tracking-[0.1em]">
          Empty hours run autonomously · every change goes live on save
        </Mu>
      </div>

      <div className="border-b border-ink bg-[var(--page-bg)]">
        <div className="grid grid-cols-1 sm:grid-cols-3">
          <NowCell
            label={airingTakeover ? 'On air · takeover' : 'On air'}
            live
            time={airingTakeover
              ? `until ${fmtClock(airingTakeover.expiresAt, tz, locale)}`
              : `${hhmm(curBlock.start)} – ${hhmm(curBlock.start + curBlock.span)}`}
            left={airingTakeover ? undefined : leftLabel}
            name={defaultTakeover
              ? 'Default programming'
              : onAirShow ? onAirShow.name : 'Nobody in the chair'}
            color={onAirColor}
            meta={defaultTakeover
              ? 'autonomous music · default DJ'
              : metaOf(pinnedShow ? pinnedShow.id : curBlock.showId)}
            pct={airingTakeover ? undefined : Math.min(100, Math.round((elapsedMin / totalMin) * 100))}
          />
          <NowCell
            label="Up next"
            time={`${hhmm(nextBlock.start)} – ${hhmm(nextBlock.start + nextBlock.span)}`}
            name={nextBlock.showId ? showLabelOf(nextBlock.showId) : 'Nobody in the chair'}
            color={nextBlock.showId ? colorOf(nextBlock.showId) : null}
            meta={metaOf(nextBlock.showId)}
            // Last cell on a phone when "After that" is hidden; its own rule would
            // double up against the band's bottom edge.
            className="max-sm:border-b-0"
          />
          <NowCell
            label="After that"
            time={`${hhmm(laterBlock.start)} – ${hhmm(laterBlock.start + laterBlock.span)}`}
            name={laterBlock.showId ? showLabelOf(laterBlock.showId) : 'Nobody in the chair'}
            color={laterBlock.showId ? colorOf(laterBlock.showId) : null}
            meta={metaOf(laterBlock.showId)}
            last
            // Hidden on phones: three stacked cells cost ~190px before any of the week shows.
            className="hidden sm:block"
          />
        </div>

      </div>

      <div className="min-w-0 px-5 pt-[22px] sm:px-[30px]">
        <div ref={bandRef} className="mb-5 scroll-mt-4">
          <LineEditor
            shows={shows.map(show => show.generation?.mode === 'generated'
              ? { ...show, name: showLabel(show) }
              : show)}
            locale={locale}
            line={line}
            lineShowId={lineShowId}
            lineDays={lineDays.includes(line.day) ? lineDays : [...lineDays, line.day]}
            currentName={lineCurrent.showId ? showLabelOf(lineCurrent.showId) : null}
            colorOf={colorOf}
            onLineChange={patch => {
              setLine(cur => ({ ...cur, ...patch }));
              if (patch.day != null) setLineDays([patch.day]);
            }}
            onLineShow={setLineShowId}
            onToggleLineDay={d => setLineDays(cur =>
              cur.includes(d)
                ? (d === line.day ? cur : cur.filter(x => x !== d))
                : [...cur, d],
            )}
            // A preset replaces the set outright, so the sentence's day must move into
            // it or `applyLine` re-adds the old one.
            onSetLineDays={days => {
              setLineDays(days);
              if (!days.includes(line.day)) setLine(cur => ({ ...cur, day: days[0] ?? cur.day }));
            }}
            onAir={() => applyLine(lineShowId)}
            onQuiet={() => applyLine(null)}
            orderNo={orderNo}
          />
        </div>
      </div>
      <div className="min-w-0 pb-[30px]">
        <Board
          schedule={schedule}
          shows={shows}
          personas={personas}
          folded={folded}
          onToggleFold={d => setFolded(f => ({ ...f, [d]: !f[d] }))}
          todayKey={nowDay}
          nowMinute={nowHour * 60 + stationMinute}
          colorOf={colorOf}
          hoursOf={hoursOf}
          onPick={pick}
          onRemove={removeRun}
          onResize={resizeRun}
          onDropShow={dropShow}
          onDropTemplate={dropTemplate}
          onDragRun={dragRun}
          armedShowId={armedId}
          armedTemplateId={armedTemplateId}
          onArmShow={armShow}
          onArmTemplate={armTemplate}
          onFillDay={fillDay}
          onFillHour={fillHour}
          density={density}
          hourPx={BOARD_HOUR_PX[density]}
          onDensity={setDensity}
        />
      </div>
      <div className="flex-1 pb-1">
        <EditorBand
          stats={{
            booked,
            showCount: new Set(orders.map(o => o.showId)).size,
            orderCount: orders.length,
          }}
          suggestions={suggestions}
          onDismissSuggestion={key => setDismissed(cur => [...cur, key])}
          airtime={airtime.rows}
          tickPct={airtime.tickPct}
          target={WEEKLY_TARGET}
        />
      </div>

      <SaveBar
        dirty={dirty}
        busy={busy}
        onReview={() => setReviewOpen(true)}
        onDiscard={discardEdits}
        onSave={saveWeek}
      />

      <Modal
        open={generatedOptionsDraft !== null}
        onOpenChange={open => { if (!open) setGeneratedOptionsDraft(null); }}
        title={generatedOptionsDraft?.name ?? 'Template show'}
        sub={editingTemplateOptions ? "Options for new slots · saved when you save the week" : "Host, guest and episode name · saved with the week"}
        width={520}
        footer={(
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setGeneratedOptionsDraft(null)}>
              Cancel
            </Button>
            <span className="ml-auto">
              <Button variant="accent" size="sm" onClick={applyGeneratedOptions}>
                Apply options
              </Button>
            </span>
          </div>
        )}
      >
        {generatedOptionsDraft?.generation?.mode === 'generated' && (
          <GeneratedShowOptions
            show={generatedOptionsDraft}
            personas={generatedOptionsDraft.generation.template === 'common-ground' ? commonGroundPersonas : personas}
            apiBase={API_BASE}
            onHostChange={value => {
              setGeneratedOptionsDraft(current => current?.generation
                ? value === RANDOM_HOST
                  ? {
                      ...current,
                      generation: {
                        ...current.generation,
                        hostMode: 'random',
                      },
                    }
                  : {
                      ...current,
                      personaId: value,
                      guestPersonaIds: current.guestPersonaIds.filter(id => id !== value),
                      generation: {
                        ...current.generation,
                        hostMode: 'fixed',
                      },
                    }
                : current);
            }}
            onNameModeChange={value => updateGeneratedDraft({ nameMode: value })}
            onCustomNameChange={value => updateGeneratedDraft({ customName: value })}
            onGuestModeChange={value => {
              if (value === 'none') {
                setGeneratedOptionsDraft(current => current?.generation
                  ? {
                      ...current,
                      guestPersonaIds: [],
                      generation: {
                        ...current.generation,
                        guestMode: 'none',
                        guestCount: { min: 0, max: 0 },
                      },
                    }
                  : current);
              } else if (value === 'fixed') {
                updateGeneratedDraft({ guestMode: 'fixed' });
              } else {
                setGeneratedOptionsDraft(current => current?.generation
                  ? {
                      ...current,
                      guestPersonaIds: [],
                      generation: {
                        ...current.generation,
                        guestMode: 'random',
                        guestCount: current.generation.template === 'common-ground' ? { min: 1, max: 1 } : { min: 0, max: GUESTS_MAX },
                      },
                    }
                  : current);
              }
            }}
            onGuestsChange={guestPersonaIds => setGeneratedOptionsDraft(current => current?.generation
              ? { ...current, guestPersonaIds }
              : current)}
            onGuestCountChange={updateGeneratedGuestCount}
          />
        )}
      </Modal>

      <Modal
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        title="Unsaved edits"
        sub={`${dirty} unsaved change${dirty === 1 ? '' : 's'}`}
        width={560}
        footer={
          <div className="flex w-full items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                discardEdits();
                setReviewOpen(false);
              }}
            >
              Discard edits
            </Button>
            <span className="ml-auto">
              <Button
                variant="accent"
                size="sm"
                disabled={busy}
                onClick={async () => { if (await saveWeek()) setReviewOpen(false); }}
              >
                {busy ? 'Saving…' : 'Save the week'}
              </Button>
            </span>
          </div>
        }
      >
        <div className="grid gap-1">
          {editedRanges.length === 0 && dirtyGeneratedShows.length === 0 && (
            <Mu className="text-[9px]">Nothing pending — the week on air matches this screen.</Mu>
          )}
          {editedRanges.map(r => (
            <div
              key={`${r.day}-${r.start}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-separator-soft px-1 py-1.5"
            >
              <span className="w-[150px] flex-none font-mono text-[11px] font-bold tracking-[0.06em] text-muted">
                {dayName(r.day)} {hhmm(r.start)} – {hhmm(r.end)}
              </span>
              <span className="text-[12.5px] text-ink">
                {r.fromId ? showLabelOf(r.fromId) : 'silent'}
                {' → '}
                <b>{r.toId ? showLabelOf(r.toId) : 'silent'}</b>
              </span>
            </div>
          ))}
          {dirtyGeneratedShows.map(show => (
            <div
              key={`generated-${show.id}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-separator-soft px-1 py-1.5"
            >
              <span className="w-[150px] flex-none font-mono text-[11px] font-bold tracking-[0.06em] text-muted">
                {serverShowById.has(show.id) ? 'Show options' : 'New generated show'}
              </span>
              <span className="text-[12.5px] text-ink">
                {serverShowById.has(show.id) ? 'Updated' : 'Add'} <b>{showLabel(show)}</b> host and guest settings
              </span>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={pendingHref !== null}
        onOpenChange={open => { if (!open) setPendingHref(null); }}
        title="Leave without saving?"
        sub={`${dirty} unsaved change${dirty === 1 ? '' : 's'}`}
        width={520}
        footer={
          <div className="flex w-full flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendingHref(null)}>
              Stay here
            </Button>
            <span className="ml-auto flex flex-wrap gap-2">
              <Button
                variant="default"
                size="sm"
                disabled={busy}
                onClick={() => { if (pendingHref) leaveTo(pendingHref); }}
              >
                Discard and leave
              </Button>
              <Button
                variant="accent"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  const href = pendingHref;
                  // A failed save keeps the operator here with the edits.
                  if (href && await saveWeek()) leaveTo(href);
                }}
              >
                {busy ? 'Saving…' : 'Save and leave'}
              </Button>
            </span>
          </div>
        }
      >
        <div className="grid gap-2">
          <span className="text-[13px] leading-[1.6] text-ink">
            These edits only exist on this screen. Leave now and the station keeps
            running the week it already has.
          </span>
          <Mu className="text-[9px]">
            {editedRanges.slice(0, 4).map(r => `${dayName(r.day)} ${hhmm(r.start)}–${hhmm(r.end)}`).join(' · ')}
            {editedRanges.length > 4 ? ` · +${editedRanges.length - 4} more` : ''}
          </Mu>
          {dirtyGeneratedShows.length > 0 && (
            <Mu className="text-[9px]">
              {dirtyGeneratedShows.map(show => showLabel(show)).join(' · ')} host and guest options
            </Mu>
          )}
        </div>
      </Modal>
    </div>
  );
}

function NowCell({
  label, live, time, left, name, color, meta, pct, last, className,
}: {
  label: string;
  live?: boolean;
  time: string;
  left?: string;
  name: string;
  color: string | null;
  meta: string;
  pct?: number;
  last?: boolean;
  className?: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(barRef, { width: `${pct ?? 0}%` });
  return (
    <div
      className={cn(
        'min-w-0 px-5 py-2 sm:px-[22px]',
        // Stacked at grid-cols-1 the divider runs along the bottom; column rule returns at sm.
        !last && 'border-b border-separator-strong sm:border-r sm:border-b-0',
        className,
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        {live && <span aria-hidden="true" className="size-[7px] flex-none rounded-full bg-[var(--accent)]" />}
        <span className={cn('eyebrow min-w-0 truncate', live ? 'text-vermilion' : 'text-muted')}>{label}</span>
        {left && <Mu className="ml-auto flex-none text-[8.5px] whitespace-nowrap">{left}</Mu>}
        <span
          className={cn(
            'flex-none font-mono text-[11px] font-bold tracking-[0.06em] whitespace-nowrap text-ink',
            !left && 'ml-auto',
          )}
        >
          {time}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <ColorChip color={color} className="size-[11px] self-center" />
        <span className="max-w-[70%] flex-none overflow-hidden font-display text-[17px] leading-none font-semibold text-ellipsis whitespace-nowrap text-ink">
          {name}
        </span>
        <Mu className="min-w-0 truncate text-[8.5px]">{meta}</Mu>
      </div>
      {pct != null ? (
        <div className="mt-1.5 flex h-[3px] gap-0.5">
          <div ref={barRef} className="bg-ink" />
          <div className="flex-1 bg-[color-mix(in_oklab,var(--ink)_16%,transparent)]" />
        </div>
      ) : (
        <div className="mt-1.5 h-[3px] bg-[var(--ink-soft)]" />
      )}
    </div>
  );
}

function GeneratedShowOptions({
  show,
  personas,
  apiBase,
  onNameModeChange,
  onCustomNameChange,
  onHostChange,
  onGuestModeChange,
  onGuestsChange,
  onGuestCountChange,
}: {
  show: Show;
  personas: Persona[];
  apiBase: string;
  onNameModeChange: (value: 'random' | 'custom') => void;
  onCustomNameChange: (value: string) => void;
  onHostChange: (value: string) => void;
  onGuestModeChange: (value: string) => void;
  onGuestsChange: (ids: string[]) => void;
  onGuestCountChange: (patch: Partial<ShowGenerationConfig['guestCount']>) => void;
}) {
  const generation = show.generation!;
  const guestCount = generation.guestCount;
  const commonGround = generation.template === 'common-ground';
  const solo = generation.template === 'outside-comfort-zone';
  return (
    <div className="grid gap-5">
      <p className="text-[13px] leading-[1.6] text-ink">
        {GENERATED_SHOW_TEMPLATES.find(template => template.id === generation.template)?.description}
      </p>
      <p className="text-[12px] leading-[1.6] text-muted">
        {solo ? 'Choose the episode name and solo host. Random Host uses the pool in Sub/Shows settings.' : commonGround
          ? 'Choose the host and one guest. Both DJs must be enabled in Sub/Shows → Random Hosts.'
          : 'Choose the episode name, host and guest count. Random DJs draw from the pools in Sub/Shows settings.'}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <Label htmlFor="generated-show-name-mode">Episode name</Label>
          <Select value={generation.nameMode} onValueChange={value => onNameModeChange(value as 'random' | 'custom')}>
            <SelectTrigger id="generated-show-name-mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="random">Random show name</SelectItem>
              <SelectItem value="custom">Use a custom name</SelectItem>
            </SelectContent>
          </Select>
          {generation.nameMode === 'custom' && (
            <Input
              aria-label="Custom episode name"
              value={generation.customName}
              onChange={event => onCustomNameChange(event.target.value)}
              maxLength={60}
              placeholder="Episode name"
            />
          )}
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor="generated-show-host">Host</Label>
          <Select
            value={generation.hostMode === 'random' ? RANDOM_HOST : show.personaId}
            onValueChange={onHostChange}
          >
            <SelectTrigger id="generated-show-host"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={RANDOM_HOST}>Random Host</SelectItem>
              {personas.map(persona => (
                <SelectItem key={persona.id} value={persona.id}>{persona.name || 'Unnamed DJ'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {!solo && <div className="grid content-start gap-2">
          <Label htmlFor="generated-show-guests">{commonGround ? 'Guest' : 'Guests'}</Label>
          <Select value={generation.guestMode} onValueChange={onGuestModeChange}>
            <SelectTrigger id="generated-show-guests"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="random">{commonGround ? 'One random guest' : 'Random Guests'}</SelectItem>
              {!commonGround && <SelectItem value="none">No guests</SelectItem>}
              <SelectItem value="fixed">{commonGround ? 'Choose one guest' : 'Selected guests'}</SelectItem>
            </SelectContent>
          </Select>
          {generation.guestMode === 'fixed' && (
            <div className="grid gap-2">
              <Label className="text-xs">{commonGround ? 'Choose one guest' : `Choose up to ${GUESTS_MAX} guests`}</Label>
              <GuestPersonaPicker
                personas={personas.filter(persona => generation.hostMode === 'random' || persona.id !== show.personaId)}
                value={show.guestPersonaIds}
                onChange={onGuestsChange}
                apiBase={apiBase}
                max={commonGround ? 1 : GUESTS_MAX}
              />
              {personas.length <= (generation.hostMode === 'random' ? 0 : 1) && (
                <Mu className="text-[9px]">Add another DJ before choosing a fixed guest.</Mu>
              )}
            </div>
          )}
          {generation.guestMode === 'random' && !commonGround && (
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="generated-show-guest-min" className="text-xs">Minimum</Label>
                <Select
                  value={String(guestCount.min)}
                  onValueChange={value => {
                    const min = Number(value);
                    onGuestCountChange({ min, max: Math.max(min, guestCount.max) });
                  }}
                >
                  <SelectTrigger id="generated-show-guest-min"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: GUESTS_MAX + 1 }, (_, count) => count).map(count => (
                      <SelectItem key={count} value={String(count)}>{count}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="generated-show-guest-max" className="text-xs">Maximum</Label>
                <Select
                  value={String(guestCount.max)}
                  onValueChange={value => {
                    const max = Number(value);
                    onGuestCountChange({ max, min: Math.min(guestCount.min, max) });
                  }}
                >
                  <SelectTrigger id="generated-show-guest-max"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: GUESTS_MAX + 1 }, (_, count) => count)
                      .filter(count => count >= guestCount.min)
                      .map(count => <SelectItem key={count} value={String(count)}>{count}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {generation.guestMode === 'fixed' && (
            <Mu className="text-[9px]">{commonGround ? 'Exactly one guest is required.' : 'Uses the guests already selected for this show.'}</Mu>
          )}
        </div>}
      </div>
      <Mu className="text-[9px]">{solo ? 'One host explores one neighbouring musical destination, with no guests.' : commonGround ? 'Common Ground always pairs two different DJs with equal musical influence.' : `Random Guests can range from 0 to ${GUESTS_MAX}. The selected host is never added as their own guest.`}</Mu>
    </div>
  );
}
