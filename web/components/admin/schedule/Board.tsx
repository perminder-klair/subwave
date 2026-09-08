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
import { useRef, useState } from 'react';
import Link from 'next/link';
import { FoldHorizontal, Rows2, Rows4 } from 'lucide-react';
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
import type { Block, Schedule, ScheduleShow } from './lib';
import { DAYS, HOURS, dayBlocks, hh, resizedRun } from './lib';

const DND_TYPE = 'text/x-subwave-show';

function readDraggedShow(e: DragEvent): string {
  return e.dataTransfer.getData(DND_TYPE) || e.dataTransfer.getData('text/plain');
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
  colorOf, hoursOf, onPick, onRemove, onResize, onDropShow,
  armedShowId, onArmShow, onFillDay, onFillHour,
  density, hourPx, onDensity,
}: BoardProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(gridRef, { '--hour-px': `${hourPx}px` });
  const armedName = shows.find(s => s.id === armedShowId)?.name ?? null;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-2 px-5 sm:px-[30px]">
        {/* Two lengths: drag-and-drop and the 7px card edges are mouse-only. */}
        <Mu className="min-w-0 flex-1 tracking-[0.08em] sm:hidden">
          {armedName
            ? `${armedName} is armed — tap an hour to book it, or a day header for the whole day`
            : 'Tap a silent hour to book a show — tap a card to edit its order, its × to take it off the air'}
        </Mu>
        <Mu className="hidden min-w-0 flex-1 tracking-[0.08em] sm:block">
          {armedName
            ? `${armedName} is armed — click any hour to book it, a day header for the whole day, or an hour in the gutter for that hour all week`
            : 'Click a silent hour (or drag a show onto it) to book a show — click a card to edit its order, drag its top or bottom edge to change the hours, its × to take it off the air'}
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
                blocks={dayBlocks(schedule, d.key)}
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
  );
}

function DayColumn({
  label, name, today, blocks, colorOf, shows, density, hourPx, armedShowId, armedName,
  onToggleFold, onFillDay, onPick, onRemove, onResize, onDropShow,
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
}) {
  const showById = (id: string | null) => shows.find(s => s.id === id) ?? null;
  const booked = blocks.reduce((a, b) => a + (b.showId ? b.span : 0), 0);
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
      <div className="flex flex-col gap-1 p-[5px]">
        {blocks.map(b =>
          b.showId ? (
            <BoardCard
              key={`${b.start}`}
              block={b}
              name={showById(b.showId)?.name ?? 'unknown show'}
              color={colorOf(b.showId)}
              density={density}
              hourPx={hourPx}
              onPick={onPick}
              onRemove={onRemove}
              onResize={onResize}
              onDropShow={onDropShow}
            />
          ) : (
            <DropSlot
              key={`${b.start}`}
              block={b}
              shows={shows}
              colorOf={colorOf}
              armedShowId={armedShowId}
              armedName={armedName}
              onDropShow={onDropShow}
            />
          ),
        )}
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

// One scheduled run as a card; height encodes duration (one `--hour-px` per
// hour). A short card prints the name alone and leaves the range to the tooltip.
//
// An edge drag is a pure preview: the grid is written once, on release. Cards
// are re-derived by `dayBlocks` keyed on `start`, so writing per step would
// remount the handle holding the pointer capture and kill the gesture. The card
// draws at the drafted size and pulls the difference out of its own margins.
function BoardCard({
  block, name, color, density, hourPx, onPick, onRemove, onResize, onDropShow,
}: {
  block: Block;
  name: string;
  color: string;
  density: BoardDensity;
  hourPx: number;
  onPick: (b: Block) => void;
  onRemove: (b: Block) => void;
  onResize: (b: Block, start: number, end: number) => void;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const drag = useRef<{ edge: ResizeEdge; y0: number } | null>(null);

  const blockEnd = block.start + block.span;
  const start = draft?.start ?? block.start;
  const end = draft?.end ?? blockEnd;
  const span = end - start;

  useDynamicStyle(ref, {
    height: `calc(var(--hour-px) * ${span} - 4px)`,
    // Negative when the draft has grown past the real run, so the card overlaps
    // its neighbours instead of displacing them.
    marginTop: draft ? `calc(var(--hour-px) * ${start - block.start})` : undefined,
    marginBottom: draft ? `calc(var(--hour-px) * ${blockEnd - end})` : undefined,
    background: color,
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
      ref={ref}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      className={cn(
        'group relative overflow-hidden text-[#f6f2ea]',
        'hover:outline-2 hover:-outline-offset-1 hover:outline-ink',
        over && 'outline-2 -outline-offset-1 outline-ink',
        // Lifted while drafting so the overlap reads as on top of its neighbours.
        draft && 'z-20 outline-2 -outline-offset-1 outline-[var(--accent)]',
      )}
    >
      <button
        type="button"
        onClick={() => onPick(block)}
        title={`${name} · ${hh(block.start)} – ${hh(blockEnd)} — click to edit this order, or drag an edge to change the hours`}
        className={cn(
          'flex size-full cursor-pointer flex-col overflow-hidden border-0 bg-transparent px-2 text-left text-inherit',
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
        'absolute inset-x-0 z-10 flex h-[7px] cursor-ns-resize touch-none items-center justify-center border-0 bg-transparent p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
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
  block, shows, colorOf, armedShowId, armedName, onDropShow,
}: {
  block: Block;
  shows: ScheduleShow[];
  colorOf: (id: string | null | undefined) => string;
  armedShowId: string | null;
  armedName: string | null;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  useDynamicStyle(ref, { height: `calc(var(--hour-px) * ${block.span} - 4px)` });
  const span = `${hh(block.start)} – ${hh(block.start + block.span)}`;

  const slot = (
    <button
      ref={ref}
      type="button"
      onClick={armedShowId ? () => onDropShow(block, armedShowId) : undefined}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      title={armedName
        ? `Silent ${span} — click to put “${armedName}” here`
        : `Silent ${span} — click to book a show here, or drop one in`}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center overflow-hidden border border-dashed bg-[repeating-linear-gradient(45deg,transparent_0_5px,var(--ink-soft)_5px_10px)] px-1.5 font-mono text-[9px] tracking-[0.12em] text-ellipsis whitespace-nowrap uppercase',
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
