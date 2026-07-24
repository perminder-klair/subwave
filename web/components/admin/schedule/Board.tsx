'use client';

// The board — a kanban-style 7-column × 24-hour view of the week. Shows are
// cards whose height equals their duration (34px per hour); silent runs are
// hatched drop targets. Columns fold to 48px vertical rails. The shelf above
// is the drag source: dropping a chip on a block writes that block's hours to
// the show (a local edit — Save the week persists).

import type { DragEvent } from 'react';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import { ColorChip, Mu, SegBtn } from './bits';
import type { Block, Schedule, ScheduleShow } from './lib';
import { DAYS, HOURS, dayBlocks, hh } from './lib';

const DND_TYPE = 'text/x-subwave-show';

function readDraggedShow(e: DragEvent): string {
  return e.dataTransfer.getData(DND_TYPE) || e.dataTransfer.getData('text/plain');
}

export interface BoardProps {
  schedule: Schedule;
  shows: ScheduleShow[];
  folded: Record<number, boolean>;
  onToggleFold: (day: number) => void;
  onOpenAll: () => void;
  onFoldWeekdays: () => void;
  todayKey: number;
  colorOf: (id: string | null | undefined) => string;
  hoursOf: (id: string) => number;
  onPick: (b: Block) => void;
  onDropShow: (b: Block, showId: string) => void;
  onArmShow: (id: string) => void;
}

export default function Board({
  schedule, shows, folded, onToggleFold, onOpenAll, onFoldWeekdays,
  todayKey, colorOf, hoursOf, onPick, onDropShow, onArmShow,
}: BoardProps) {
  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3.5 border-b border-ink pb-2">
        <h2 className="m-0 font-display text-[24px] leading-none font-semibold">The board</h2>
        <Mu className="text-[9px]">Seven days, twenty-four hours — drag to schedule</Mu>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3.5">
        <Mu className="tracking-[0.08em]">
          Drag a show onto an hour and the order writes itself — click a day to fold it out of the way
        </Mu>
        <div className="ml-auto flex gap-1.5">
          <SegBtn onClick={onOpenAll}>Open all seven</SegBtn>
          <SegBtn onClick={onFoldWeekdays}>Fold the weekdays</SegBtn>
        </div>
      </div>

      {/* The shelf — one draggable chip per show */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2 border border-ink bg-[var(--page-bg)] px-3 py-2.5">
        <span className="eyebrow mr-1 text-ink">The shelf</span>
        {shows.length === 0 && (
          <Mu className="text-[9px] normal-case">
            No shows yet —{' '}
            <Link href="/admin/shows" className="text-vermilion underline">
              define one on the Shows page
            </Link>{' '}
            to start scheduling.
          </Mu>
        )}
        {shows.map(s => (
          <button
            key={s.id}
            type="button"
            draggable
            onDragStart={e => {
              e.dataTransfer.setData(DND_TYPE, s.id);
              e.dataTransfer.setData('text/plain', s.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onArmShow(s.id)}
            title={`Drag onto the board, or click to load “${s.name}” into the order editor`}
            className="flex cursor-grab items-center gap-1.5 border border-separator-strong bg-[var(--card-bg)] px-2.5 py-1.5 hover:border-ink active:cursor-grabbing"
          >
            <ColorChip color={colorOf(s.id)} />
            <span className="text-[11.5px] font-semibold text-ink">{s.name}</span>
            <Mu className="text-[8px]">{hoursOf(s.id)}h</Mu>
          </button>
        ))}
      </div>

      <div className="flex items-start gap-2.5 overflow-x-auto pb-2.5">
        {/* Hour gutter — pt clears the 38px column headers (+border+padding) */}
        <div className="w-[42px] flex-none pt-[43px]">
          {HOURS.map(h => (
            <div
              key={h}
              className="flex h-[34px] items-start justify-end pr-[7px] font-mono text-[9px] font-bold text-muted opacity-80"
            >
              {hh(h)}
            </div>
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
              onToggleFold={() => onToggleFold(d.key)}
              onPick={onPick}
              onDropShow={onDropShow}
            />
          ),
        )}
      </div>
      <Mu className="mt-1 block tracking-[0.08em]">
        Hatched hours are silent — drop something in, or leave the station to run itself
      </Mu>
    </section>
  );
}

function DayColumn({
  label, name, today, blocks, colorOf, shows,
  onToggleFold, onPick, onDropShow,
}: {
  label: string;
  name: string;
  today: boolean;
  blocks: Block[];
  colorOf: (id: string | null | undefined) => string;
  shows: ScheduleShow[];
  onToggleFold: () => void;
  onPick: (b: Block) => void;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const showById = (id: string | null) => shows.find(s => s.id === id) ?? null;
  const booked = blocks.reduce((a, b) => a + (b.showId ? b.span : 0), 0);
  return (
    <div className="flex w-[188px] flex-none flex-col border border-ink bg-[var(--page-bg)]">
      <button
        type="button"
        onClick={onToggleFold}
        title={`Fold ${name} out of the way`}
        className="flex h-[38px] cursor-pointer items-center gap-2 border-0 border-b border-solid border-b-ink bg-transparent px-2.5 hover:bg-[var(--ink-soft)]"
      >
        <span
          aria-hidden="true"
          className={cn('size-[7px] rounded-full', today ? 'bg-[var(--accent)]' : 'bg-ink')}
        />
        <span className="font-mono text-[11px] font-bold tracking-[0.16em] text-ink">{label}</span>
        <span className="ml-auto flex h-5 min-w-5 items-center justify-center border border-ink bg-[var(--card-bg)] px-1 font-mono text-[9px] font-bold text-ink">
          {blocks.filter(b => b.showId).length}
        </span>
      </button>
      <div className="flex flex-col gap-1 p-[5px]">
        {blocks.map(b =>
          b.showId ? (
            <BoardCard
              key={`${b.start}`}
              block={b}
              name={showById(b.showId)?.name ?? 'unknown show'}
              color={colorOf(b.showId)}
              onPick={onPick}
              onDropShow={onDropShow}
            />
          ) : (
            <DropSlot key={`${b.start}`} block={b} onPick={onPick} onDropShow={onDropShow} />
          ),
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-separator-strong px-2.5 py-2">
        <Mu className="text-[8px]">{booked} h booked</Mu>
        <Mu className="ml-auto text-[8px]">Fold</Mu>
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
      className="flex min-h-[360px] w-12 flex-none cursor-pointer flex-col items-center gap-3 self-stretch border border-ink bg-[var(--card-bg)] py-2.5 hover:bg-[var(--page-bg)]"
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

// One scheduled run as a card — height encodes duration (34px per hour).
function BoardCard({
  block, name, color, onPick, onDropShow,
}: {
  block: Block;
  name: string;
  color: string;
  onPick: (b: Block) => void;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  useDynamicStyle(ref, {
    height: `${block.span * 34 - 4}px`,
    background: color,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPick(block)}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      title={`${name} · ${hh(block.start)} – ${hh(block.start + block.span)} — click to edit this order`}
      className={cn(
        'flex cursor-pointer flex-col justify-between overflow-hidden border-0 px-2 py-1.5 text-left text-[#f6f2ea]',
        'hover:outline-2 hover:-outline-offset-1 hover:outline-ink',
        over && 'outline-2 -outline-offset-1 outline-ink',
      )}
    >
      <span className="overflow-hidden font-mono text-[10.5px] font-bold tracking-[0.03em] text-ellipsis whitespace-nowrap uppercase">
        {name}
      </span>
      <span className="font-mono text-[9px] tracking-[0.06em] whitespace-nowrap opacity-70">
        {hh(block.start)} – {hh(block.start + block.span)}
      </span>
    </button>
  );
}

// One silent run as a hatched drop target.
function DropSlot({
  block, onPick, onDropShow,
}: {
  block: Block;
  onPick: (b: Block) => void;
  onDropShow: (b: Block, showId: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  useDynamicStyle(ref, { height: `${block.span * 34 - 4}px` });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPick(block)}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = readDraggedShow(e);
        if (id) onDropShow(block, id);
      }}
      title={`Silent ${hh(block.start)} – ${hh(block.start + block.span)} — drop a show here, or click to edit`}
      className={cn(
        'flex cursor-copy flex-col items-center justify-center border border-dashed bg-[repeating-linear-gradient(45deg,transparent_0_5px,var(--ink-soft)_5px_10px)] font-mono text-[9px] tracking-[0.12em] uppercase',
        over
          ? 'border-ink text-ink'
          : 'border-[color-mix(in_oklab,var(--ink)_32%,transparent)] text-muted hover:border-ink hover:text-ink',
      )}
    >
      Drop a show
    </button>
  );
}
