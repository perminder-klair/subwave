'use client';

// The Rundown — /admin/shows/schedule. The dedicated full-screen show-plan
// view: a live header, the On air / Up next / After that band with the
// takeover control, the full-width board (7 × 24 kanban), and the order desk
// beneath it with the sentence-based order editor.
//
// The data model is unchanged: the controller's 7×24 `schedule` grid from
// GET /settings, persisted with PUT /schedule ("Save the week"). Every edit
// on this screen — sentence editor, drag-and-drop, suggestions, the add-show
// dialog — is a local range write until the week is saved. The takeover strip
// drives the same /schedule/override endpoints the shows page used (#930).

import type { ChangeEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { fmtClock, normalizeStationLocale, zonedDayHour } from '../../../lib/format';
import type { StationLocale } from '../../../lib/types';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/modal';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Card } from '../ui';
import Board from './Board';
import EditorBand from './EditorBand';
import type { EditorLine, Suggestion } from './EditorBand';
import AddShowDialog from './AddShowDialog';
import { ColorChip, Mu, SegBtn, SlotMenu } from './bits';
import type { Block, Schedule, ScheduleShow } from './lib';
import {
  DAYS, SHOW_COLORS, blockAhead, blockAt, bookedHours, cloneWeek, dayBlocks,
  dayName, diffCells, diffRanges, emptyWeek, hhmm, setRange, showHours,
  weekOrders,
} from './lib';

/** The airtime-bar tick — hours a show "should" get in a week. */
const WEEKLY_TARGET = 12;

// Mirror the controller's OVERRIDE_MIN/MAX_MINUTES (settings.ts).
const PIN_MIN_MINUTES = 15;
const PIN_MAX_MINUTES = 720;
const PIN_PRESETS = [
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
  { minutes: 180, label: '3h' },
];

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

/** Timed takeover (#930): one show pinned over the grid until `expiresAt`. */
interface ScheduleOverride {
  showId: string;
  startedAt: number;
  expiresAt: number;
}

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 's_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// The slice of a persisted show this screen needs; legacy singular fields
// still hydrate as one-element lists (same coercion as ShowsPanel).
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
  const [err, setErr] = useState<string | null>(null);
  const [shows, setShows] = useState<ScheduleShow[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [serverSchedule, setServerSchedule] = useState<Schedule | null>(null);
  const [tz, setTz] = useState<string | undefined>(undefined);
  const [locale, setLocale] = useState<StationLocale>(normalizeStationLocale(undefined));
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Board folds, keyed by storage day (0=Sun..6=Sat).
  const [folded, setFolded] = useState<Record<number, boolean>>({});
  // The order desk below the board — scrolled into view when a board pick
  // loads it, since it can sit below the fold.
  const bandRef = useRef<HTMLDivElement>(null);

  // The sentence editor — the line being edited plus the show the sentence
  // would place and the day set it applies to.
  const [line, setLine] = useState<EditorLine>({ day: 6, start: 16, end: 18 });
  const [lineShowId, setLineShowId] = useState<string | null>(null);
  const [lineDays, setLineDays] = useState<number[]>([6]);

  const [dismissed, setDismissed] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  // Takeover (#930).
  const [override, setOverride] = useState<ScheduleOverride | null>(null);
  const [pinShowId, setPinShowId] = useState('');
  const [pinMinutes, setPinMinutes] = useState(60);
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const load = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) throw new Error(`failed (${r.status})`);
      const j = (await r.json()) as SettingsResponse;
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
      setErr(null);
      // Open the editor on the block on air right now, station time.
      const { dow, hour } = zonedDayHour(new Date(), j.values?.timezone || j.serverTimezone);
      const b = blockAt(week, dow, hour);
      setLine({ day: b.day, start: b.start, end: b.start + b.span });
      setLineDays([b.day]);
      setLineShowId(b.showId ?? loaded[0]?.id ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    load();
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // The live takeover, if any (GET /schedule; expired/absent → null).
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/schedule');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { override?: ScheduleOverride | null };
        if (j.override) setOverride(j.override);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── derived ──────────────────────────────────────────────────────────────
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
  const metaOf = (id: string | null): string => {
    const s = showById(id);
    if (!s) return 'the station runs itself';
    const bits = [`persona · ${personaName(s.personaId)}`, `mood · ${s.moods.join(', ') || 'any'}`];
    if (s.energies.length) bits.push(s.energies.join(', '));
    return bits.join(' · ');
  };
  const hoursOf = (id: string) => (schedule ? showHours(schedule, id) : 0);

  const booked = schedule ? bookedHours(schedule) : 0;
  const orders = useMemo(() => (schedule ? weekOrders(schedule) : []), [schedule]);
  const dirty = schedule && serverSchedule ? diffCells(schedule, serverSchedule) : 0;

  const liveOverride = override && override.expiresAt > now.getTime() ? override : null;
  const pinnedShow = liveOverride ? showById(liveOverride.showId) : null;

  // ── editor actions ───────────────────────────────────────────────────────
  const pick = (b: Block) => {
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(b.showId ?? lineShowId ?? shows[0]?.id ?? null);
    // Bring the order desk into view when picking from the board — no-op when
    // it is already visible (block: 'nearest').
    bandRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const applyLine = (value: string | null) => {
    if (!schedule) return;
    const days = lineDays.includes(line.day) ? lineDays : [...lineDays, line.day];
    setSchedule(setRange(schedule, days, line.start, line.end, value));
  };

  const dropShow = (b: Block, showId: string) => {
    if (!schedule || !showById(showId)) return;
    setSchedule(setRange(schedule, [b.day], b.start, b.start + b.span, showId));
    setLine({ day: b.day, start: b.start, end: b.start + b.span });
    setLineDays([b.day]);
    setLineShowId(showId);
  };

  // Where the edited line would sit in the week's order stack.
  const orderNo = useMemo(() => {
    const dayIdx = (d: number) => DAYS.findIndex(x => x.key === d);
    return orders.filter(o =>
      dayIdx(o.day) < dayIdx(line.day) ||
      (o.day === line.day && o.start < line.start),
    ).length + 1;
  }, [orders, line]);

  // ── persistence ──────────────────────────────────────────────────────────
  const saveWeek = async (): Promise<boolean> => {
    if (!schedule) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; dropped?: number };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setServerSchedule(cloneWeek(schedule));
      notify.ok(j.dropped
        ? `Week saved — ${j.dropped} slot(s) skipped (unsaved shows). The current hour applies on the next pick.`
        : 'Week saved — the current hour applies on the next pick.');
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  // Create a brand-new show inline (the add-show dialog's "Brand new show"
  // row) — a minimal definition owned by the first persona; everything else
  // is tuned on the Shows page.
  const createShow = async (name: string): Promise<ScheduleShow | null> => {
    const personaId = personas[0]?.id || '';
    if (!personaId) {
      notify.err('Create a persona first — every show needs a host.');
      return null;
    }
    try {
      const r = await adminFetch('/shows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          show: {
            id: clientMintId(), name, topic: '', personaId,
            guestPersonaIds: [], banter: false, moods: [], themeId: '',
            genres: [], eras: [], energies: [], filtersStrict: false,
            maxTrackSeconds: null, playlistIds: [], playlistStrict: false,
            excludedPlaylistIds: [], programme: false, segmentSkill: '',
          },
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; show?: Record<string, unknown> | null };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const saved = j.show ? hydrateShow(j.show) : null;
      if (!saved) throw new Error('unexpected response');
      setShows(cur => [...cur, saved]);
      notify.ok(`“${saved.name}” created — hosted by ${personaName(personaId)}. Fine-tune it on the Shows page.`);
      return saved;
    } catch (e) {
      notify.err(`Create failed: ${errorMessage(e)}`);
      return null;
    }
  };

  // ── takeover ─────────────────────────────────────────────────────────────
  const pinShow = async () => {
    if (!pinShowId) return;
    setPinBusy(true);
    try {
      const r = await adminFetch('/schedule/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId: pinShowId, minutes: pinMinutes }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; override?: ScheduleOverride };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setOverride(j.override ?? null);
      const name = showById(pinShowId)?.name || 'show';
      notify.ok(`“${name}” takes over — the switch airs on the next track.`);
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setPinBusy(false); }
  };

  const cancelPin = async () => {
    setPinBusy(true);
    try {
      const r = await adminFetch('/schedule/override', { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setOverride(null);
      notify.ok('Takeover cancelled — back to the weekly schedule.');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally { setPinBusy(false); }
  };

  // ── suggestions ──────────────────────────────────────────────────────────
  const suggestions: Suggestion[] = useMemo(() => {
    if (!schedule) return [];
    const out: Suggestion[] = [];
    // Gap: a silent block some show already covers at the same hours on most
    // other days — offer to extend it over the gap.
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

  // ── airtime bars ─────────────────────────────────────────────────────────
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

  // ── shells ───────────────────────────────────────────────────────────────
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

  // ── now band derivations ─────────────────────────────────────────────────
  const curBlock = blockAt(schedule, nowDay, nowHour);
  const nextBlock = blockAhead(schedule, nowDay, nowHour, 1);
  const laterBlock = blockAhead(schedule, nowDay, nowHour, 2);
  const elapsedMin = (nowHour - curBlock.start) * 60 + stationMinute;
  const totalMin = curBlock.span * 60;
  const leftMin = Math.max(0, totalMin - elapsedMin);
  const leftLabel = leftMin > 59
    ? `${Math.floor(leftMin / 60)} h ${leftMin % 60} min left`
    : `${leftMin} min left`;

  const onAirShow = pinnedShow ?? showById(curBlock.showId);
  const onAirColor = pinnedShow ? colorOf(pinnedShow.id) : curBlock.showId ? colorOf(curBlock.showId) : null;

  const clockLabel = `${now.toLocaleDateString(locale, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    timeZone: tz || undefined,
  })} · ${now.toLocaleTimeString(locale, { timeZone: tz || undefined })}`;
  const zoneLabel = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const editedRanges = serverSchedule ? diffRanges(schedule, serverSchedule) : [];
  const lineCurrent = blockAt(schedule, line.day, line.start);

  return (
    <div className="flex min-h-full min-w-0 flex-1 flex-col bg-[var(--card-bg)]">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 border-b border-ink px-[30px] pt-4 pb-3.5">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="eyebrow text-vermilion">Show plan · The Rundown</span>
            <span aria-hidden="true" className="h-px w-[18px] bg-[color-mix(in_oklab,var(--ink)_28%,transparent)]" />
            <span className="font-mono text-[11.5px] font-bold tracking-[0.06em] text-ink">{clockLabel}</span>
            <Mu className="text-[9px]">{zoneLabel}</Mu>
          </div>
          <h1 className="m-0 font-display text-[33px] leading-none font-semibold tracking-[-0.015em]">
            Programme the week, one hour at a time.
          </h1>
          <Mu className="text-[9px] tracking-[0.1em]">
            Empty hours run autonomously · every change goes live on save
          </Mu>
        </div>
        <div className="flex flex-none items-end gap-6">
          <div className="flex gap-5">
            <HeaderStat n={booked} label="hours scheduled" />
            <HeaderStat n={168 - booked} label="silent" accent />
            <HeaderStat n={orders.length} label="standing orders" />
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              {dirty > 0 && <span aria-hidden="true" className="size-1.5 bg-[var(--accent)]" />}
              <Mu className={cn('text-[9px]', dirty > 0 && 'text-ink')}>
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
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => window.print()}>
                Print / share
              </Button>
              <Button variant="default" size="sm" onClick={() => setAddOpen(true)}>
                + Add a show
              </Button>
              <Button variant="accent" size="sm" onClick={saveWeek} disabled={busy || dirty === 0}>
                {busy ? 'Saving…' : 'Save the week'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Now band ───────────────────────────────────────────────────── */}
      <div className="border-b border-ink bg-[var(--page-bg)]">
        <div className="grid grid-cols-3">
          <NowCell
            label={pinnedShow ? 'On air · takeover' : 'On air'}
            live
            time={liveOverride
              ? `until ${fmtClock(liveOverride.expiresAt, tz, locale)}`
              : `${hhmm(curBlock.start)} – ${hhmm(curBlock.start + curBlock.span)}`}
            left={pinnedShow ? undefined : leftLabel}
            name={onAirShow ? onAirShow.name : 'Nobody in the chair'}
            color={onAirColor}
            meta={metaOf(pinnedShow ? pinnedShow.id : curBlock.showId)}
            pct={pinnedShow ? undefined : Math.min(100, Math.round((elapsedMin / totalMin) * 100))}
          />
          <NowCell
            label="Up next"
            time={`${hhmm(nextBlock.start)} – ${hhmm(nextBlock.start + nextBlock.span)}`}
            name={showById(nextBlock.showId)?.name ?? 'Nobody in the chair'}
            color={nextBlock.showId ? colorOf(nextBlock.showId) : null}
            meta={metaOf(nextBlock.showId)}
          />
          <NowCell
            label="After that"
            time={`${hhmm(laterBlock.start)} – ${hhmm(laterBlock.start + laterBlock.span)}`}
            name={showById(laterBlock.showId)?.name ?? 'Nobody in the chair'}
            color={laterBlock.showId ? colorOf(laterBlock.showId) : null}
            meta={metaOf(laterBlock.showId)}
            last
          />
        </div>

        {/* Takeover strip */}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-separator-strong px-[22px] py-[11px]">
          <span className="eyebrow text-ink">Takeover</span>
          <Mu className="text-[9px]">
            Jump a show to the front of the queue — the schedule picks up again after
          </Mu>
          <div className="ml-auto flex flex-wrap items-center gap-2.5">
            {liveOverride && pinnedShow ? (
              <>
                <ColorChip color={colorOf(pinnedShow.id)} />
                <span className="text-[13px] font-bold text-ink">{pinnedShow.name}</span>
                <Mu className="text-[9px]">
                  ends {fmtClock(liveOverride.expiresAt, tz, locale)} ·{' '}
                  {Math.max(1, Math.ceil((liveOverride.expiresAt - now.getTime()) / 60_000))} min left
                </Mu>
                <Button variant="ghost" size="sm" onClick={cancelPin} disabled={pinBusy}>
                  {pinBusy ? 'Cancelling…' : 'Cancel takeover'}
                </Button>
              </>
            ) : (
              <>
                <SlotMenu
                  ariaLabel="Pin a show"
                  className="text-[12px]"
                  label={showById(pinShowId)?.name ?? 'Pin a show…'}
                  options={shows.map(s => ({ key: s.id, label: s.name, chipColor: colorOf(s.id) }))}
                  onSelect={setPinShowId}
                  disabled={shows.length === 0}
                />
                <div className="flex gap-1.5">
                  {PIN_PRESETS.map(p => (
                    <SegBtn key={p.minutes} on={pinMinutes === p.minutes} onClick={() => setPinMinutes(p.minutes)}>
                      {p.label}
                    </SegBtn>
                  ))}
                </div>
                <label className="flex items-baseline gap-1.5 border border-separator-strong px-2 py-1">
                  <input
                    type="number"
                    min={PIN_MIN_MINUTES}
                    max={PIN_MAX_MINUTES}
                    value={pinMinutes}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) setPinMinutes(Math.round(v));
                    }}
                    aria-label="Takeover minutes"
                    className="w-11 [appearance:textfield] border-0 bg-transparent p-0 text-right font-mono text-[11px] font-bold text-ink outline-none"
                  />
                  <Mu className="text-[8px]">min</Mu>
                </label>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={pinShow}
                  disabled={pinBusy || !pinShowId || pinMinutes < PIN_MIN_MINUTES || pinMinutes > PIN_MAX_MINUTES}
                >
                  {pinBusy ? 'Pinning…' : 'Pin show'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Main: full-width board, order desk beneath ─────────────────── */}
      <div className="min-w-0 px-[30px] pt-[22px] pb-[30px]">
        <Board
          schedule={schedule}
          shows={shows}
          folded={folded}
          onToggleFold={d => setFolded(f => ({ ...f, [d]: !f[d] }))}
          onOpenAll={() => setFolded({})}
          onFoldWeekdays={() => setFolded({ 1: true, 2: true, 3: true, 4: true })}
          todayKey={nowDay}
          colorOf={colorOf}
          hoursOf={hoursOf}
          onPick={pick}
          onDropShow={dropShow}
          onArmShow={setLineShowId}
        />
      </div>
      <div ref={bandRef} className="flex-1 scroll-mt-4">
        <EditorBand
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
          onAir={() => applyLine(lineShowId)}
          onQuiet={() => applyLine(null)}
          orderNo={orderNo}
          orders={dayBlocks(schedule, line.day).filter(b => b.showId)}
          showById={showById}
          onPickOrder={pick}
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

      <AddShowDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        shows={shows}
        schedule={schedule}
        todayKey={nowDay}
        colorOf={colorOf}
        hoursOf={hoursOf}
        target={WEEKLY_TARGET}
        onApply={({ showId, days, start, end }) => {
          setSchedule(cur => cur ? setRange(cur, days, start, end, showId) : cur);
        }}
        onCreateShow={createShow}
      />

      {/* Review — the unsaved edits behind the header count */}
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
                if (serverSchedule) setSchedule(cloneWeek(serverSchedule));
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
              className="flex items-baseline gap-3 border-b border-separator-soft px-1 py-1.5"
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
    </div>
  );
}

function HeaderStat({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <div className="text-right">
      <div className={cn('font-display text-[30px] leading-none font-semibold', accent ? 'text-vermilion' : 'text-ink')}>
        {n}
      </div>
      <Mu className={cn('mt-1 block text-[8.5px]', accent && 'text-vermilion')}>{label}</Mu>
    </div>
  );
}

function NowCell({
  label, live, time, left, name, color, meta, pct, last,
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
}) {
  const barRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(barRef, { width: `${pct ?? 0}%` });
  return (
    <div className={cn('min-w-0 px-[22px] pt-3 pb-3', !last && 'border-r border-separator-strong')}>
      <div className="mb-2 flex items-center gap-2">
        {live && <span aria-hidden="true" className="size-[7px] flex-none rounded-full bg-[var(--accent)]" />}
        <span className={cn('eyebrow', live ? 'text-vermilion' : 'text-muted')}>{label}</span>
        {left && <Mu className="ml-auto text-[8.5px]">{left}</Mu>}
        <span className={cn('font-mono text-[11px] font-bold tracking-[0.06em] text-ink', !left && 'ml-auto')}>
          {time}
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <ColorChip color={color} className="size-[13px]" />
        <span className="overflow-hidden font-display text-[20px] leading-none font-semibold text-ellipsis whitespace-nowrap text-ink">
          {name}
        </span>
      </div>
      <Mu className="mt-2 block text-[8.5px]">{meta}</Mu>
      {pct != null ? (
        <div className="mt-2 flex h-1 gap-0.5">
          <div ref={barRef} className="bg-ink" />
          <div className="flex-1 bg-[color-mix(in_oklab,var(--ink)_16%,transparent)]" />
        </div>
      ) : (
        <div className="mt-2 h-1 bg-[var(--ink-soft)]" />
      )}
    </div>
  );
}
