'use client';

// 7-column × 24-hour week board. Cards are shows, hatched slots are silent
// runs; every write is local until Save the week.
//
// Geometry (#1204): columns divide the board's width from `sm` up (`sm:w-full`
// + `sm:min-w-0`), no px floor. The hour unit is the `--hour-px` CSS variable
// so the gutter's static height and each card's `calc()` cannot drift apart.

import type {
  ComponentPropsWithoutRef, DragEvent, KeyboardEvent, PointerEvent,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FoldHorizontal, GripVertical, Rows2, Rows4 } from 'lucide-react';
import {
  DndContext, KeyboardSensor, MouseSensor, TouchSensor,
  useDraggable, useSensor, useSensors,
} from '@dnd-kit/core';
import type {
  DragEndEvent, DragMoveEvent, DragStartEvent, KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import type { BoardDensity } from '../../../lib/adminView';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { ScrollArea, ScrollBar } from '../../ui/scroll-area';
import { Seg } from '../ui';
import { ColorChip, Mu } from './bits';
import type {
  Block, DragPlan, RunDragResult, RunPlacement, Schedule, ScheduleShow,
} from './lib';
import {
  DAYS, HOURS, applyRunDrag, blockKeys, dayBlocks, hh, planRunDrag, resizedRun,
} from './lib';

const DND_TYPE = 'text/x-subwave-show';
const RUN_DRAG_MODIFIERS = [restrictToVerticalAxis];

function readDraggedShow(e: DragEvent): string {
  return e.dataTransfer.getData(DND_TYPE) || e.dataTransfer.getData('text/plain');
}

function rankIn(order: string[], key: string): number {
  const i = order.indexOf(key);
  return i < 0 ? order.length : i;
}

interface DragRun {
  block: Block;
  /** Pointer offset within its grabbed hour, so hour changes land at the same threshold. */
  withinHour: number;
  /** Keyboard movement is counted in hours; browser auto-scroll must not alter it. */
  keyboard: boolean;
}

function grabHour(rect: { top: number; height: number }, clientY: number, span: number): number {
  const frac = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return Math.min(span - 1, Math.max(0, Math.floor(frac * span)));
}

function activationClientY(event: Event): number | null {
  if ('touches' in event) {
    const touchEvent = event as TouchEvent;
    return touchEvent.touches[0]?.clientY ?? touchEvent.changedTouches[0]?.clientY ?? null;
  }
  return 'clientY' in event ? (event as MouseEvent).clientY : null;
}

export interface BoardProps {
  schedule: Schedule;
  shows: ScheduleShow[];
  folded: Record<number, boolean>;
  onToggleFold: (day: number) => void;
  todayKey: number;
  colorOf: (id: string | null | undefined) => string;
  hoursOf: (id: string) => number;
  onPick: (b: Block) => void;
  onRemove: (b: Block) => void;
  /** The run moves to [start, end); the hours it vacates fall silent. */
  onResize: (b: Block, start: number, end: number) => void;
  onDropShow: (b: Block, showId: string) => void;
  onDragRun: (b: Block, plan: DragPlan) => RunDragResult | null;
  armedShowId: string | null;
  /** The same id twice disarms. */
  onArmShow: (id: string) => void;
  /** Only reachable with a show armed; both toggle off when the target already
   *  runs it. */
  onFillDay: (day: number) => void;
  onFillHour: (hour: number) => void;
  density: BoardDensity;
  hourPx: number;
  onDensity: (d: BoardDensity) => void;
}

export default function Board({
  schedule, shows, folded, onToggleFold, todayKey,
  colorOf, hoursOf, onPick, onRemove, onResize, onDropShow, onDragRun,
  armedShowId, onArmShow, onFillDay, onFillHour,
  density, hourPx, onDensity,
}: BoardProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(gridRef, { '--hour-px': `${hourPx}px` });
  const armedName = shows.find(s => s.id === armedShowId)?.name ?? null;

  const [dragRun, setDragRun] = useState<DragRun | null>(null);
  const [plan, setPlan] = useState<DragPlan | null>(null);
  const [focusAfterMove, setFocusAfterMove] = useState<{
    week: Schedule;
    day: number;
    start: number;
    showId: string;
  } | null>(null);
  const [runIdentities, setRunIdentities] = useState<{
    week: Schedule;
    day: number;
    placements: RunPlacement[];
  } | null>(null);
  const activeDrag = useRef<DragRun | null>(null);
  const keyboardSteps = useRef(0);
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>((event, { currentCoordinates }) => {
    if (event.code === 'ArrowUp') {
      keyboardSteps.current--;
      return { ...currentCoordinates, y: currentCoordinates.y - hourPx };
    }
    if (event.code === 'ArrowDown') {
      keyboardSteps.current++;
      return { ...currentCoordinates, y: currentCoordinates.y + hourPx };
    }
    return undefined;
  }, [hourPx]);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // A short move before this delay remains an ordinary page/board swipe.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );
  const endDrag = () => {
    activeDrag.current = null;
    keyboardSteps.current = 0;
    setDragRun(null);
    setPlan(null);
  };
  const preview = dragRun && plan ? applyRunDrag(schedule, dragRun.block, plan) : null;
  const dragDay = dragRun?.block.day ?? null;
  const identitiesFor = (day: number): RunPlacement[] => (
    runIdentities?.week === schedule && runIdentities.day === day
      ? runIdentities.placements
      : []
  );
  const composeIdentities = (day: number, placements: RunPlacement[]): RunPlacement[] => {
    const stableStartAt = new Map(identitiesFor(day).map(p => [p.start, p.fromStart]));
    return placements.map(p => ({
      fromStart: stableStartAt.get(p.fromStart) ?? p.fromStart,
      start: p.start,
    }));
  };
  const previewIdentities = preview && dragDay != null
    ? composeIdentities(dragDay, preview.placements)
    : null;
  const dragOrder = dragRun
    ? blockKeys(dayBlocks(schedule, dragRun.block.day), identitiesFor(dragRun.block.day))
    : null;

  const commitRun = (block: Block, nextPlan: DragPlan) => {
    if (!block.showId) return;
    const result = onDragRun(block, nextPlan);
    if (!result || result.week === schedule) return;
    const placements = composeIdentities(block.day, result.placements);
    setRunIdentities({ week: result.week, day: block.day, placements });
    setFocusAfterMove({
      week: result.week,
      day: block.day,
      start: result.start,
      showId: block.showId,
    });
  };

  const planAtDelta = (moving: DragRun, deltaY: number): DragPlan | null => {
    const steps = Math.floor((moving.withinHour + deltaY) / hourPx);
    return planRunDrag(schedule, moving.block, moving.block.start + steps);
  };

  const onRunDragStart = (event: DragStartEvent) => {
    const activeId = String(event.active.id);
    const card = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-schedule-key]') ?? [],
    ).find(el => el.dataset.scheduleKey === activeId);
    const [dayPart, startPart] = card?.dataset.scheduleRun?.split(':') ?? [];
    const day = Number(dayPart);
    const currentStart = Number(startPart);
    const block = activeId.startsWith('run:') && Number.isInteger(day) && Number.isInteger(currentStart)
      ? dayBlocks(schedule, day).find(b => b.showId && b.start === currentStart)
      : undefined;
    const rect = card?.getBoundingClientRect();
    if (!block?.showId || !rect) return;
    const keyboardActivation = event.activatorEvent.type === 'keydown';
    const clientY = keyboardActivation
      ? rect.top
      : activationClientY(event.activatorEvent) ?? rect.top + rect.height / 2;
    const grab = keyboardActivation ? 0 : grabHour(rect, clientY, block.span);
    const moving = {
      block,
      withinHour: keyboardActivation ? 0 : clientY - rect.top - grab * hourPx,
      keyboard: keyboardActivation,
    };
    keyboardSteps.current = 0;
    activeDrag.current = moving;
    setDragRun(moving);
  };

  const onRunDragMove = (event: DragMoveEvent) => {
    const moving = activeDrag.current;
    // Firefox can include KeyboardSensor auto-scroll in event.delta while
    // Chromium does not. Arrow presses are the stable unit the planner needs.
    const deltaY = moving?.keyboard ? keyboardSteps.current * hourPx : event.delta.y;
    const nextPlan = moving ? planAtDelta(moving, deltaY) : null;
    setPlan(nextPlan);
  };

  const onRunDragEnd = (event: DragEndEvent) => {
    const moving = activeDrag.current;
    // Pointer/touch keep the active node anchored, so the final sensor delta is
    // authoritative even after a fast last movement. Keyboard uses arrow count
    // because Firefox includes its auto-scroll distance in the reported delta.
    const deltaY = moving?.keyboard ? keyboardSteps.current * hourPx : event.delta.y;
    const nextPlan = moving ? planAtDelta(moving, deltaY) : null;
    if (moving && nextPlan) commitRun(moving.block, nextPlan);
    endDrag();
  };

  useEffect(() => {
    if (!focusAfterMove || schedule !== focusAfterMove.week) return;
    const card = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-schedule-run]') ?? [],
    ).find(el =>
      el.dataset.scheduleRun === `${focusAfterMove.day}:${focusAfterMove.start}`
      && el.dataset.scheduleShow === focusAfterMove.showId,
    );
    card?.focus({ preventScroll: true });
    setFocusAfterMove(null);
  }, [focusAfterMove, schedule]);

  return (
    <DndContext
      sensors={sensors}
      modifiers={RUN_DRAG_MODIFIERS}
      accessibility={{ restoreFocus: false }}
      onDragStart={onRunDragStart}
      onDragMove={onRunDragMove}
      onDragEnd={onRunDragEnd}
      onDragCancel={endDrag}
    >
      <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-2 px-5 sm:px-[30px]">
        {/* Two lengths: resize handles stay mouse-only; run dragging has a touch grip. */}
        <Mu className="min-w-0 flex-1 tracking-[0.08em] sm:hidden">
          {armedName
            ? `${armedName} is armed — tap an hour to book it, or a day header for the whole day`
            : 'Tap a silent hour to book a show — tap a card to edit its order, hold its grip to move it within the day, or tap its × to take it off the air'}
        </Mu>
        <Mu className="hidden min-w-0 flex-1 tracking-[0.08em] sm:block">
          {armedName
            ? `${armedName} is armed — click any hour to book it, a day header for the whole day, or an hour in the gutter for that hour all week`
            : 'Click a silent hour (or drag a show onto it) to book a show — click a card to edit its order, drag its grip to move it within its day (drop it on another show and the two trade places), drag its top or bottom edge to change its hours, its × to take it off the air'}
        </Mu>
        <span className="ml-auto flex flex-none items-center gap-2">
          <Mu className="hidden text-[8.5px] sm:inline">Rows</Mu>
          <Seg
            value={density}
            onChange={v => onDensity(v === 'compact' ? 'compact' : 'comfortable')}
            options={[
              // Icon-only: the sr-only span carries the name; min-h is the tap target.
              {
                id: 'comfortable',
                title: 'Roomy rows — the full hour range on every card',
                label: (
                  <span className="flex min-h-[22px] items-center sm:min-h-0">
                    <Rows2 size={15} strokeWidth={1.75} aria-hidden />
                    <span className="sr-only">Roomy</span>
                  </span>
                ),
              },
              {
                id: 'compact',
                title: 'Compact rows — a shorter board that clears the fold',
                label: (
                  <span className="flex min-h-[22px] items-center sm:min-h-0">
                    <Rows4 size={15} strokeWidth={1.75} aria-hidden />
                    <span className="sr-only">Compact</span>
                  </span>
                ),
              },
            ]}
          />
        </span>
      </div>

      {/* The shelf wraps rather than scrolling: a chip must be on screen to be
          dragged or armed. A chip is also a brush — arm it, then fill from the board. */}
      <div className="mx-5 mb-3.5 border border-ink bg-[var(--page-bg)] sm:mx-[30px]">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <span className="eyebrow mr-1 flex-none text-ink">The shelf</span>
          {shows.length === 0 && (
            <Mu className="text-[9px] normal-case">
              No shows yet —{' '}
              <Link href="/admin/shows" className="text-vermilion underline">
                define one on the Shows page
              </Link>{' '}
              to start scheduling.
            </Mu>
          )}
          {shows.map(s => {
            const armed = s.id === armedShowId;
            return (
              <button
                key={s.id}
                type="button"
                draggable
                aria-pressed={armed}
                onDragStart={e => {
                  e.dataTransfer.setData(DND_TYPE, s.id);
                  e.dataTransfer.setData('text/plain', s.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => onArmShow(s.id)}
                title={armed
                  ? `“${s.name}” is armed — click hours on the board to book it, or click here to put the brush down`
                  : `Click to arm “${s.name}” as a brush, or drag it onto the board`}
                className={cn(
                  'flex min-h-9 flex-none cursor-grab items-center gap-1.5 border px-2.5 py-1.5 active:cursor-grabbing sm:min-h-0',
                  armed
                    ? 'border-ink bg-[var(--ink-soft)] outline-2 -outline-offset-2 outline-[var(--accent)]'
                    : 'border-separator-strong bg-[var(--card-bg)] hover:border-ink',
                )}
              >
                <ColorChip color={colorOf(s.id)} />
                <span className="text-[11.5px] font-semibold whitespace-nowrap text-ink">{s.name}</span>
                <Mu className="text-[8px]">{hoursOf(s.id)}h</Mu>
              </button>
            );
          })}
        </div>
      </div>

      {/* Radix reveals its scrollbar only on hover, so name the swipe outright. */}
      <Mu className="mb-1.5 flex items-center gap-1.5 px-5 tracking-[0.08em] sm:hidden">
        <span aria-hidden="true">◂</span>
        Swipe the board — Mon through Sun
        <span aria-hidden="true">▸</span>
      </Mu>

      <ScrollArea>
        <div ref={gridRef} className="flex w-max min-w-full items-start gap-2.5 pb-1.5 sm:w-full">
          {/* Hour gutter — pt clears the 38px column headers (+border+padding).
              Pinned at every width so the hour stays readable when the board scrolls. */}
          <div className="sticky left-0 z-10 w-[42px] flex-none bg-[var(--card-bg)] pt-[43px]">
            {HOURS.map(h => (
              // aria-disabled, not disabled: Firefox drops the tooltip and focus
              // on a disabled control, and the title is the only explanation here.
              <button
                key={h}
                type="button"
                aria-disabled={!armedShowId}
                onClick={armedShowId ? () => onFillHour(h) : undefined}
                title={armedName
                  ? `Put “${armedName}” on ${hh(h)}:00 every day (again to clear it)`
                  : `${hh(h)}:00 — arm a show on the shelf to fill this hour all week`}
                className={cn(
                  'flex h-[var(--hour-px)] w-full items-start justify-end border-0 bg-transparent pr-[7px] font-mono text-[9px] font-bold text-muted opacity-80',
                  armedShowId
                    ? 'cursor-pointer hover:text-vermilion hover:opacity-100'
                    : 'cursor-default',
                )}
              >
                {hh(h)}
              </button>
            ))}
          </div>

          {DAYS.map(d =>
            folded[d.key] ? (
              <FoldedRail
                key={d.key}
                label={d.label}
                name={d.name}
                count={dayBlocks(schedule, d.key).filter(b => b.showId).length}
                onClick={() => onToggleFold(d.key)}
              />
            ) : (
              <DayColumn
                key={d.key}
                label={d.label}
                name={d.name}
                today={d.key === todayKey}
                blocks={dayBlocks(preview && d.key === dragDay ? preview.week : schedule, d.key)}
                colorOf={colorOf}
                shows={shows}
                density={density}
                hourPx={hourPx}
                armedShowId={armedShowId}
                armedName={armedName}
                onToggleFold={() => onToggleFold(d.key)}
                onFillDay={() => onFillDay(d.key)}
                onPick={onPick}
                onRemove={onRemove}
                onResize={onResize}
                onDropShow={onDropShow}
                dragRun={dragRun}
                dragStart={d.key === dragDay ? (preview?.start ?? dragRun?.block.start ?? null) : null}
                domOrder={d.key === dragDay ? dragOrder : null}
                runPlacements={d.key === dragDay
                  ? previewIdentities ?? identitiesFor(d.key)
                  : identitiesFor(d.key)}
                onRunNudge={(b, step) => {
                  const p = planRunDrag(schedule, b, b.start + step);
                  if (p) commitRun(b, p);
                }}
              />
            ),
          )}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <Mu className="mt-1 block px-5 tracking-[0.08em] sm:px-[30px]">
        Hatched hours are silent — click one to book a show, or leave the station to run itself
      </Mu>
      </section>
    </DndContext>
  );
}

function DayColumn({
  label, name, today, blocks, colorOf, shows, density, hourPx, armedShowId, armedName,
  onToggleFold, onFillDay, onPick, onRemove, onResize, onDropShow,
  dragRun, dragStart, domOrder,
  runPlacements,
  onRunNudge,
}: {
  label: string;
  name: string;
  today: boolean;
  blocks: Block[];
  colorOf: (id: string | null | undefined) => string;
  shows: ScheduleShow[];
  density: BoardDensity;
  hourPx: number;
  armedShowId: string | null;
  armedName: string | null;
  onToggleFold: () => void;
  onFillDay: () => void;
  onPick: (b: Block) => void;
  onRemove: (b: Block) => void;
  onResize: (b: Block, start: number, end: number) => void;
  onDropShow: (b: Block, showId: string) => void;
  dragRun: DragRun | null;
  dragStart: number | null;
  domOrder: string[] | null;
  runPlacements: RunPlacement[] | null;
  onRunNudge: (b: Block, step: number) => void;
}) {
  const showById = (id: string | null) => shows.find(s => s.id === id) ?? null;
  const booked = blocks.reduce((a, b) => a + (b.showId ? b.span : 0), 0);

  const hoursRef = useRef<HTMLDivElement>(null);

  useDynamicStyle(hoursRef, { height: `calc(var(--hour-px) * ${HOURS.length} - 4px)` });

  const keys = blockKeys(blocks, runPlacements ?? []);
  const keyed = blocks.map((block, i) => ({ block, key: keys[i] ?? `${block.start}` }));
  const ordered = domOrder
    ? [...keyed].sort((a, b) => rankIn(domOrder, a.key) - rankIn(domOrder, b.key))
    : keyed;

  return (
    // Phone: fixed-width strip so the next day peeks past the edge. From sm up
    // `min-w-0` lets the seven columns divide the board's width.
    <div className="flex min-w-[164px] flex-1 flex-col border border-ink bg-[var(--page-bg)] sm:min-w-0">
      {/* The header body folds the column, or fills the whole day while a brush
          is armed. The chevron folds in either mode, so an armed brush always
          leaves a collapse control; the footer keeps one too (24 hours tall). */}
      <div className="flex h-[38px] items-stretch border-b border-solid border-b-ink">
        <button
          type="button"
          onClick={armedShowId ? onFillDay : onToggleFold}
          title={armedName
            ? `Put “${armedName}” on all of ${name} (again to clear it)`
            : `Fold ${name} out of the way`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 hover:bg-[var(--ink-soft)]"
        >
          <span
            aria-hidden="true"
            className={cn('size-[7px] flex-none rounded-full', today ? 'bg-[var(--accent)]' : 'bg-ink')}
          />
          <span className="font-mono text-[11px] font-bold tracking-[0.16em] text-ink">{label}</span>
          <span className="ml-auto flex h-5 min-w-5 flex-none items-center justify-center border border-ink bg-[var(--card-bg)] px-1 font-mono text-[9px] font-bold text-ink">
            {blocks.filter(b => b.showId).length}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleFold}
          aria-label={`Fold ${name} out of the way`}
          title={`Fold ${name} out of the way`}
          className="flex w-7 flex-none cursor-pointer items-center justify-center border-0 border-l border-solid border-l-separator-strong bg-transparent p-0 text-muted hover:bg-[var(--ink-soft)] hover:text-ink"
        >
          <FoldHorizontal size={13} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {/* The padding sits outside the ladder so the inner box starts exactly at
          hour 0 — `landing` and the ghost both measure off it. */}
      <div className="p-[5px]">
        <div
          ref={hoursRef}
          className="relative"
        >
          {ordered.map(({ block: b, key }) =>
            b.showId ? (
              <BoardCard
                key={key}
                runKey={key}
                block={b}
                name={showById(b.showId)?.name ?? 'unknown show'}
                color={colorOf(b.showId)}
                density={density}
                hourPx={hourPx}
                previewing={dragStart != null && b.start === dragStart}
                dragOriginStart={dragStart != null && b.start === dragStart
                  ? dragRun?.block.start ?? null
                  : null}
                runDragging={!!dragRun}
                onPick={onPick}
                onRemove={onRemove}
                onResize={onResize}
                onDropShow={onDropShow}
                onRunNudge={onRunNudge}
              />
            ) : (
              <DropSlot
                key={key}
                block={b}
                shows={shows}
                colorOf={colorOf}
                armedShowId={armedShowId}
                armedName={armedName}
                runDragging={!!dragRun}
                onDropShow={onDropShow}
              />
            ),
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-separator-strong px-2.5 py-2">
        <Mu className="text-[8px]">{booked} h booked</Mu>
        {/* min-h-9 on a phone: an 8px text label alone is no tap target. */}
        <button
          type="button"
          onClick={onToggleFold}
          title={`Fold ${name} out of the way`}
          className="ml-auto min-h-9 cursor-pointer border-0 bg-transparent p-0 font-mono text-[8px] tracking-[0.16em] text-muted uppercase hover:text-ink sm:min-h-0"
        >
          Fold
        </button>
      </div>
    </div>
  );
}

function FoldedRail({
  label, name, count, onClick,
}: {
  label: string;
  name: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Open ${name}`}
      className="flex w-12 flex-none cursor-pointer flex-col items-center gap-3 self-stretch border border-ink bg-[var(--card-bg)] py-2.5 hover:bg-[var(--page-bg)]"
    >
      <span className="flex h-5 min-w-5 items-center justify-center border border-ink bg-[var(--card-bg)] px-1 font-mono text-[9px] font-bold text-ink">
        {count}
      </span>
      <span className="font-mono text-[11px] font-bold tracking-[0.18em] text-ink uppercase [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}

// One scheduled run as a card, positioned by hour: `top` is its start and its
// height encodes its duration (one `--hour-px` per hour). A short card prints
// the name alone and leaves the range to the tooltip.
//
// Declared coordinates rather than flow order are what make the reorder
// animate — a displaced card's `top` changes and CSS tweens it — and they are
// also why a resize draft can just draw at the drafted geometry: it overlaps
// its neighbours instead of displacing them, with no margin arithmetic.
//
// An edge drag is a pure preview: the grid is written once, on release. Writing
// per step would remount the handle holding the pointer capture and kill the
// gesture.
function BoardCard({
  runKey, block, name, color, density, hourPx, previewing, dragOriginStart, runDragging,
  onPick, onRemove, onResize, onDropShow, onRunNudge,
}: {
  runKey: string;
  block: Block;
  name: string;
  color: string;
  density: BoardDensity;
  hourPx: number;
  previewing: boolean;
  dragOriginStart: number | null;
  runDragging: boolean;
  onPick: (b: Block) => void;
  onRemove: (b: Block) => void;
  onResize: (b: Block, start: number, end: number) => void;
  onDropShow: (b: Block, showId: string) => void;
  onRunNudge: (b: Block, step: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const drag = useRef<{ edge: ResizeEdge; y0: number } | null>(null);
  const {
    attributes, listeners, setActivatorNodeRef, setNodeRef, transform,
  } = useDraggable({ id: runKey, data: { block } });
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    setNodeRef(node);
  }, [setNodeRef]);

  const blockEnd = block.start + block.span;
  const start = draft?.start ?? block.start;
  const end = draft?.end ?? blockEnd;
  const span = end - start;
  const visualStart = draft?.start ?? dragOriginStart ?? block.start;

  useDynamicStyle(ref, {
    // The active node stays anchored at its original top and follows the
    // sensor transform. Other cards take their preview tops. This avoids a
    // feedback loop where dnd-kit's layout compensation erases finger delta.
    top: `calc(var(--hour-px) * ${visualStart})`,
    height: `calc(var(--hour-px) * ${span} - 4px)`,
    background: color,
    transform: CSS.Translate.toString(transform),
  });

  const commit = (r: { start: number; end: number }) => {
    if (r.start !== block.start || r.end !== blockEnd) onResize(block, r.start, r.end);
  };

  const edgeHour = (edge: ResizeEdge) => (edge === 'top' ? block.start : blockEnd);

  const handleProps = (edge: ResizeEdge) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { edge, y0: e.clientY };
      setDraft({ start: block.start, end: blockEnd });
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d) return;
      const steps = Math.round((e.clientY - d.y0) / hourPx);
      setDraft(resizedRun(block, d.edge, edgeHour(d.edge) + steps));
    },
    onPointerUp: () => {
      if (drag.current && draft) commit(draft);
      drag.current = null;
      setDraft(null);
    },
    // A cancelled pointer abandons the draft rather than committing it.
    onPointerCancel: () => { drag.current = null; setDraft(null); },
    onKeyDown: (e: KeyboardEvent) => {
      const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      commit(resizedRun(block, edge, edgeHour(edge) + step));
    },
  });

  // Two lines need both hour units; compact only has the room from three up.
  const showRange = density === 'comfortable' ? span > 1 : span > 2;
  const range = `${hh(start)} – ${hh(end)}`;
  return (
    <div
      ref={setRefs}
      onDragOver={e => {
        if (runDragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        if (runDragging) return;
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      className={cn(
        'group absolute inset-x-0 text-[#f6f2ea]',
        'hover:outline-2 hover:-outline-offset-1 hover:outline-ink',
        !draft && !previewing
          && 'transition-[top,height] duration-150 ease-out motion-reduce:transition-none',
        over && 'outline-2 -outline-offset-1 outline-ink',
        // Lifted while drafting so the overlap reads as on top of its neighbours.
        draft && 'z-20 outline-2 -outline-offset-1 outline-[var(--accent)]',
        previewing && 'z-20 outline-2 -outline-offset-1 outline-[var(--accent)] outline-dashed',
      )}
    >
      <button
        type="button"
        data-schedule-key={runKey}
        data-schedule-run={`${block.day}:${block.start}`}
        data-schedule-show={block.showId}
        onClick={() => onPick(block)}
        onKeyDown={e => {
          const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
          if (!step) return;
          e.preventDefault();
          onRunNudge(block, step);
        }}
        title={`${name} · ${hh(block.start)} – ${hh(blockEnd)} — click to edit this order, drag its grip (or use the up and down arrow keys) to move these hours, or drag an edge to change them`}
        className={cn(
          'flex size-full cursor-pointer flex-col overflow-hidden border-0 bg-transparent pr-2 pl-7 text-left text-inherit',
          showRange ? 'justify-between py-1.5' : 'justify-center py-0.5',
        )}
      >
        <span className="max-w-full overflow-hidden pr-4 font-mono text-[10.5px] leading-[1.2] font-bold tracking-[0.03em] text-ellipsis whitespace-nowrap uppercase">
          {name}
        </span>
        {showRange && (
          <span className="font-mono text-[9px] tracking-[0.06em] whitespace-nowrap opacity-70">
            {range}
          </span>
        )}
      </button>
      {/* Match the playlist builder's input split: only this 28px grip owns
          touch movement, so a swipe beginning on the card body still scrolls.
          Its hit area is 32px high even on a one-hour compact card; the outer
          card deliberately does not clip it. The resize edges sit above it. */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        data-schedule-drag-handle
        aria-label={`Move “${name}” scheduled ${hh(block.start)}:00 – ${hh(blockEnd)}:00`}
        title={`Drag “${name}” within this day. Hold, then drag on a touch screen.`}
        className="absolute top-1/2 left-0 z-10 grid h-8 w-7 -translate-y-1/2 cursor-grab touch-none place-items-center border-0 bg-transparent p-0 text-inherit opacity-70 focus-visible:ring-1 focus-visible:ring-white focus-visible:outline-none active:cursor-grabbing sm:opacity-0 sm:group-hover:opacity-70 sm:focus-visible:opacity-100"
      >
        <GripVertical size={12} strokeWidth={2} aria-hidden />
      </button>
      {/* While drafting, print the range even on short cards. */}
      {draft && !showRange && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-[rgba(0,0,0,0.45)] px-1 text-center font-mono text-[8.5px] tracking-[0.06em] whitespace-nowrap">
          {range}
        </span>
      )}
      <ResizeHandle
        edge="top"
        label={`Move the start of “${name}” — currently ${hh(block.start)}:00`}
        dragging={drag.current?.edge === 'top'}
        {...handleProps('top')}
      />
      <ResizeHandle
        edge="bottom"
        label={`Move the end of “${name}” — currently ${hh(blockEnd)}:00`}
        dragging={drag.current?.edge === 'bottom'}
        {...handleProps('bottom')}
      />
      <button
        type="button"
        onClick={() => onRemove(block)}
        aria-label={`Take “${name}” off the air`}
        title={`Take “${name}” off the air`}
        className="absolute top-[3px] right-[3px] z-10 flex size-[17px] cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-mono text-[13px] leading-none font-bold text-inherit opacity-0 group-hover:opacity-100 hover:bg-[rgba(0,0,0,0.35)] focus-visible:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

type ResizeEdge = 'top' | 'bottom';

// 7px so it fits either side of a one-hour card (22px of box at the compact
// unit); `touch-action: none` hands the gesture to the pointer handlers.
function ResizeHandle({
  edge, label, dragging, ...rest
}: {
  edge: ResizeEdge;
  label: string;
  dragging: boolean;
} & ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label}. Drag, or use the up and down arrow keys.`}
      className={cn(
        'absolute inset-x-0 z-20 flex h-[7px] cursor-ns-resize touch-none items-center justify-center border-0 bg-transparent p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        edge === 'top' ? 'top-0' : 'bottom-0',
        // A capture can carry the pointer off the card, dropping `group-hover`.
        dragging && 'opacity-100',
      )}
      {...rest}
    >
      <span aria-hidden="true" className="h-[2px] w-6 max-w-[55%] bg-[rgba(246,242,234,0.8)]" />
    </button>
  );
}

// One silent run as a hatched slot. With a show armed the click books it; with
// nothing armed it opens a picker. Same write either way, and the same a drop makes.
function DropSlot({
  block, shows, colorOf, armedShowId, armedName, runDragging, onDropShow,
}: {
  block: Block;
  shows: ScheduleShow[];
  colorOf: (id: string | null | undefined) => string;
  armedShowId: string | null;
  armedName: string | null;
  runDragging: boolean;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  useDynamicStyle(ref, {
    top: `calc(var(--hour-px) * ${block.start})`,
    height: `calc(var(--hour-px) * ${block.span} - 4px)`,
  });
  const span = `${hh(block.start)} – ${hh(block.start + block.span)}`;

  const slot = (
    <button
      ref={ref}
      type="button"
      onClick={armedShowId ? () => onDropShow(block, armedShowId) : undefined}
      onDragOver={e => {
        if (runDragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        if (runDragging) return;
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      title={armedName
        ? `Silent ${span} — click to put “${armedName}” here`
        : `Silent ${span} — click to book a show here, or drop one in`}
      className={cn(
        'absolute inset-x-0 flex cursor-pointer flex-col items-center justify-center overflow-hidden border border-dashed bg-[repeating-linear-gradient(45deg,transparent_0_5px,var(--ink-soft)_5px_10px)] px-1.5 font-mono text-[9px] tracking-[0.12em] text-ellipsis whitespace-nowrap uppercase',
        'transition-[top,height] duration-150 ease-out motion-reduce:transition-none',
        over
          ? 'border-ink text-ink'
          : 'border-[color-mix(in_oklab,var(--ink)_32%,transparent)] text-muted hover:border-ink hover:text-ink',
      )}
    >
      {armedName ? `+ ${armedName}` : '+ Add a show'}
    </button>
  );

  // Armed, the slot writes on click — there is no menu to open.
  if (armedShowId) return slot;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={shows.length === 0}>
        {slot}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-[10rem] overflow-y-auto">
        <DropdownMenuGroup>
          {shows.map(s => (
            <DropdownMenuItem key={s.id} onClick={() => onDropShow(block, s.id)}>
              <ColorChip color={colorOf(s.id)} />
              {s.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
