'use client';

// The on-air listing — the whole week as a printed programme guide, one day
// after another, each day foldable. Every row is a block from the same grid
// the board renders; clicking a row loads the order behind it into the
// right-rail sentence editor.

import { cn } from '../../../lib/cn';
import { ColorChip, Mu, SegBtn } from './bits';
import type { Block, Schedule, ScheduleShow } from './lib';
import { DAYS, dayBlocks, hhmm } from './lib';

export interface ListingProps {
  schedule: Schedule;
  shows: ScheduleShow[];
  metaOf: (showId: string | null) => string;
  todayKey: number;
  nowHour: number;
  colorOf: (id: string | null | undefined) => string;
  listFolded: Record<number, boolean>;
  onToggleFold: (day: number) => void;
  onOpenAll: () => void;
  onFoldAll: () => void;
  onPick: (b: Block) => void;
  bookedTotal: number;
}

export default function Listing({
  schedule, shows, metaOf, todayKey, nowHour, colorOf,
  listFolded, onToggleFold, onOpenAll, onFoldAll, onPick, bookedTotal,
}: ListingProps) {
  return (
    <section>
      <div className="mt-9 mb-4 flex items-baseline gap-3.5 border-b border-ink pb-2">
        <h2 className="m-0 font-display text-[24px] leading-none font-semibold">On air listing</h2>
        <Mu className="text-[9px]">The week as it sounds — click a day to fold it</Mu>
        <div className="ml-auto flex gap-1.5">
          <SegBtn onClick={onOpenAll}>Open every day</SegBtn>
          <SegBtn onClick={onFoldAll}>Fold them all</SegBtn>
        </div>
      </div>

      <div className="mb-4 flex items-center gap-3.5">
        <Mu className="tracking-[0.08em]">
          The whole week, top to bottom — click any time or title to edit the order behind it
        </Mu>
        <Mu className="ml-auto text-[9px]">
          {bookedTotal} h scheduled · {168 - bookedTotal} h silent
        </Mu>
      </div>

      {DAYS.map(d => {
        const today = d.key === todayKey;
        const open = !listFolded[d.key];
        const blocks = dayBlocks(schedule, d.key);
        const booked = blocks.reduce((a, b) => a + (b.showId ? b.span : 0), 0);
        const showCount = blocks.filter(b => b.showId).length;
        const summary = booked === 24
          ? `24 h booked · ${showCount} show${showCount === 1 ? '' : 's'}`
          : `${booked} h booked · ${24 - booked} h silent`;
        return (
          <div key={d.key} id={`listing-day-${d.key}`} className="mb-6 scroll-mt-4">
            <button
              type="button"
              onClick={() => onToggleFold(d.key)}
              className={cn(
                '-mx-1.5 flex w-[calc(100%+12px)] cursor-pointer items-baseline gap-3 border-0 border-b-[1.5px] border-solid bg-transparent px-1.5 pb-1.5 text-left hover:bg-[var(--ink-soft)]',
                today ? 'border-b-[var(--accent)]' : 'border-b-ink',
              )}
            >
              <span aria-hidden="true" className="w-[9px] font-mono text-[9px] text-muted">
                {open ? '▾' : '▸'}
              </span>
              <span
                className={cn(
                  'font-display text-[22px] leading-none font-semibold',
                  today ? 'text-vermilion' : 'text-ink',
                )}
              >
                {d.name}
              </span>
              <span className={cn('eyebrow', today ? 'text-vermilion' : 'text-ink')}>
                {today ? 'Today' : d.label}
              </span>
              <Mu className="ml-auto text-[9px]">{summary}</Mu>
              <Mu className="text-[8.5px]">{open ? 'Fold' : 'Open'}</Mu>
            </button>
            {open && (
              <div>
                {blocks.map(b => (
                  <ListingRow
                    key={b.start}
                    block={b}
                    show={shows.find(s => s.id === b.showId) ?? null}
                    live={today && b.start <= nowHour && nowHour < b.start + b.span}
                    color={colorOf(b.showId)}
                    meta={metaOf(b.showId)}
                    onPick={onPick}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function ListingRow({
  block, show, live, color, meta, onPick,
}: {
  block: Block;
  show: ScheduleShow | null;
  live: boolean;
  color: string;
  meta: string;
  onPick: (b: Block) => void;
}) {
  const silent = !block.showId;
  return (
    <button
      type="button"
      onClick={() => onPick(block)}
      className={cn(
        'group -mx-2 flex w-[calc(100%+16px)] cursor-pointer items-baseline gap-[11px] border-0 border-b border-solid border-b-separator-soft bg-transparent px-2 py-1.5 text-left hover:bg-[var(--ink-soft)]',
        live && 'bg-[color-mix(in_oklab,var(--accent)_8%,var(--card-bg))]',
        silent && 'border-y border-dashed border-y-[var(--accent)]',
      )}
    >
      <span className="w-[126px] flex-none font-mono text-[11.5px] font-bold tracking-[0.06em] whitespace-nowrap text-muted">
        {hhmm(block.start)} – {hhmm(block.start + block.span)}
      </span>
      <ColorChip color={silent ? null : color} />
      <span
        className={cn(
          'border-b border-dotted whitespace-nowrap',
          silent
            ? 'border-transparent font-display text-[14px] text-vermilion italic'
            : cn(
                'font-display text-[15.5px] font-semibold group-hover:border-[var(--accent)] group-hover:text-vermilion',
                live ? 'border-transparent text-vermilion' : 'border-transparent text-ink',
              ),
        )}
      >
        {show ? show.name : silent ? 'Nobody in the chair' : 'unknown show'}
      </span>
      <span aria-hidden="true" className="mx-3 mb-[5px] min-w-6 flex-1 border-b border-dotted border-[color-mix(in_oklab,var(--ink)_30%,transparent)]" />
      <Mu className="text-[8.5px] whitespace-nowrap">{meta}</Mu>
      <span
        className={cn(
          'w-[88px] flex-none text-right font-mono text-[10px] font-bold tracking-[0.08em]',
          live || silent ? 'text-vermilion' : 'text-muted',
        )}
      >
        {live ? 'ON AIR' : silent ? 'SILENT' : `${block.span} h`}
      </span>
    </button>
  );
}
