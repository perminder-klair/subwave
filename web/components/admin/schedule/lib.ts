// Schedule keys follow getDay(): 0 is Sunday, 6 is Saturday.
import {
  SCHEDULE_DAYS,
  SCHEDULE_HOURS,
  emptyWeek as emptyScheduleWeek,
  type ShowGenerationConfig,
} from '@/lib/schemas.generated';

export interface Schedule {
  [day: number]: (string | null)[];
}

/** The slice of a show this screen needs (hydrated from GET /settings). */
export interface ScheduleShow {
  id: string;
  name: string;
  personaId: string;
  guestPersonaIds?: string[];
  moods: string[];
  energies: string[];
  generation?: ShowGenerationConfig;
}

export type GeneratedTemplateId = ShowGenerationConfig['template'];

/** Shared display ordering; never reorder the roster used for show colours. */
export function programmingGroups<T extends { name: string; generation?: { mode?: string; template?: string } }>(shows: readonly T[], locale?: string) {
  const alphabetically = (a: T, b: T) => a.name.localeCompare(b.name, locale, { sensitivity: 'base', numeric: true });
  return {
    regularShows: shows.filter(show => show.generation?.mode !== 'generated').sort(alphabetically),
    subShows: shows.filter(show => show.generation?.mode === 'generated').sort((a, b) =>
      Number(b.generation?.template === 'dj-choice') - Number(a.generation?.template === 'dj-choice') || alphabetically(a, b)),
  };
}

export const GENERATED_SHOW_TEMPLATES: {
  id: GeneratedTemplateId;
  label: string;
  summary: string;
  description: string;
  stripeClassName: string;
}[] = [
  {
    id: 'dj-choice', label: "DJ's Choice",
    summary: 'Familiar musical territory for the host, with room for adjacent discoveries.',
    description: 'A familiar set shaped by the host’s musical tastes and regular-show repertoire, with a few connected departures into neighbouring genres. Guests can suggest new angles while the host’s familiar musical centre remains recognisable.',
    stripeClassName: 'bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,#c24824_19%,var(--card-bg))_0_5px,var(--card-bg)_5px_10px)]',
  },
  {
    id: 'common-ground', label: 'Common Ground',
    summary: 'One host and one guest explore the musical connections between their tastes.',
    description: 'One host and exactly one guest find a musical connection between their tastes, with equal influence from both DJs. The episode follows a shared thread in rhythm, texture, instrumentation or songwriting rather than simply mixing two unrelated genre lists.',
    stripeClassName: 'bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,#7f5ca5_19%,var(--card-bg))_0_5px,var(--card-bg)_5px_10px)]',
  },
  {
    id: 'deep-discovery', label: 'Deep Discovery',
    summary: 'Explore less-represented genres that fit the host’s musical identity.',
    description: 'Explore a coherent musical neighbourhood built around less-represented genres in your library that connect with the host’s tastes. Related styles can provide breadth, while the underrepresented core must account for at least half the eligible track pool.',
    stripeClassName: 'bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,#167978_19%,var(--card-bg))_0_5px,var(--card-bg)_5px_10px)]',
  },
  {
    id: 'outside-comfort-zone', label: 'Outside the Comfort Zone',
    summary: 'One host takes a focused sideways step into neighbouring musical territory.',
    description: 'A solo host follows one audible connection from familiar tastes into a neighbouring genre outside their usual repertoire. The destination supplies the music for the whole episode; rarity is not required, and this is a focused departure rather than a familiar set with occasional detours.',
    stripeClassName: 'bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,#a67b22_19%,var(--card-bg))_0_5px,var(--card-bg)_5px_10px)]',
  },
  {
    id: 'time-capsule', label: 'Time Capsule',
    summary: 'Explore a defined period through the host’s musical tastes, with strict era and genre filters.',
    description: 'Explore one closed period through the host’s musical tastes, using a coherent genre palette with enough library coverage. The chosen window is normally one to five years and never more than ten. Strict era and genre filters keep the selection within that period.',
    stripeClassName: 'bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,#3b709d_19%,var(--card-bg))_0_5px,var(--card-bg)_5px_10px)]',
  },
];

export const GENERATED_SHOW_COLORS: Record<GeneratedTemplateId, string> = {
  'dj-choice': 'color-mix(in oklab, #c24824 75%, var(--bg))',
  'common-ground': 'color-mix(in oklab, #7f5ca5 75%, var(--bg))',
  'time-capsule': 'color-mix(in oklab, #3b709d 75%, var(--bg))',
  'outside-comfort-zone': 'color-mix(in oklab, #a67b22 75%, var(--bg))',
  'deep-discovery': 'color-mix(in oklab, #167978 75%, var(--bg))',
};

export function generatedShowColor(template: string): string {
  return GENERATED_SHOW_COLORS[template as GeneratedTemplateId]
    ?? 'color-mix(in oklab, #7b6a23 75%, var(--bg))';
}

export function generatedShowLabel(
  show: Pick<ScheduleShow, 'generation' | 'personaId' | 'guestPersonaIds'>,
  personas: readonly { id: string; name?: string }[],
): string {
  const generation = show.generation;
  const template = GENERATED_SHOW_TEMPLATES.find(item => item.id === generation?.template)?.label ?? 'Template show';
  const host = generation?.hostMode === 'random'
    ? 'Random host'
    : personas.find(persona => persona.id === show.personaId)?.name || 'Fixed host';
  const guests = generation?.guestMode === 'none'
    ? 'No guests'
    : generation?.guestMode === 'random'
      ? generation.template === 'common-ground' ? 'Random guest' : `Random guests (${generation.guestCount.min}–${generation.guestCount.max})`
      : (show.guestPersonaIds ?? [])
        .map(id => personas.find(persona => persona.id === id)?.name)
        .filter((name): name is string => Boolean(name))
        .join(', ') || 'No guests';
  return `${template} · ${host} · ${guests}`;
}

/** One contiguous run of hours on one day. `showId` null = silent hours. */
export interface Block {
  day: number;
  start: number;
  /** Hours covered; `start + span` can be 24 (end of day), never wraps. */
  span: number;
  showId: string | null;
}

/** One contiguous run of unsaved cell edits (for the Review list). */
export interface DiffRange {
  day: number;
  start: number;
  end: number;
  fromId: string | null;
  toId: string | null;
}

// Storage keys are 0=Sun..6=Sat (JS getDay); display Mon-first.
export const DAYS: { key: number; label: string; name: string }[] = [
  { key: 1, label: 'MON', name: 'Monday' },
  { key: 2, label: 'TUE', name: 'Tuesday' },
  { key: 3, label: 'WED', name: 'Wednesday' },
  { key: 4, label: 'THU', name: 'Thursday' },
  { key: 5, label: 'FRI', name: 'Friday' },
  { key: 6, label: 'SAT', name: 'Saturday' },
  { key: 0, label: 'SUN', name: 'Sunday' },
];

export const HOURS = Array.from({ length: SCHEDULE_HOURS }, (_, h) => h);

// Same palette and index-keyed assignment as ShowsPanel, so a show's colour
// matches between the two pages. Each hex is blended 25% toward the theme paper so
// the twelve hues sit in-palette on every theme; consumers only ever use these as
// CSS color values, so color-mix is safe.
export const SHOW_COLORS = [
  '#c5302a', '#2f6f4f', '#3a5fa8', '#9a5b1f', '#6b4a8a', '#1f7a7a',
  '#a83a6b', '#4a6b1f', '#8a6a1f', '#3a3a8a', '#7a2f5a', '#2f7a3a',
].map((hex) => `color-mix(in oklab, ${hex} 75%, var(--bg))`);

export function emptyWeek(): Schedule {
  return emptyScheduleWeek();
}

export function cloneWeek(s: Schedule): Schedule {
  const w: Schedule = {};
  for (let d = 0; d < SCHEDULE_DAYS; d++)
    w[d] = (s[d] ?? Array(SCHEDULE_HOURS).fill(null)).slice();
  return w;
}

export function dayName(day: number): string {
  return DAYS.find(d => d.key === day)?.name ?? '';
}

/** '06' — board-card style hour. 24 stays '24' so a day-end reads as a close. */
export function hh(h: number): string {
  return String(h).padStart(2, '0');
}

/** '06:00' — listing/editor style hour. */
export function hhmm(h: number): string {
  return `${hh(h)}:00`;
}

/** Group one day's 24 cells into contiguous blocks (shows and silent runs). */
export function dayBlocks(schedule: Schedule, day: number): Block[] {
  const cells = schedule[day] ?? Array(SCHEDULE_HOURS).fill(null);
  const blocks: Block[] = [];
  let h = 0;
  while (h < SCHEDULE_HOURS) {
    const v = cells[h] ?? null;
    let end = h + 1;
    while (end < SCHEDULE_HOURS && (cells[end] ?? null) === v) end++;
    blocks.push({ day, start: h, span: end - h, showId: v });
    h = end;
  }
  return blocks;
}

/** Every show block of the week in display order — the "standing orders". */
export function weekOrders(schedule: Schedule): Block[] {
  return DAYS.flatMap(d => dayBlocks(schedule, d.key).filter(b => b.showId));
}

export function bookedHoursOf(schedule: Schedule, day: number): number {
  return (schedule[day] ?? []).filter(Boolean).length;
}

export function bookedHours(schedule: Schedule): number {
  let n = 0;
  for (let d = 0; d < SCHEDULE_DAYS; d++) n += bookedHoursOf(schedule, d);
  return n;
}

export function showHours(schedule: Schedule, showId: string): number {
  let n = 0;
  for (let d = 0; d < SCHEDULE_DAYS; d++)
    for (let h = 0; h < SCHEDULE_HOURS; h++) if (schedule[d]?.[h] === showId) n++;
  return n;
}

/** Assign `value` to [start, end) on each of `days`, immutably. */
export function setRange(
  schedule: Schedule,
  days: number[],
  start: number,
  end: number,
  value: string | null,
): Schedule {
  const week = cloneWeek(schedule);
  for (const d of days)
    for (let h = start; h < end && h < SCHEDULE_HOURS; h++) week[d]![h] = value;
  return week;
}

/** Fills the day with `showId`, or clears it when the day already runs nothing
 *  but that show, so a second click undoes the first. */
export function fillDayToggle(schedule: Schedule, day: number, showId: string): Schedule {
  const cells = schedule[day] ?? [];
  const allSet = cells.length === SCHEDULE_HOURS && cells.every(c => c === showId);
  return setRange(schedule, [day], 0, SCHEDULE_HOURS, allSet ? null : showId);
}

/** One hour across all seven days, same toggle-off rule as `fillDayToggle`. */
export function fillHourToggle(schedule: Schedule, hour: number, showId: string): Schedule {
  const days = DAYS.map(d => d.key);
  const allSet = days.every(d => schedule[d]?.[hour] === showId);
  return setRange(schedule, days, hour, hour + 1, allSet ? null : showId);
}

/** Where a dragged edge of `block` lands once `hour` is clamped to something
 *  legal: inside the day, and never shorter than one hour. Pure so the board
 *  can run it on every pointer move without touching the grid. */
export function resizedRun(
  block: Block,
  edge: 'top' | 'bottom',
  hour: number,
): { start: number; end: number } {
  const end = block.start + block.span;
  if (edge === 'top') return { start: Math.min(Math.max(hour, 0), end - 1), end };
  return { start: block.start, end: Math.max(Math.min(hour, SCHEDULE_HOURS), block.start + 1) };
}

export function movedRun(block: Block, hour: number): { start: number; end: number } {
  const start = Math.min(Math.max(hour, 0), SCHEDULE_HOURS - block.span);
  return { start, end: start + block.span };
}

/** Moves one run's boundaries to [start, end): the hours it gives up fall silent,
 *  the hours it takes over are overwritten. Clearing first is what makes a shrink
 *  work, and it must precede the write or a grow would erase its own gain. */
export function resizeBlock(
  schedule: Schedule,
  block: Block,
  start: number,
  end: number,
): Schedule {
  if (!block.showId) return schedule;
  const cleared = setRange(schedule, [block.day], block.start, block.start + block.span, null);
  return setRange(cleared, [block.day], start, end, block.showId);
}

export interface RunPlacement {
  /** The run's start before this drag. Stable identity for its preview card. */
  fromStart: number;
  /** The run's start in the preview/result week. */
  start: number;
}

export function blockKeys(blocks: Block[], placements: RunPlacement[] = []): string[] {
  const fromStartAt = new Map(placements.map(p => [p.start, p.fromStart]));
  let gap = 0;
  return blocks.map(b => {
    if (b.showId) return `run:${b.day}:${fromStartAt.get(b.start) ?? b.start}`;
    return `gap:${b.day}:${gap++}`;
  });
}

/** One booked run of a day, with the hour it currently starts at. */
export interface DayRun {
  showId: string;
  span: number;
  start: number;
}

export interface DayRuns {
  runs: DayRun[];
  gaps: number[];
}

export function dayRuns(schedule: Schedule, day: number): DayRuns {
  const runs: DayRun[] = [];
  const gaps: number[] = [0];
  for (const b of dayBlocks(schedule, day)) {
    if (b.showId) {
      runs.push({ showId: b.showId, span: b.span, start: b.start });
      gaps.push(0);
    } else {
      gaps[gaps.length - 1] = (gaps[gaps.length - 1] ?? 0) + b.span;
    }
  }
  return { runs, gaps };
}

/** Lay a permuted run list back out over its positional gaps. */
function layOutDay(
  runs: DayRun[],
  gaps: number[],
): { cells: (string | null)[]; starts: number[] } {
  const cells: (string | null)[] = [];
  const starts: number[] = [];
  runs.forEach((r, i) => {
    for (let g = 0; g < (gaps[i] ?? 0); g++) cells.push(null);
    starts.push(cells.length);
    for (let h = 0; h < r.span; h++) cells.push(r.showId);
  });
  for (let g = 0; g < (gaps[runs.length] ?? 0); g++) cells.push(null);
  return { cells, starts };
}

export type DragPlan =
  | { kind: 'move'; start: number; end: number }
  | { kind: 'reorder'; to: number };

export function planRunDrag(
  schedule: Schedule,
  block: Block,
  head: number,
): DragPlan | null {
  if (!block.showId) return null;
  const { runs } = dayRuns(schedule, block.day);
  const from = runs.findIndex(r => r.start === block.start);
  if (from < 0) return null;
  const landing = movedRun(block, head);
  if (landing.start === block.start) return null;
  const hit = runs
    .map((r, i) => ({ r, i }))
    .filter(x => x.i !== from && x.r.start < landing.end && landing.start < x.r.start + x.r.span);
  if (hit.length === 0) return { kind: 'move', start: landing.start, end: landing.end };
  const lifted = (i: number) => (i > from ? i - 1 : i);
  return landing.start < block.start
    ? { kind: 'reorder', to: lifted(hit[0]!.i) }
    : { kind: 'reorder', to: lifted(hit[hit.length - 1]!.i) + 1 };
}

export interface RunDragResult {
  week: Schedule;
  start: number;
  end: number;
  shifted: number;
  /** Every run's original and resulting start, used only for stable preview identity. */
  placements: RunPlacement[];
}

export function applyRunDrag(
  schedule: Schedule,
  block: Block,
  plan: DragPlan,
): RunDragResult {
  const { runs, gaps } = dayRuns(schedule, block.day);
  const unchanged = {
    week: schedule,
    start: block.start,
    end: block.start + block.span,
    shifted: 0,
    placements: runs.map(r => ({ fromStart: r.start, start: r.start })),
  };
  if (!block.showId) return unchanged;
  if (plan.kind === 'move') {
    return {
      week: resizeBlock(schedule, block, plan.start, plan.end),
      start: plan.start,
      end: plan.end,
      shifted: 0,
      placements: runs.map(r => ({
        fromStart: r.start,
        start: r.start === block.start ? plan.start : r.start,
      })),
    };
  }
  const from = runs.findIndex(r => r.start === block.start);
  if (from < 0) return unchanged;
  const next = runs.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) return unchanged;
  const to = Math.min(Math.max(plan.to, 0), next.length);
  next.splice(to, 0, moved);
  const { cells, starts } = layOutDay(next, gaps);
  const week = cloneWeek(schedule);
  week[block.day] = cells;
  const start = starts[to] ?? block.start;
  return {
    week,
    start,
    end: start + moved.span,
    shifted: next.reduce((n, r, i) => (i !== to && starts[i] !== r.start ? n + 1 : n), 0),
    placements: next.map((r, i) => ({ fromStart: r.start, start: starts[i] ?? r.start })),
  };
}

/** Number of cells where the two grids disagree (the unsaved-edit count). */
export function diffCells(a: Schedule, b: Schedule): number {
  let n = 0;
  for (let d = 0; d < SCHEDULE_DAYS; d++)
    for (let h = 0; h < SCHEDULE_HOURS; h++)
      if ((a[d]?.[h] ?? null) !== (b[d]?.[h] ?? null)) n++;
  return n;
}

/** Unsaved edits grouped into contiguous same-transition runs, display order. */
export function diffRanges(local: Schedule, server: Schedule): DiffRange[] {
  const out: DiffRange[] = [];
  for (const { key: d } of DAYS) {
    let h = 0;
    while (h < SCHEDULE_HOURS) {
      const from = server[d]?.[h] ?? null;
      const to = local[d]?.[h] ?? null;
      if (from === to) { h++; continue; }
      let end = h + 1;
      while (
        end < SCHEDULE_HOURS &&
        (server[d]?.[end] ?? null) === from &&
        (local[d]?.[end] ?? null) === to &&
        from !== (local[d]?.[end] ?? null)
      ) end++;
      out.push({ day: d, start: h, end, fromId: from, toId: to });
      h = end;
    }
  }
  return out;
}

/** The block containing `hour` on `day` (always exists — silent runs count). */
export function blockAt(schedule: Schedule, day: number, hour: number): Block {
  const found = dayBlocks(schedule, day).find(
    b => b.start <= hour && hour < b.start + b.span,
  );
  return found ?? { day, start: hour, span: 1, showId: null };
}

/** Walk forward from a block boundary: the next `offset` blocks on air,
 *  crossing midnight into the following day(s). offset 1 = up next. */
export function blockAhead(schedule: Schedule, day: number, hour: number, offset: number): Block {
  let cur = blockAt(schedule, day, hour);
  for (let i = 0; i < offset; i++) {
    let nd = cur.day;
    let nh = cur.start + cur.span;
    if (nh >= SCHEDULE_HOURS) { nh = 0; nd = (cur.day + 1) % SCHEDULE_DAYS; }
    cur = blockAt(schedule, nd, nh);
  }
  return cur;
}
