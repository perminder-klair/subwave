'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { fmtClockMinute, normalizeStationLocale, zonedDayHour } from '@/lib/format';
import type {
  ActiveShow,
  ScheduleGrid,
  SchedulePayload,
  SchedulePersona,
  ScheduleShow,
  StationLocale,
  StationContext,
} from '@/lib/types';
import { useStationClient } from '@/lib/stationClient';

const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export interface ScheduleDrawerProps {
  /** What's on right now, fed from `useStationFeed` so the on-now card stays
   *  fresh without re-fetching `/schedule`. */
  activeShow: ActiveShow | null;
  /** Station context from `/now-playing` — used for the operator-configured
   *  location label shown above the schedule. */
  context: StationContext | null;
}

interface Slot {
  hour: number;
  show: ScheduleShow | null;
  persona: SchedulePersona | null;
  /** Last hour of this run (inclusive) — used to render block ranges like
   *  `02:00–04:00`. Filled in during the dedupe pass. */
  endHour: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function fmtHourRange(start: number, end: number, locale: StationLocale): string {
  return `${fmtHour(start, locale)} – ${fmtHour((end + 1) % 24, locale)}`;
}

function fmtHour(start: number, locale: StationLocale): string {
  if (locale === 'en-US') {
    const hour = start % 24;
    const suffix = hour < 12 ? 'AM' : 'PM';
    return `${hour % 12 || 12}:00 ${suffix}`;
  }
  return `${pad2(start)}:00`;
}

/** Collapse adjacent same-show hours into a single row so a 4-hour block reads
 *  as one entry. Autonomous (null) hours are also collapsed. */
function collapseSlots(dayGrid: Array<string | null>, shows: ScheduleShow[], personas: SchedulePersona[]): Slot[] {
  const showById = new Map(shows.map(s => [s.id, s]));
  const personaById = new Map(personas.map(p => [p.id, p]));
  const out: Slot[] = [];
  let i = 0;
  while (i < 24) {
    const id = dayGrid[i] ?? null;
    let j = i;
    while (j + 1 < 24 && (dayGrid[j + 1] ?? null) === id) j++;
    const show = id ? showById.get(id) || null : null;
    const persona = show ? personaById.get(show.personaId) || null : null;
    out.push({ hour: i, endHour: j, show, persona });
    i = j + 1;
  }
  return out;
}

function endHourForCurrentBlock(grid: ScheduleGrid, day: number, hour: number): number {
  const dayGrid = grid[day];
  if (!Array.isArray(dayGrid)) return hour;
  const current = dayGrid[hour] ?? null;
  let h = hour;
  while (h + 1 < 24 && (dayGrid[h + 1] ?? null) === current) h++;
  return h;
}

export default function ScheduleDrawer({ activeShow, context }: ScheduleDrawerProps) {
  const client = useStationClient();
  const [data, setData] = useState<SchedulePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  // Defaults to today; tapping a day tab flips this without refetching.
  const [viewDay, setViewDay] = useState<number>(() => new Date().getDay());
  // Once set, stop auto-syncing viewDay to the station's today so a manual day
  // pick sticks across re-renders/ticks.
  const [userPickedDay, setUserPickedDay] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const j = await client.schedule();
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Drives both the on-now indicator (grid resolution is 1 h, so 60 s would
  // be enough on its own) and the station-time clock at the top of the drawer
  // (HH:MM, needs sub-minute ticks to feel live). 1 s is cheap and only runs
  // while the drawer is open.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // The initial viewDay seeds from the browser's day; once the schedule loads
  // (and its station timezone with it), snap the default selection to the
  // station's today — unless the listener has already tapped a day tab.
  useEffect(() => {
    if (!data || userPickedDay) return;
    setViewDay(zonedDayHour(new Date(), data.timezone ?? null).dow);
  }, [data, userPickedDay]);

  // Resolve "now" in the *station's* timezone, not the viewer's browser zone —
  // the controller resolves the active show with the same wall clock, so this
  // keeps the on-now card naming the same show that's actually on air (#418).
  // Safe before `data` loads: zonedDayHour falls back to local time when tz is
  // nullish, and every consumer below is guarded on `data`.
  const { dow: today, hour: currentHour } = zonedDayHour(now, data?.timezone ?? null);

  const daySlots = useMemo(() => {
    if (!data) return [];
    return collapseSlots(data.schedule[viewDay] ?? Array(24).fill(null), data.shows, data.personas);
  }, [data, viewDay]);

  // For "Coming up today", drop everything before the *next* slot. If we're
  // mid-block, advance past this block; if today is a future day, show the
  // full day from the top.
  const upcomingSlots = useMemo(() => {
    if (!data || viewDay !== today) return daySlots;
    const blockEnd = endHourForCurrentBlock(data.schedule, today, currentHour);
    return daySlots.filter(s => s.hour > blockEnd);
  }, [data, daySlots, viewDay, today, currentHour]);

  const onNow = useMemo(() => {
    if (!data) return null;
    const todayGrid = data.schedule[today];
    if (!Array.isArray(todayGrid)) return null;
    const id = todayGrid[currentHour] ?? null;
    if (!id) return null;
    const show = data.shows.find(s => s.id === id) || null;
    if (!show) return null;
    const persona = data.personas.find(p => p.id === show.personaId) || null;
    const endHour = endHourForCurrentBlock(data.schedule, today, currentHour);
    return { show, persona, endHour };
  }, [data, today, currentHour]);

  if (err) {
    return (
      <div className="text-[13px] leading-relaxed text-[var(--danger)]">
        couldn’t load schedule: {err}
      </div>
    );
  }
  if (!data) {
    return <div className="text-[13px] text-muted italic">loading…</div>;
  }

  const hasAnyShow = data.shows.length > 0;
  const locale = normalizeStationLocale(data.locale);
  if (!hasAnyShow) {
    // Autonomous mode (no scheduled shows) is the common state for a personal
    // station, so still surface the station time + location here — that's
    // exactly the context an always-on autonomous station benefits from.
    return (
      <div className="grid gap-6">
        <StationHeader
          now={now}
          timezone={data.timezone ?? null}
          locale={locale}
          location={context?.weather?.location ?? null}
        />
        <div className="text-[13px] leading-relaxed text-muted">
          No shows scheduled — the station is running autonomously. The DJ picks
          tracks by the time of day, the weather, and any festival on the
          calendar.
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <StationHeader
        now={now}
        timezone={data.timezone ?? null}
        locale={locale}
        location={context?.weather?.location ?? null}
      />
      <OnNowCard onNow={onNow} activeShow={activeShow} locale={locale} />

      <section>
        <SectionLabel>
          {viewDay === today ? 'Coming up today' : `${DAY_LABELS[viewDay]} schedule`}
        </SectionLabel>
        {upcomingSlots.length === 0 ? (
          <div className="text-[13px] text-muted">
            Nothing more scheduled today.
          </div>
        ) : (
          <ul className="grid">
            {upcomingSlots.map(slot => (
              <ScheduleRow
                key={`${viewDay}-${slot.hour}`}
                slot={slot}
                isNow={viewDay === today && slot.hour <= currentHour && currentHour <= slot.endHour}
                locale={locale}
              />
            ))}
          </ul>
        )}
      </section>

      <DayTabs
        value={viewDay}
        today={today}
        onChange={d => {
          setUserPickedDay(true);
          setViewDay(d);
        }}
      />
    </div>
  );
}

function StationHeader({
  now,
  timezone,
  locale,
  location,
}: {
  now: Date;
  timezone: string | null;
  locale: StationLocale;
  location: string | null;
}) {
  // If the operator's TZ isn't on the schedule payload we fall back to the
  // viewer's local TZ — close enough for a personal station where operator
  // and listener usually overlap.
  const time = fmtClockMinute(now, timezone, locale);
  return (
    <section className="flex items-end justify-between gap-4 border-b border-separator-soft pb-3">
      <div>
        <div className="text-[9px] tracking-[0.3em] text-muted uppercase">Station time</div>
        <div className="v3-tab-num mt-1 text-2xl leading-none font-semibold text-ink">
          {time}
        </div>
      </div>
      {location && (
        <div className="text-right">
          <div className="text-[9px] tracking-[0.3em] text-muted uppercase">Location</div>
          <div className="mt-1 text-sm text-ink">{location}</div>
        </div>
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-[10px] text-[9px] tracking-[0.3em] text-muted uppercase">
      {children}
    </div>
  );
}

function AvatarThumb({ avatar, name, tier }: { avatar: string; name: string; tier: 'lg' | 'sm' }) {
  // `avatar` is always a URL (the public endpoint serves a placeholder when no
  // image is set), so this is safe to render unconditionally. Initials sit
  // underneath as a fallback while the network image loads. Two fixed sizes
  // — large for the On-now card, small for schedule rows — keeps Tailwind's
  // class generator happy without a `style={…}` escape hatch.
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const px = tier === 'lg' ? 64 : 36;
  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden border border-ink bg-[var(--ink-softer)]',
        tier === 'lg' ? 'h-16 w-16' : 'h-9 w-9',
      )}
    >
      <span
        className={cn(
          'absolute inset-0 grid place-items-center font-extrabold text-muted',
          tier === 'lg' ? 'text-[16px]' : 'text-[12px]',
        )}
      >
        {initials || '?'}
      </span>
      {avatar && (
        <img
          src={avatar}
          alt=""
          width={px}
          height={px}
          className="relative h-full w-full object-cover"
        />
      )}
    </div>
  );
}

function OnNowCard(props: {
  onNow: { show: ScheduleShow; persona: SchedulePersona | null; endHour: number } | null;
  activeShow: ActiveShow | null;
  locale: StationLocale;
}) {
  const { onNow, activeShow, locale } = props;
  const client = useStationClient();
  if (!onNow) {
    return (
      <section>
        <SectionLabel>On now</SectionLabel>
        <div className="border border-separator-strong p-4">
          <div className="text-[15px] leading-tight font-semibold">Autonomous</div>
          <div className="mt-1 text-xs leading-relaxed text-muted">
            No host scheduled for this hour — the station is picking tracks on
            its own based on the time of day and the weather.
          </div>
        </div>
      </section>
    );
  }
  const personaName = onNow.persona?.name || activeShow?.persona?.name || 'Host';
  // Controller emits avatar paths without the `/api` prefix so each surface
  // can prepend its own origin; client.resolve does exactly that, and empty
  // input stays empty so <img> falls back to the initials placeholder.
  const avatar = client.resolve(onNow.persona?.avatar || activeShow?.persona?.avatar || '');
  // Guest co-hosts in the studio this hour (only known for the LIVE show —
  // /state doesn't expose future rosters, so upcoming slots stay host-only).
  const guestNames = (activeShow?.guests || []).map(g => g?.name).filter(Boolean);
  return (
    <section>
      <SectionLabel>On now · until {fmtHour((onNow.endHour + 1) % 24, locale)}</SectionLabel>
      <div className="flex gap-4 border border-separator-strong p-4">
        <AvatarThumb avatar={avatar} name={personaName} tier="lg" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] tracking-[0.3em] text-vermilion uppercase">
            {personaName}
            {guestNames.length > 0 && (
              <span className="text-muted"> · with {guestNames.join(' & ')}</span>
            )}
          </div>
          <div className="mt-0.5 text-lg leading-tight font-semibold">
            {onNow.show.name}
          </div>
          {onNow.show.topic && (
            <div className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted">
              {onNow.show.topic}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ScheduleRow({ slot, isNow, locale }: { slot: Slot; isNow: boolean; locale: StationLocale }) {
  const client = useStationClient();
  const personaName = slot.persona?.name || (slot.show ? 'Host' : null);
  const avatar = client.resolve(slot.persona?.avatar || '');
  const time = slot.hour === slot.endHour ? fmtHour(slot.hour, locale) : fmtHourRange(slot.hour, slot.endHour, locale);
  return (
    <li
      className={cn(
        'flex items-center gap-3 border-b border-separator-soft py-[11px]',
        isNow && 'bg-[var(--ink-softer)]',
      )}
    >
      <span className="v3-tab-num w-[88px] shrink-0 text-[11px] tracking-[0.2em] text-muted uppercase">
        {time}
      </span>
      {slot.show ? (
        <>
          <AvatarThumb avatar={avatar} name={personaName || '?'} tier="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm leading-tight text-ink">
              {slot.show.name}
            </div>
            {personaName && (
              <div className="truncate text-[11px] text-muted">{personaName}</div>
            )}
          </div>
        </>
      ) : (
        <span className="text-[11px] tracking-[0.2em] text-muted uppercase">
          autonomous
        </span>
      )}
    </li>
  );
}

function DayTabs({ value, today, onChange }: { value: number; today: number; onChange: (d: number) => void }) {
  return (
    <nav aria-label="Schedule day" className="grid grid-cols-7 gap-1 border-t border-ink pt-3">
      {DAY_LABELS.map((label, i) => {
        const isActive = i === value;
        const isToday = i === today;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChange(i)}
            className={cn(
              'v3-focus py-2 text-[10px] tracking-[0.25em] uppercase',
              isActive
                ? 'border border-ink bg-ink text-bg'
                : 'border border-transparent text-muted hover:text-ink',
            )}
            aria-pressed={isActive}
          >
            {label}
            {isToday && !isActive && <span className="ml-1 text-vermilion">·</span>}
          </button>
        );
      })}
    </nav>
  );
}
