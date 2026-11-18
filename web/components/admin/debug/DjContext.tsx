'use client';

import { Pill } from '../ui';
import type { DebugContext } from './types';
import { titleize } from './MountsTable';

export function DjContext({ ctx }: { ctx?: DebugContext | null }) {
  if (!ctx || Object.keys(ctx).length === 0) {
    return <span className="field-hint italic">—</span>;
  }
  if (ctx.error) {
    return <span className="field-hint italic">{ctx.error}</span>;
  }

  const { time, weather, festival, dominantMood, date, clock, activeShow, listeners } = ctx;

  const flags = [
    clock?.isWeekend && 'weekend',
    clock?.isLateNight && 'late night',
    clock?.isCommute && 'commute',
  ].filter(Boolean) as string[];

  const weatherLine = weather
    ? [
        // The spoken wording, with the mood-map word beside it when they differ.
        weather.detail && weather.detail !== weather.condition
          ? `${titleize(weather.detail)} (${weather.condition})`
          : titleize(weather.condition),
        weather.temp != null ? `${weather.temp}°${weather.tempUnit || ''}` : null,
        weather.location,
      ].filter(Boolean).join(' · ')
    : '';

  const dateLine = date
    ? [
        date.dayLabel,
        date.dayOfMonth != null && date.monthLabel ? `${date.dayOfMonth} ${date.monthLabel}` : null,
      ].filter(Boolean).join(', ')
    : '';

  const count = listeners?.count;

  return (
    <dl className="kv">
      {dominantMood && (
        <>
          <dt>Mood</dt>
          <dd className="font-bold text-vermilion">{titleize(dominantMood)}</dd>
        </>
      )}
      {(dateLine || date?.season) && (
        <>
          <dt>Date</dt>
          <dd>
            {dateLine}
            {date?.season ? <span className="text-muted"> · {titleize(date.season)}</span> : null}
          </dd>
        </>
      )}
      {(clock?.hhmm || flags.length > 0) && (
        <>
          <dt>Clock</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            {clock?.hhmm && <span className="mono-num">{clock.hhmm}</span>}
            {flags.map(f => <Pill key={f}>{f}</Pill>)}
          </dd>
        </>
      )}
      {time?.period && (
        <>
          <dt>Daypart</dt>
          <dd>
            {titleize(time.period)}
            {time.vibe ? <span className="text-muted"> · {time.vibe}</span> : null}
          </dd>
        </>
      )}
      {weatherLine && (
        <>
          <dt>Weather</dt>
          <dd>
            {weatherLine}
            {weather?.isDay != null ? (
              <span className="text-muted"> · {weather.isDay ? 'daytime' : 'night'}</span>
            ) : null}
          </dd>
        </>
      )}
      <dt>Festival</dt>
      <dd>
        {festival?.name ? (
          <>
            {festival.name}
            {festival.mood ? <span className="text-muted"> · {festival.mood}</span> : null}
          </>
        ) : (
          <span className="text-muted italic">none today</span>
        )}
      </dd>
      <dt>Show</dt>
      <dd>
        {activeShow?.name ? (
          <>
            {activeShow.name}
            {activeShow.persona?.name ? <span className="text-muted"> · {activeShow.persona.name}</span> : null}
          </>
        ) : (
          <span className="text-muted italic">autonomous, no show scheduled</span>
        )}
      </dd>
      <dt>Listeners</dt>
      <dd>{count == null ? <span className="text-muted italic">unknown</span> : `${count} listening`}</dd>
    </dl>
  );
}


