'use client';

// On air: what aired (most played, from the durable play history) and what
// the DJ did (the booth log since boot, as LED ladders), with the transitions
// record summarised in one line that opens its detail under Diagnostics.

import { cn } from '../../../lib/cn';
import { effectSeamCount } from '../../../lib/transitionStats';
import { Skeleton } from '@/components/ui/skeleton';
import { Cell, CellGrid, Hint, LABEL, Leds, Panel, PanelHead, Section } from './parts';
import { fmtInt, fmtPct, fmtShare } from './format';
import type { DjLogStats, TransitionStats, WeekRecap } from './types';

const rank = (i: number) => String(i + 1).padStart(2, '0');

function MostPlayed({ recap }: { recap: WeekRecap | null }) {
  const played = recap?.mostPlayed;
  return (
    <Panel>
      <PanelHead title="Most played" sub={`last ${played?.days ?? 7} days · play history`} />
      {!played ? (
        <div className="p-[18px]"><Skeleton className="h-40 w-full" /></div>
      ) : played.artists.length === 0 ? (
        <div className="p-[18px]"><Hint>no plays recorded in the last week</Hint></div>
      ) : (
        <CellGrid min={220}>
          <Cell className="gap-0.5">
            <span className={cn(LABEL, 'mb-1.5')}>Artists</span>
            <ol className="m-0 list-none p-0">
              {played.artists.map((a, i) => (
                <li
                  key={a.name}
                  className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-2.5 border-b border-separator-soft py-1.5"
                >
                  <span className="font-mono text-[10px] text-muted">{rank(i)}</span>
                  <span className="truncate text-[13px] font-semibold">{a.name}</span>
                  <span className={cn('font-mono text-[12px] font-bold tabular-nums', i === 0 && 'text-vermilion')}>{a.plays}</span>
                </li>
              ))}
            </ol>
          </Cell>
          <Cell className="gap-0.5">
            <span className={cn(LABEL, 'mb-1.5')}>Tracks</span>
            <ol className="m-0 list-none p-0">
              {played.tracks.map((t, i) => (
                <li
                  key={`${t.artist}\u0000${t.title}`}
                  className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-2.5 border-b border-separator-soft py-1.5"
                >
                  <span className="font-mono text-[10px] text-muted">{rank(i)}</span>
                  <span className="grid min-w-0">
                    <span className="truncate text-[13px] font-semibold">{t.title}</span>
                    {t.artist && <span className="truncate text-[11px] text-muted">{t.artist}</span>}
                  </span>
                  <span className={cn('font-mono text-[12px] font-bold tabular-nums', i === 0 && 'text-vermilion')}>{t.plays}</span>
                </li>
              ))}
            </ol>
          </Cell>
        </CellGrid>
      )}
    </Panel>
  );
}

const LADDER = 24;

function DjActivity({ djLog, transitions, onTransitions }: {
  djLog: DjLogStats;
  transitions: TransitionStats | null | undefined;
  onTransitions: () => void;
}) {
  const max = djLog.byKind[0]?.count || 1;
  return (
    <Panel>
      <PanelHead title="DJ activity" sub={`last ${fmtInt(djLog.count)} log events by kind`} />
      <div className="grid gap-[9px] px-[18px] py-4">
        {djLog.byKind.length === 0 ? <Hint>no booth-log events yet</Hint> : djLog.byKind.map(d => (
          <div
            key={d.kind}
            className="grid grid-cols-[minmax(0,96px)_auto_minmax(0,1fr)_34px] items-center gap-3 text-[12px]"
          >
            <span className="truncate font-mono text-[11px]" title={d.kind}>{d.kind}</span>
            <Leds frac={Math.max(d.count / max, 1 / LADDER)} n={LADDER} />
            <span className="text-right font-mono font-bold tabular-nums">{fmtInt(d.count)}</span>
            <span className="text-right font-mono text-[11px] text-muted">{fmtShare(d.count, djLog.count)}</span>
          </div>
        ))}
      </div>
      {/* Absent means a controller too old to keep the record: no line at all. */}
      {transitions !== undefined && (
        <div className="flex flex-wrap items-baseline gap-2.5 border-t border-separator-strong px-[18px] py-3 font-mono text-[11px]">
          <span className={LABEL}>Transitions · {transitions?.days ?? 7}d</span>
          <span className="text-muted">
            {!transitions ? 'play history unavailable' : (
              <>
                {fmtInt(transitions.seams)} seams · <b className="text-vermilion">{fmtInt(effectSeamCount(transitions.bySeam))}</b> with an effect
                {transitions.seams > 0 && ` (${fmtPct(effectSeamCount(transitions.bySeam) / transitions.seams)})`} · {fmtInt(transitions.dropped)} dropped
              </>
            )}
          </span>
          {transitions && (
            <a
              href="#stats-diagnostics"
              onClick={onTransitions}
              className="ml-auto text-ink underline underline-offset-[3px] hover:text-vermilion"
            >
              details
            </a>
          )}
        </div>
      )}
    </Panel>
  );
}

export function OnAir({ recap, djLog, transitions, onTransitions }: {
  recap: WeekRecap | null;
  djLog: DjLogStats | null;
  transitions: TransitionStats | null | undefined;
  onTransitions: () => void;
}) {
  return (
    <Section title="On air" sub="what aired and what the DJ did" id="stats-on-air">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))] items-start gap-4">
        <MostPlayed recap={recap} />
        {djLog ? (
          <DjActivity djLog={djLog} transitions={transitions} onTransitions={onTransitions} />
        ) : (
          <Panel className="p-[18px]"><Skeleton className="h-40 w-full" /></Panel>
        )}
      </div>
    </Section>
  );
}
