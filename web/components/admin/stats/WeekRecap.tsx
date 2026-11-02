'use client';

// This week: the last seven complete UTC days against the seven before, as a
// broadsheet front page. From /stats/week, which reads only the durable records;
// a null figure is unmeasured (a station too young for the comparison), so it
// prints without a delta rather than as a fall to zero.

import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn';
import { Skeleton } from '@/components/ui/skeleton';
import { Cell, CellGrid, Hint, LABEL, NOTE, Panel, SUB, Section } from './parts';
import { fmtInt } from './format';
import type { WeekRecap as Recap, WeekTotals } from './types';

const utcDay = (date: string) => new Date(`${date}T00:00:00Z`);

const plural = (n: number, word: string) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`;

const fmtDay = (date: string, opts: Intl.DateTimeFormatOptions) =>
  utcDay(date).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

// "Fri 23 – Thu 29 Oct", the month named once when both ends share it.
function weekRange(from: string, to: string): string {
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return `${fmtDay(from, { weekday: 'short', day: 'numeric', ...(sameMonth ? {} : { month: 'short' }) })} – ${fmtDay(to, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

// "23–29 Oct 2026"
function weekSpan(from: string, to: string): string {
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const start = sameMonth ? fmtDay(from, { day: 'numeric' }) : fmtDay(from, { day: 'numeric', month: 'short' });
  return `${start}–${fmtDay(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function pctDelta(now: number | null, before: number | null): string | null {
  if (now == null || before == null || before === 0) return null;
  const d = Math.round(((now - before) / before) * 100);
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}%`;
}

function countDelta(now: number | null, before: number | null): string | null {
  if (now == null || before == null) return null;
  const d = now - before;
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)}`;
}

function Delta({ label, value, delta, lead }: { label: string; value?: string; delta: string | null; lead?: boolean }) {
  return (
    <span>
      {label}
      {value != null && ` ${value}`}
      {delta && <b className={cn('ml-1', lead ? 'text-vermilion' : 'text-ink')}>{delta}</b>}
    </span>
  );
}

function Headline({ t }: { t: WeekTotals }) {
  const parts: string[] = [];
  if (t.sessions != null) {
    parts.push(`${fmtInt(t.sessions)} ${t.sessions === 1 ? 'session' : 'sessions'}`
      + (t.countries ? ` from ${fmtInt(t.countries)} ${t.countries === 1 ? 'country' : 'countries'}` : ''));
  }
  if (t.tracks != null) parts.push(`${fmtInt(t.tracks)} ${t.tracks === 1 ? 'track' : 'tracks'} on air`);
  return (
    <p className="m-0 max-w-[24ch] font-display text-[clamp(28px,6vw,42px)] leading-[1.08] font-normal tracking-[-0.02em] text-balance">
      {parts.length ? `${parts.join(', and ')}.` : 'A quiet week.'}
    </p>
  );
}

function Fact({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <Cell className="gap-1.5 px-6 py-[18px]">
      <span className={LABEL}>{label}</span>
      <span className="font-display text-[24px] leading-[1.1] break-words">{value}</span>
      <span className={SUB}>{sub}</span>
    </Cell>
  );
}

export function WeekRecap({ recap }: { recap: Recap | null }) {
  if (!recap) {
    return (
      <Section title="This week" id="stats-week">
        <Panel className="p-6"><Skeleton className="h-24 w-full" /></Panel>
      </Section>
    );
  }
  const { current: now, previous: before, week } = recap;
  const empty = !now.sessions && !now.tracks && !now.listeningHours;
  const busiest = recap.busiestHour ? new Date(recap.busiestHour.at) : null;
  return (
    <Section
      title="This week"
      id="stats-week"
      sub={`${weekRange(week.from, week.to)} · vs the week before`}
    >
      <Panel>
        <div className="flex flex-wrap justify-between gap-2 border-b-[3px] border-double border-ink px-6 py-4">
          <span className={LABEL}>The week on {recap.station}</span>
          <span className={NOTE}>No. {week.number} · {weekSpan(week.from, week.to)}</span>
        </div>
        {empty ? (
          <div className="px-6 py-6"><Hint>nothing recorded this week yet: the recap fills in as listeners and plays arrive</Hint></div>
        ) : (
          <>
            <div className="grid gap-4 border-b border-ink px-6 pt-7 pb-6">
              <Headline t={now} />
              <div className="flex flex-wrap gap-x-[22px] gap-y-1 font-mono text-[12px] text-muted">
                {/* Sessions and countries are in the headline already; alone they
                    only add their change, so with no week before they drop out. */}
                {pctDelta(now.sessions, before.sessions) && (
                  <Delta label="sessions" delta={pctDelta(now.sessions, before.sessions)} lead />
                )}
                {countDelta(now.countries, before.countries) && (
                  <Delta label="countries" delta={countDelta(now.countries, before.countries)} />
                )}
                {now.listeningHours != null && (
                  <Delta
                    label="listening hours"
                    value={fmtInt(Math.round(now.listeningHours))}
                    delta={pctDelta(now.listeningHours, before.listeningHours)}
                  />
                )}
                {now.requests != null && (
                  <Delta label="requests" value={fmtInt(now.requests)} delta={pctDelta(now.requests, before.requests)} />
                )}
              </div>
            </div>
            <CellGrid min={190}>
              {busiest && recap.busiestHour && (
                <Fact
                  label="Busiest hour"
                  value={`${busiest.toLocaleDateString('en-GB', { weekday: 'short' })}, ${busiest.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
                  sub={`avg ${recap.busiestHour.avg} listeners`}
                />
              )}
              {recap.topArtist && (
                <Fact
                  label="Top artist"
                  value={recap.topArtist.name}
                  sub={`${plural(recap.topArtist.plays, 'play')}${recap.topArtist.requested ? ` · ${fmtInt(recap.topArtist.requested)} requested` : ''}`}
                />
              )}
              {recap.topTrack && (
                <Fact
                  label="Top track"
                  value={recap.topTrack.title}
                  sub={`${plural(recap.topTrack.plays, 'play')}${recap.topTrack.artist ? ` · ${recap.topTrack.artist}` : ''}`}
                />
              )}
              {recap.topRequester && (
                <Fact
                  label="Top requester"
                  value={recap.topRequester.name}
                  sub={`${plural(recap.topRequester.requests, 'request')} · anon excluded`}
                />
              )}
              {recap.newSource && (
                <Fact
                  label="New source"
                  value={recap.newSource.source}
                  sub={`${plural(recap.newSource.sessions, 'session')} · first seen ${fmtDay(recap.newSource.firstSeen, { weekday: 'short' })}`}
                />
              )}
            </CellGrid>
          </>
        )}
      </Panel>
    </Section>
  );
}
