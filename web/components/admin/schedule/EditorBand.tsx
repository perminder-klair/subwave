'use client';

// The order desk — the full-width band under the board. Holds the sentence
// order editor ("Put Chill Lounge on the air from 16:00 until 18:00"), the
// orders behind the day being edited, the week's numbers, computed
// suggestions, and airtime-vs-target bars. All of it renders from the same
// grid the board uses.

import { useRef } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import { Button } from '../../ui/button';
import { ColorChip, DayPills, Mu, SlotMenu } from './bits';
import type { Block, ScheduleShow } from './lib';
import { HOURS, dayLabel, dayName, hhmm } from './lib';

export interface EditorLine {
  day: number;
  start: number;
  end: number;
}

export interface Suggestion {
  key: string;
  kind: 'Gap' | 'Balance';
  text: string;
  actionLabel: string;
  onAction: () => void;
  dismissLabel: string;
}

export interface AirtimeRow {
  id: string;
  name: string;
  color: string;
  hours: number;
  /** Bar width, 0–100. */
  pct: number;
  under: boolean;
}

export interface EditorBandProps {
  shows: ScheduleShow[];
  line: EditorLine;
  lineShowId: string | null;
  lineDays: number[];
  /** The show currently occupying the edited range (context line). */
  currentName: string | null;
  colorOf: (id: string | null | undefined) => string;
  onLineChange: (patch: Partial<EditorLine>) => void;
  onLineShow: (id: string) => void;
  onToggleLineDay: (day: number) => void;
  onAir: () => void;
  onQuiet: () => void;
  orderNo: number;
  orders: Block[];
  showById: (id: string | null) => ScheduleShow | null;
  onPickOrder: (b: Block) => void;
  stats: { booked: number; showCount: number; orderCount: number };
  suggestions: Suggestion[];
  onDismissSuggestion: (key: string) => void;
  airtime: AirtimeRow[];
  tickPct: number;
  target: number;
}

export default function EditorBand({
  shows, line, lineShowId, lineDays, currentName, colorOf,
  onLineChange, onLineShow, onToggleLineDay, onAir, onQuiet,
  orderNo, orders, showById, onPickOrder,
  stats, suggestions, onDismissSuggestion, airtime, tickPct, target,
}: EditorBandProps) {
  const lineShow = shows.find(s => s.id === lineShowId) ?? null;
  return (
    <section className="border-t border-ink bg-[var(--page-bg)] px-[30px] py-[22px]">
      <div className="grid items-start gap-x-9 gap-y-7 xl:grid-cols-[minmax(430px,1.25fr)_1fr_1fr_1fr]">
        {/* ── Editing this line ─────────────────────────────────────────── */}
        <div>
          <div className="mb-0.5">
            <span className="eyebrow text-ink">Editing this line</span>
          </div>
          <Mu className="mb-3 block tracking-[0.08em]">
            {dayName(line.day)} {hhmm(line.start)} → {hhmm(line.end)} ·{' '}
            {currentName ? `currently ${currentName}` : 'currently silent'}
          </Mu>
          <div className="border border-ink bg-[var(--card-bg)] p-[15px]">
            <div className="flex flex-wrap items-center gap-2 text-[14.5px] text-ink">
              <span>Put</span>
              <SlotMenu
                ariaLabel="Show to put on the air"
                label={lineShow ? lineShow.name : 'a show…'}
                chipColor={lineShow ? colorOf(lineShow.id) : null}
                options={shows.map(s => ({ key: s.id, label: s.name, chipColor: colorOf(s.id) }))}
                onSelect={onLineShow}
                disabled={shows.length === 0}
              />
              <span>on</span>
              <SlotMenu
                ariaLabel="Day"
                label={dayName(line.day)}
                options={[
                  { key: '1', label: 'Monday' }, { key: '2', label: 'Tuesday' },
                  { key: '3', label: 'Wednesday' }, { key: '4', label: 'Thursday' },
                  { key: '5', label: 'Friday' }, { key: '6', label: 'Saturday' },
                  { key: '0', label: 'Sunday' },
                ]}
                onSelect={k => onLineChange({ day: Number(k) })}
              />
              <span>from</span>
              <SlotMenu
                ariaLabel="From hour"
                label={hhmm(line.start)}
                options={HOURS.map(h => ({ key: String(h), label: hhmm(h) }))}
                onSelect={k => {
                  const start = Number(k);
                  onLineChange({ start, end: Math.max(line.end, start + 1) });
                }}
              />
              <span>until</span>
              <SlotMenu
                ariaLabel="Until hour"
                label={hhmm(line.end)}
                options={HOURS.filter(h => h > line.start).concat(24).map(h => ({ key: String(h), label: hhmm(h) }))}
                onSelect={k => onLineChange({ end: Number(k) })}
              />
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-separator-strong pt-2.5">
              <span className="eyebrow text-muted">Also apply to</span>
              <DayPills selected={lineDays} onToggle={onToggleLineDay} />
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="accent" size="sm" onClick={onAir} disabled={!lineShow}>
                Put it on air
              </Button>
              <Button variant="ghost" size="sm" onClick={onQuiet}>
                Leave it quiet
              </Button>
            </div>
          </div>
          <div className="mt-2.5">
            <span className="eyebrow text-muted">Becomes order №{orderNo}</span>
          </div>

          {/* ── Worth a look ──────────────────────────────────────────── */}
          {suggestions.length > 0 && (
            <div className="mt-6">
              <div className="mb-2.5">
                <span className="eyebrow text-ink">Worth a look</span>
              </div>
              <div className="grid gap-[7px]">
                {suggestions.map(sug => (
                  <div key={sug.key} className="grid gap-2 border border-separator-strong bg-[var(--card-bg)] p-3 hover:border-ink">
                    <div className="flex items-center gap-2">
                      <span className={cn('eyebrow', sug.kind === 'Gap' ? 'text-vermilion' : 'text-ink')}>
                        {sug.kind}
                      </span>
                      <span className="text-[12.5px] text-ink">{sug.text}</span>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="solid" size="sm" onClick={sug.onAction}>
                        {sug.actionLabel}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDismissSuggestion(sug.key)}>
                        {sug.dismissLabel}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Orders behind this day ────────────────────────────────────── */}
        <div className="xl:border-l xl:border-separator-strong xl:pl-9">
          <div className="mb-0.5">
            <span className="eyebrow text-ink">Orders behind this day</span>
          </div>
          <Mu className="mb-2.5 block tracking-[0.08em]">
            The {orders.length === 1 ? 'one' : orders.length} that shape {dayName(line.day)}
          </Mu>
          <div className="flex flex-col gap-1">
            {orders.length === 0 && (
              <Mu className="text-[9px] normal-case">Nothing scheduled yet — the station runs itself.</Mu>
            )}
            {orders.map(b => {
              const s = showById(b.showId);
              return (
                <button
                  key={`${b.day}-${b.start}`}
                  type="button"
                  onClick={() => onPickOrder(b)}
                  className="grid cursor-pointer grid-cols-[9px_1fr_auto_44px] items-center gap-3 border border-separator-strong bg-[var(--card-bg)] px-[11px] py-[9px] text-left hover:border-ink"
                >
                  <ColorChip color={colorOf(b.showId)} />
                  <span className="truncate text-[12.5px] font-semibold text-ink">
                    {s?.name ?? 'unknown show'}
                  </span>
                  <Mu className="text-[9px] tracking-[0.1em]">
                    {dayLabel(b.day)} {b.start} → {b.start + b.span}
                  </Mu>
                  <span className="text-right font-mono text-[10.5px] font-bold text-ink">
                    {b.span}h
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── The week in numbers ───────────────────────────────────────── */}
        <div className="xl:border-l xl:border-separator-strong xl:pl-9">
          <div className="mb-2.5">
            <span className="eyebrow text-ink">The week in numbers</span>
          </div>
          <div className="grid grid-cols-2 gap-[11px]">
            <BandStat n={stats.booked} label="hours booked" />
            <BandStat n={168 - stats.booked} label="hours of dead air" accent />
            <BandStat n={stats.showCount} label="shows on rotation" />
            <BandStat n={stats.orderCount} label="standing orders" />
          </div>
        </div>

        {/* ── Airtime against your target ───────────────────────────────── */}
        <div className="xl:border-l xl:border-separator-strong xl:pl-9">
          <div className="mb-[11px] flex items-baseline gap-2">
            <span className="eyebrow text-ink">Airtime against your target</span>
            <Mu className="text-[9px] tracking-[0.1em]">tick = {target} h</Mu>
          </div>
          <div className="grid gap-2">
            {airtime.length === 0 && (
              <Mu className="text-[9px] normal-case">No shows yet.</Mu>
            )}
            {airtime.map(row => (
              <AirtimeBar key={row.id} row={row} tickPct={tickPct} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function BandStat({ n, label, accent }: { n: number; label: string; accent?: boolean }) {
  return (
    <div
      className={cn(
        'border bg-[var(--card-bg)] px-3 py-[11px]',
        accent ? 'border-[var(--accent)]' : 'border-separator-strong',
      )}
    >
      <div className={cn('font-display text-[27px] leading-none font-semibold', accent ? 'text-vermilion' : 'text-ink')}>
        {n}
      </div>
      <Mu className={cn('mt-1 block text-[8.5px]', accent && 'text-vermilion')}>{label}</Mu>
    </div>
  );
}

function AirtimeBar({ row, tickPct }: { row: AirtimeRow; tickPct: number }) {
  const barRef = useRef<HTMLDivElement>(null);
  const tickRef = useRef<HTMLDivElement>(null);
  useDynamicStyle(barRef, { width: `${row.pct}%`, background: row.color });
  useDynamicStyle(tickRef, { left: `${tickPct}%` });
  return (
    <div className="grid grid-cols-[96px_1fr_32px] items-center gap-2.5">
      <Mu className={cn('truncate text-[9px]', row.under && 'text-vermilion')} >
        {row.name}
      </Mu>
      <div className="relative flex">
        <div ref={barRef} className="h-[9px]" />
        <div
          ref={tickRef}
          aria-hidden="true"
          className={cn('absolute -top-[3px] -bottom-[3px] w-px', row.under ? 'bg-[var(--accent)]' : 'bg-ink')}
        />
      </div>
      <span className={cn('text-right font-mono text-[10px] font-bold', row.under ? 'text-vermilion' : 'text-ink')}>
        {row.hours}h
      </span>
    </div>
  );
}
