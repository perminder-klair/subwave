'use client';

// The Rundown — /admin/shows/schedule. Renders the controller's 7×24 `schedule`
// grid from GET /settings; every edit is local until PUT /schedule saves the week.
//
// Takeovers (#930) live on the dash, not here. This screen only READS the pin in
// force: it outranks the grid in the controller's resolveActiveShow, so the On air
// cell would otherwise name a show that is not on the air.

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
import { Modal } from '../../ui/modal';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Card } from '../ui';
import Board from './Board';
import SaveBar from './SaveBar';
import EditorBand, { LineEditor } from './EditorBand';
import type { EditorLine, Suggestion } from './EditorBand';
import { ColorChip, Mu } from './bits';
import type { Block, Schedule, ScheduleShow } from './lib';
import {
  DAYS, SHOW_COLORS, blockAhead, blockAt, bookedHours, cloneWeek, dayBlocks,
  dayName, diffCells, diffRanges, emptyWeek, fillDayToggle, fillHourToggle,
  hhmm, resizeBlock, setRange, showHours, weekOrders,
} from './lib';
import { settingsKeys, useSettingsQuery } from '../settings/queries';
import { scheduleKeys, useScheduleOverrideQuery } from './queries';
import { isDefaultTakeover, takeoverShowId } from '@/lib/schemas.generated';

/** The airtime-bar tick — hours a show "should" get in a week. */
const WEEKLY_TARGET = 12;

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
    shows?: Array<Record<string, unknown>>;
    schedule?: Schedule;
    personas?: Persona[];
    timezone?: string;
    locale?: StationLocale;
  };
  serverTimezone?: string;
}

// Legacy singular fields still hydrate as one-element lists (same coercion as
// ShowsPanel).
function hydrateShow(raw: Record<string, unknown>): ScheduleShow | null {
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  return {
    id,
    name: name || 'untitled',
    personaId: typeof raw.personaId === 'string' ? raw.personaId : '',
    moods: Array.isArray(raw.moods)
      ? (raw.moods as string[])
      : typeof raw.mood === 'string' && raw.mood ? [raw.mood] : [],
    energies: Array.isArray(raw.energies)
      ? (raw.energies as string[])
      : typeof raw.energy === 'string' && raw.energy ? [raw.energy] : [],
  };
}

export default function SchedulePanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const router = useRouter();
  const [shows, setShows] = useState<ScheduleShow[]>([]);
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
  const err = settingsQuery.error && !schedule ? errorMessage(settingsQuery.error) : null;

  // Board columns collapsed to rails, keyed by storage day (0=Sun..6=Sat).
  const [folded, setFolded] = useState<Record<number, boolean>>({});
  // The line editor sits above the fold, so a pick from deep in the board has to
  // scroll it into view.
  const bandRef = useRef<HTMLDivElement>(null);

  const [line, setLine] = useState<EditorLine>({ day: 6, start: 16, end: 18 });
  const [lineShowId, setLineShowId] = useState<string | null>(null);
  const [lineDays, setLineDays] = useState<number[]>([6]);

  // The armed show — the shelf chip acting as a brush (#1204). Its own state, not
  // `lineShowId`: that is set by every card click, so hanging the day/hour bulk
  // fills off it would let a stray day-header click rewrite 24 hours.
  const [armedShowId, setArmedShowId] = useState<string | null>(null);
  const [density, setDensity] = useBoardDensity();

  const [dismissed, setDismissed] = useState<string[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  // The live takeover (#930), read-only here — pinning and cancelling live on the dash.
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
        .map(hydrateShow)
        .filter((s): s is ScheduleShow => !!s);
      setShows(loaded);
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

  // A query refresh may update roster metadata, but it cannot overwrite this
  // mount's unsaved week. Navigation remounts from the newest cache entry.
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
    const idx = id ? shows.findIndex(s => s.id === id) : -1;
    return idx >= 0 ? (SHOW_COLORS[idx % SHOW_COLORS.length] ?? 'transparent') : 'transparent';
  };
  const showById = (id: string | null) => shows.find(s => s.id === id) ?? null;
  const personaName = (id: string) => personas.find(p => p.id === id)?.name || '—';
  // Bare values only — "Saaya · night · low", no field labels.
  const metaOf = (id: string | null): string => {
    const s = showById(id);
    if (!s) return 'the station runs itself';
    const bits = [personaName(s.personaId), s.moods.join(', ')];
    if (s.energies.length) bits.push(s.energies.join(', '));
    return bits.filter(Boolean).join(' · ');
  };
  const hoursOf = (id: string) => (schedule ? showHours(schedule, id) : 0);

  const booked = schedule ? bookedHours(schedule) : 0;
  const orders = useMemo(() => (schedule ? weekOrders(schedule) : []), [schedule]);
  const dirty = schedule && serverSchedule ? diffCells(schedule, serverSchedule) : 0;

  const liveOverride = override && override.expiresAt > now.getTime() ? override : null;
  const pinnedShowId = takeoverShowId(liveOverride);
  const pinnedShow = pinnedShowId ? showById(pinnedShowId) : null;
  const defaultTakeover = isDefaultTakeover(liveOverride);
  // A takeover only OWNS this header when it resolves to something really on
  // air — a named show still in the roster, or Default programming. A target
  // that names neither voids the takeover (the same rule the controller's
  // getScheduleOverride applies), and the weekly grid is what is playing, so
  // claiming "On air · takeover" over the grid show's name would be the false
  // claim #1507's Rundown criterion forbids.
  const airingTakeover = liveOverride && (pinnedShow || defaultTakeover) ? liveOverride : null;

  // Resolve through the roster rather than trusting the id: a show deleted in
  // another tab would leave a dangling brush that writes an unrenderable id.
  const armedShow = armedShowId ? showById(armedShowId) : null;
  const armedId = armedShow?.id ?? null;

  /** The sentence editor follows the brush, so the two editing paths never
   *  disagree about which show is in hand. */
  const armShow = (id: string) => {
    setArmedShowId(cur => (cur === id ? null : id));
    setLineShowId(id);
  };

  useEffect(() => {
    if (!armedId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // A Radix layer that consumed this Escape preventDefaults it from a
      // document-capture listener before this bubble listener runs — closing an
      // overlay must not also drop the brush.
      if (e.key === 'Escape' && !e.defaultPrevented) setArmedShowId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [armedId]);

  /** Day header with a show armed: all 24 hours, or clear when the day already
   *  runs nothing else, so a second click undoes the first. */
  const fillDay = (day: number) => {
    if (!schedule || !armedShow) return;
    const next = fillDayToggle(schedule, day, armedShow.id);
    setSchedule(next);
    const cleared = (next[day] ?? []).every(c => c == null);
    notify.ok(cleared
      ? `${dayName(day)} cleared — unsaved until you save the week.`
      : `“${armedShow.name}” across ${dayName(day)} — unsaved until you save the week.`);
  };

  /** Gutter hour with a show armed: that hour every day, same toggle-off rule. */
  const fillHour = (hour: number) => {
    if (!schedule || !armedShow) return;
    const next = fillHourToggle(schedule, hour, armedShow.id);
    setSchedule(next);
    const cleared = DAYS.every(d => next[d.key]?.[hour] == null);
    notify.ok(cleared
      ? `${hhmm(hour)} cleared all week — unsaved until you save the week.`
      : `“${armedShow.name}” at ${hhmm(hour)} every day — unsaved until you save the week.`);
  };

  const pick = (b: Block) => {
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(b.showId ?? lineShowId ?? shows[0]?.id ?? null);
    // block: 'nearest' makes this a no-op when the order desk is already visible.
    bandRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const applyLine = (value: string | null) => {
    if (!schedule) return;
    const days = lineDays.includes(line.day) ? lineDays : [...lineDays, line.day];
    setSchedule(setRange(schedule, days, line.start, line.end, value));
  };

  // Booking was the one write on this board that confirmed nothing. Filling a
  // day, filling an hour, resizing and removing all toast; the single most
  // common action did not, so the brush — the only booking path a finger or a
  // keyboard has — landed silently. Sonner's toast is also the live region, so
  // that silence was a screen reader hearing nothing at all for the write it is
  // most likely to make. Same sentence shape as its siblings, deliberately.
  const dropShow = (b: Block, showId: string) => {
    if (!schedule || !showById(showId)) return;
    setSchedule(setRange(schedule, [b.day], b.start, b.start + b.span, showId));
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(showId);
    notify.ok(
      `“${showById(showId)?.name ?? 'show'}” now ${dayName(b.day)} ${hhmm(b.start)} – ${hhmm(b.start + b.span)} — unsaved until you save the week.`,
    );
  };

  // Vacated hours fall silent; gained ones overwrite whatever was there, so a run
  // grown into its neighbour takes those hours rather than stopping short.
  const resizeRun = (b: Block, start: number, end: number) => {
    if (!schedule || !b.showId) return;
    setSchedule(resizeBlock(schedule, b, start, end));
    setLine({ day: b.day, start, end });
    setLineDays([b.day]);
    setLineShowId(b.showId);
    notify.ok(
      `“${showById(b.showId)?.name ?? 'show'}” now ${dayName(b.day)} ${hhmm(start)} – ${hhmm(end)} — unsaved until you save the week.`,
    );
  };

  // The removed line lands in the order desk with the show preselected, so a
  // mis-click is one "Add to schedule" away from restored.
  const removeRun = (b: Block) => {
    if (!schedule || !b.showId) return;
    setSchedule(setRange(schedule, [b.day], b.start, b.start + b.span, null));
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(b.showId);
    notify.ok(
      `“${showById(b.showId)?.name ?? 'show'}” off ${dayName(b.day)} ${hhmm(b.start)} – ${hhmm(b.start + b.span)} — unsaved until you save the week.`,
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
  const busy = saveScheduleMutation.isPending;

  const saveWeek = async (): Promise<boolean> => {
    if (!schedule) return false;
    try {
      const j = await saveScheduleMutation.mutateAsync(cloneWeek(schedule));
      setSchedule(cloneWeek(j.schedule));
      setServerSchedule(cloneWeek(j.schedule));
      notify.ok(j.dropped
        ? `Week saved — ${j.dropped} slot(s) skipped (unsaved shows). The current hour applies on the next pick.`
        : 'Week saved — the current hour applies on the next pick.');
      return true;
    } catch (e) {
      notify.err(scheduleWriteError(e));
      return false;
    }
  };

  const discardEdits = () => {
    if (serverSchedule) setSchedule(cloneWeek(serverSchedule));
  };

  // ⌘S / Ctrl+S saves. Held in a ref so the listener registers once yet always
  // sees the current week.
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

  const suggestions: Suggestion[] = useMemo(() => {
    if (!schedule) return [];
    const out: Suggestion[] = [];
    // Gap: a silent block some show already covers at the same hours on ≥4 other days.
    for (const d of DAYS) {
      for (const b of dayBlocks(schedule, d.key).filter(x => !x.showId)) {
        let best: { show: ScheduleShow; count: number } | null = null;
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
            text: `${dayName(b.day)} ${hhmm(b.start)} → ${hhmm(b.start + b.span)} is silent. ${show.name} covers that slot most other days.`,
            actionLabel: `Extend ${show.name}`,
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
  }, [schedule, shows, dismissed]);

  const airtime = useMemo(() => {
    if (!schedule) return { rows: [], tickPct: 0 };
    const withHours = shows.map(s => ({ s, hours: showHours(schedule, s.id) }));
    const maxHours = Math.max(0, ...withHours.map(x => x.hours));
    const scale = Math.max(maxHours, WEEKLY_TARGET * 1.4) * 1.06;
    return {
      rows: withHours
        .sort((a, b) => b.hours - a.hours)
        .map(({ s, hours }) => ({
          id: s.id,
          name: s.name,
          color: colorOf(s.id),
          hours,
          pct: scale ? (hours / scale) * 100 : 0,
          under: hours < WEEKLY_TARGET,
        })),
      tickPct: scale ? (WEEKLY_TARGET / scale) * 100 : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule, shows]);

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
          {/* Phones get the status and Save from the sticky `SaveBar` alone —
              repeating them here costs a row of a 24-hour screen. */}
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
        {/* Headline is sr-only: every row of chrome above the 24-hour board costs
            a row of the week, and the eyebrow already names the page. */}
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
            name={showById(nextBlock.showId)?.name ?? 'Nobody in the chair'}
            color={nextBlock.showId ? colorOf(nextBlock.showId) : null}
            meta={metaOf(nextBlock.showId)}
            // With "After that" hidden this is a phone's last cell, so its own
            // rule would double up against the band's bottom edge.
            className="max-sm:border-b-0"
          />
          <NowCell
            label="After that"
            time={`${hhmm(laterBlock.start)} – ${hhmm(laterBlock.start + laterBlock.span)}`}
            name={showById(laterBlock.showId)?.name ?? 'Nobody in the chair'}
            color={laterBlock.showId ? colorOf(laterBlock.showId) : null}
            meta={metaOf(laterBlock.showId)}
            last
            // Three stacked cells cost ~190px of a phone screen before any of the
            // week is visible, and this hour is already in the board below.
            className="hidden sm:block"
          />
        </div>

      </div>

      <div className="min-w-0 px-5 pt-[22px] sm:px-[30px]">
        <div ref={bandRef} className="mb-5 scroll-mt-4">
          <LineEditor
            shows={shows}
            line={line}
            lineShowId={lineShowId}
            lineDays={lineDays.includes(line.day) ? lineDays : [...lineDays, line.day]}
            currentName={showById(lineCurrent.showId)?.name ?? null}
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
            // A preset replaces the set outright, so the sentence's own day has to
            // move into it — otherwise `applyLine` re-adds the old one and
            // "Weekdays" quietly writes Saturday too.
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
          folded={folded}
          onToggleFold={d => setFolded(f => ({ ...f, [d]: !f[d] }))}
          todayKey={nowDay}
          colorOf={colorOf}
          hoursOf={hoursOf}
          onPick={pick}
          onRemove={removeRun}
          onResize={resizeRun}
          onDropShow={dropShow}
          armedShowId={armedId}
          onArmShow={armShow}
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
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        title="Unsaved edits"
        sub={`${dirty} hour${dirty === 1 ? '' : 's'} changed`}
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
          {editedRanges.length === 0 && (
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
                {showById(r.fromId)?.name ?? 'silent'}
                {' → '}
                <b>{showById(r.toId)?.name ?? 'silent'}</b>
              </span>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={pendingHref !== null}
        onOpenChange={open => { if (!open) setPendingHref(null); }}
        title="Leave without saving?"
        sub={`${dirty} hour${dirty === 1 ? '' : 's'} changed`}
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
        // Stacked at grid-cols-1, so the divider runs along the bottom; the column
        // rule comes back with the 3-up grid at sm.
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
