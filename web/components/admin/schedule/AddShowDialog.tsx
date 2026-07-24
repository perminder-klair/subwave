'use client';

// "Put a show on the air" — the add-a-show dialog. Three steps on one panel:
// whose show it is (an existing show, or a brand-new one created inline),
// when it runs (the sentence editor + day pills), and where it lands (a mini
// week preview with the new order outlined, plus its impact on the totals).
// Applying writes the hours locally — Save the week persists, like every
// other edit on this screen.

import { useMemo, useRef, useState } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Modal } from '../../ui/modal';
import { ColorChip, DayPills, Mu, SlotMenu } from './bits';
import type { Schedule, ScheduleShow } from './lib';
import { DAYS, HOURS, bookedHours, dayName, hhmm } from './lib';

export interface AddShowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shows: ScheduleShow[];
  schedule: Schedule;
  todayKey: number;
  colorOf: (id: string | null | undefined) => string;
  hoursOf: (id: string) => number;
  target: number;
  /** Write the order's hours into the local grid (unsaved until Save the week). */
  onApply: (opts: { showId: string; days: number[]; start: number; end: number }) => void;
  /** Create a brand-new show server-side (POST /shows); resolves to the saved show. */
  onCreateShow: (name: string) => Promise<ScheduleShow | null>;
}

export default function AddShowDialog({
  open, onOpenChange, shows, schedule, todayKey,
  colorOf, hoursOf, target, onApply, onCreateShow,
}: AddShowDialogProps) {
  const [selId, setSelId] = useState<string | 'new' | null>(null);
  const [newName, setNewName] = useState('');
  const [days, setDays] = useState<number[]>([todayKey]);
  const [start, setStart] = useState(16);
  const [end, setEnd] = useState(18);
  const [busy, setBusy] = useState(false);

  const sel = selId !== 'new' ? shows.find(s => s.id === selId) ?? null : null;
  const selName = selId === 'new' ? newName.trim() || 'the new show' : sel?.name ?? '';
  const selColor = selId === 'new' ? 'var(--muted)' : sel ? colorOf(sel.id) : null;

  // Impact of the order on the current grid, cell by cell.
  const impact = useMemo(() => {
    let added = 0, bumped = 0, silentFilled = 0;
    const bumpedShows = new Set<string>();
    for (const d of days) {
      for (let h = start; h < end && h < 24; h++) {
        const cur = schedule[d]?.[h] ?? null;
        if (selId !== 'new' && cur === selId) continue;
        added++;
        if (cur == null) silentFilled++;
        else { bumped++; bumpedShows.add(cur); }
      }
    }
    return { added, bumped, silentFilled, bumpedShows: [...bumpedShows] };
  }, [schedule, days, start, end, selId]);

  const curHours = selId === 'new' ? 0 : sel ? hoursOf(sel.id) : 0;
  const afterHours = curHours + impact.added;
  const bookedAfter = bookedHours(schedule) + impact.silentFilled;
  const canApply =
    !busy && days.length > 0 &&
    (selId === 'new' ? newName.trim().length > 0 : !!sel);

  const bumpedNames = impact.bumpedShows
    .map(id => shows.find(s => s.id === id)?.name)
    .filter(Boolean)
    .join(', ');

  const apply = async (keepOpen: boolean) => {
    if (!canApply) return;
    setBusy(true);
    try {
      let id = selId as string;
      if (selId === 'new') {
        const created = await onCreateShow(newName.trim());
        if (!created) return;
        id = created.id;
        setSelId(created.id);
        setNewName('');
      }
      onApply({ showId: id, days, start, end });
      if (!keepOpen) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New standing order"
      sub="Put a show on the air"
      width={940}
      footer={
        <div className="flex w-full flex-wrap items-center gap-3.5">
          <Mu className="text-[9px]">Orders can be edited or dropped any time</Mu>
          <div className="ml-auto flex gap-2.5">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="default" size="sm" disabled={!canApply} onClick={() => apply(true)}>
              Add and keep going
            </Button>
            <Button variant="accent" size="sm" disabled={!canApply} onClick={() => apply(false)}>
              Put it on air
            </Button>
          </div>
        </div>
      }
    >
      {/* Reach the Modal body's edges so the right column's raised surface
          runs edge to edge, like the prototype panel. */}
      <div className="-mx-5 -my-4 grid grid-cols-1 md:grid-cols-[1fr_356px]">
        <div className="min-w-0 border-r border-ink px-6 pt-5 pb-6">
          <div className="mb-0.5"><span className="eyebrow text-ink">1 · Whose show is it</span></div>
          <Mu className="mb-3 block tracking-[0.08em]">Pick one you already run, or start a new one</Mu>
          <div className="grid grid-cols-2 gap-1.5">
            {shows.map(s => (
              <button
                key={s.id}
                type="button"
                aria-pressed={selId === s.id}
                onClick={() => setSelId(s.id)}
                className={cn(
                  'grid cursor-pointer grid-cols-[9px_1fr_auto] items-center gap-2.5 border px-[11px] py-2.5 text-left',
                  selId === s.id
                    ? 'border-ink bg-[var(--page-bg)]'
                    : 'border-separator-strong bg-[var(--card-bg)] hover:border-ink',
                )}
              >
                <ColorChip color={colorOf(s.id)} />
                <span className="truncate text-[12.5px] font-semibold text-ink">{s.name}</span>
                <Mu className="text-[8.5px]">{hoursOf(s.id)}h</Mu>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-3 border border-dashed border-[color-mix(in_oklab,var(--ink)_30%,transparent)] px-3 py-[11px]">
            <span className="eyebrow whitespace-nowrap text-muted">Brand new show</span>
            <div className="min-w-0 flex-1">
              <Input
                value={newName}
                placeholder="Name it — Sunday Sessions…"
                maxLength={60}
                onChange={e => { setNewName(e.target.value); setSelId('new'); }}
                onFocus={() => { if (newName.trim()) setSelId('new'); }}
                aria-label="Brand new show name"
              />
            </div>
          </div>
          <Mu className="mt-1.5 block text-[8.5px] tracking-[0.08em]">
            A new show arrives hosted by your first persona — fine-tune it on the Shows page
          </Mu>

          <div className="mt-5 mb-0.5"><span className="eyebrow text-ink">2 · When does it run</span></div>
          <Mu className="mb-3 block tracking-[0.08em]">Say it as a sentence — it holds every week</Mu>
          <div className="border border-ink bg-[var(--page-bg)] p-[15px]">
            <div className="flex flex-wrap items-center gap-2 text-[15px] text-ink">
              <span>Put</span>
              <span className="inline-flex items-center gap-1.5 border-b-[1.5px] border-ink px-1 pb-0.5 font-mono text-[13px] font-bold tracking-[0.04em]">
                {selColor !== null && <ColorChip color={selColor} />}
                {selId ? selName : 'pick a show above'}
              </span>
              <span>on the air from</span>
              <SlotMenu
                ariaLabel="From hour"
                label={hhmm(start)}
                options={HOURS.map(h => ({ key: String(h), label: hhmm(h) }))}
                onSelect={k => {
                  const s = Number(k);
                  setStart(s);
                  setEnd(e => Math.max(e, s + 1));
                }}
              />
              <span>until</span>
              <SlotMenu
                ariaLabel="Until hour"
                label={hhmm(end)}
                options={HOURS.filter(h => h > start).concat(24).map(h => ({ key: String(h), label: hhmm(h) }))}
                onSelect={k => setEnd(Number(k))}
              />
            </div>
            <div className="mt-3.5 flex flex-wrap items-center gap-2.5 border-t border-separator-strong pt-3">
              <span className="eyebrow text-muted">On these days</span>
              <DayPills
                selected={days}
                onToggle={d => setDays(cur => (cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d]))}
              />
              <span className="ml-auto flex gap-3">
                <PresetLink onClick={() => setDays([1, 2, 3, 4, 5])}>Weekdays</PresetLink>
                <PresetLink onClick={() => setDays([6, 0])}>Weekend</PresetLink>
                <PresetLink onClick={() => setDays([1, 2, 3, 4, 5, 6, 0])}>Every day</PresetLink>
              </span>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="eyebrow text-vermilion">
              {impact.added} hour{impact.added === 1 ? '' : 's'} a week
            </span>
            <Mu className="tracking-[0.08em]">
              {selId ? `${selName} goes from ${curHours} h to ${afterHours} h` : 'pick a show to see the change'}
            </Mu>
          </div>
        </div>

        <div className="min-w-0 bg-[var(--page-bg)] px-[22px] pt-5 pb-6">
          <div className="mb-0.5"><span className="eyebrow text-ink">3 · Where it lands</span></div>
          <Mu className="mb-3 block tracking-[0.08em]">Outlined hours are the new order</Mu>
          <MiniWeek
            schedule={schedule}
            colorOf={colorOf}
            highlightDays={selId ? days : []}
            start={start}
            end={end}
          />

          <div className="mt-4 grid gap-2 border border-ink bg-[var(--card-bg)] px-[13px] py-3">
            <div className="flex items-center gap-2">
              <span className={cn('eyebrow', impact.bumped ? 'text-ink' : 'text-vermilion')}>
                {impact.bumped
                  ? `Bumps ${impact.bumped} h`
                  : impact.silentFilled
                    ? 'Fills a gap'
                    : 'No change'}
              </span>
              <Mu className="ml-auto text-[8.5px]">{bookedAfter} of 168 h</Mu>
            </div>
            <div className="text-[12.5px] leading-[1.5] [text-wrap:pretty] text-ink">
              {impact.bumped > 0
                ? `This order takes ${impact.bumped} booked hour${impact.bumped === 1 ? '' : 's'} from ${bumpedNames || 'other shows'} — the newest order wins the hour.`
                : impact.silentFilled > 0
                  ? `${days.map(dayName).join(', ')} ${hhmm(start)} → ${hhmm(end)} ${impact.silentFilled === impact.added ? 'is silent today' : 'covers silent hours'}. Nothing gets bumped — no other order claims it.`
                  : 'Every hour in this range already belongs to this show — applying changes nothing.'}
            </div>
            <ImpactBar pct={(bookedAfter / 168) * 100} />
          </div>

          {selId && (
            <div className="mt-3.5 grid gap-1.5">
              <DeltaBar
                name={selName}
                color={selId === 'new' ? '#7a736a' : colorOf(selId)}
                cur={curHours}
                added={impact.added}
                target={target}
              />
              <Mu className="text-[8.5px] tracking-[0.08em]">Hatched = what this order adds</Mu>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PresetLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[8.5px] tracking-[0.16em] text-muted uppercase hover:text-ink"
    >
      {children}
    </button>
  );
}

// The 7-row week heatstrip — 24 cells per day, the new order outlined.
function MiniWeek({
  schedule, colorOf, highlightDays, start, end,
}: {
  schedule: Schedule;
  colorOf: (id: string | null | undefined) => string;
  highlightDays: number[];
  start: number;
  end: number;
}) {
  return (
    <div className="grid grid-cols-[32px_1fr] items-center gap-1.5">
      <div />
      <div className="grid grid-cols-[repeat(24,1fr)] gap-[1.5px]">
        {[0, 6, 12, 18].map(h => (
          <Mu key={h} className="col-span-6 text-[7px] tracking-normal">{String(h).padStart(2, '0')}</Mu>
        ))}
      </div>
      {DAYS.map(d => (
        <MiniDay
          key={d.key}
          label={d.label}
          cells={HOURS.map(h => schedule[d.key]?.[h] ?? null)}
          colorOf={colorOf}
          highlight={highlightDays.includes(d.key) ? { start, end } : null}
        />
      ))}
    </div>
  );
}

function MiniDay({
  label, cells, colorOf, highlight,
}: {
  label: string;
  cells: (string | null)[];
  colorOf: (id: string | null | undefined) => string;
  highlight: { start: number; end: number } | null;
}) {
  return (
    <>
      <Mu className={cn('text-[8.5px]', highlight && 'text-vermilion')}>{label}</Mu>
      <div className="grid grid-cols-[repeat(24,1fr)] gap-[1.5px]">
        {cells.map((id, h) => (
          <MiniCell
            key={h}
            color={id ? colorOf(id) : null}
            highlighted={!!highlight && h >= highlight.start && h < highlight.end}
          />
        ))}
      </div>
    </>
  );
}

function MiniCell({ color, highlighted }: { color: string | null; highlighted: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDynamicStyle(ref, { background: color ?? 'var(--ink-soft)' });
  return (
    <div
      ref={ref}
      className={cn('h-4', highlighted && 'outline-[2.5px] -outline-offset-1 outline-[var(--accent)]')}
    />
  );
}

function ImpactBar({ pct }: { pct: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useDynamicStyle(ref, { width: `${Math.min(100, pct)}%` });
  return (
    <div className="flex h-2 bg-[var(--ink-soft)]">
      <div ref={ref} className="bg-ink" />
    </div>
  );
}

// The show's airtime bar plus a hatched extension for what this order adds.
function DeltaBar({
  name, color, cur, added, target,
}: {
  name: string;
  color: string;
  cur: number;
  added: number;
  target: number;
}) {
  const scale = Math.max(target * 1.4, cur + added) * 1.06;
  const baseRef = useRef<HTMLDivElement>(null);
  const extRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(baseRef, { width: `${(cur / scale) * 100}%`, background: color });
  useDynamicStyle(extRef, {
    left: `${(cur / scale) * 100}%`,
    width: `${(added / scale) * 100}%`,
    background: `repeating-linear-gradient(45deg, transparent 0 3px, ${color} 3px 6px)`,
    borderColor: color,
  });
  return (
    <div className="flex items-center gap-2">
      <ColorChip color={color} />
      <Mu className="max-w-[96px] truncate text-[9px] text-ink">{name}</Mu>
      <div className="relative flex flex-1">
        <div ref={baseRef} className="h-[9px]" />
        <div ref={extRef} className="absolute top-0 bottom-0 box-border border" />
      </div>
      <span className="font-mono text-[10px] font-bold text-ink">{cur + added}h</span>
    </div>
  );
}
