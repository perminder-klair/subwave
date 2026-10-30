'use client';

// The rack: host load and memory, and each SUB/WAVE container, on LED
// ladders like the meters on a rack unit. The red zone starts at 80%: of the
// cores for load, of the host's memory for memory.

import { cn } from '../../../lib/cn';
import { memoryHealth } from '../../../lib/statsHealth';
import { Skeleton } from '@/components/ui/skeleton';
import { Cell, CellGrid, FIGURE, Hint, LABEL, Leds, MetricCell, Panel, SUB, Section } from './parts';
import { fmtBytes, fmtInt } from './format';
import type { SystemResponse } from './types';

const RED_ZONE = 0.8;

export function Rack({ system }: { system: SystemResponse | null }) {
  const host = system?.host ?? null;
  const containers = system?.containers ?? [];
  const memFrac = host?.memTotal ? host.memUsed / host.memTotal : 0;
  const memCheck = host ? memoryHealth(host).health : 'idle';
  return (
    <Section title="The rack" sub="cpu + memory for the sub/wave containers on this host" id="stats-rack">
      <Panel>
        {system == null ? (
          <div className="p-[18px]"><Skeleton className="h-24 w-full" /></div>
        ) : (
          <>
            <CellGrid min={220} className="border-b border-ink">
              <Cell className="gap-1.5">
                <span className={LABEL}>Load{host ? ` · ${host.cpus} cores` : ''}</span>
                {host ? (['1m', '5m', '15m'] as const).map((label, i) => (
                  <div key={label} className="grid grid-cols-[28px_auto_minmax(0,1fr)] items-center gap-2.5">
                    <span className="font-mono text-[10px] text-muted">{label}</span>
                    <Leds frac={host.loadavg[i]! / host.cpus} n={20} redFrom={RED_ZONE} label={`${Math.round((host.loadavg[i]! / host.cpus) * 100)}% of the cores`} />
                    <span className="font-mono text-[12px] font-bold tabular-nums">{host.loadavg[i]!.toFixed(2)}</span>
                  </div>
                )) : <span className={SUB}>host load unknown</span>}
              </Cell>
              <Cell className="gap-1.5">
                <div className="flex justify-between gap-2">
                  <span className={LABEL}>Host memory</span>
                  {(memCheck === 'warn' || memCheck === 'bad') && (
                    <span className={cn(LABEL, memCheck === 'bad' ? 'text-[var(--danger)]' : 'text-vermilion')}>
                      {memCheck === 'bad' ? 'alert' : 'check'}
                    </span>
                  )}
                </div>
                {host ? (
                  <>
                    <span className={FIGURE}>
                      {fmtBytes(host.memUsed).replace(/ GB$/, '')}{' '}
                      <span className="text-[13px] text-muted">/ {fmtBytes(host.memTotal)}</span>
                    </span>
                    <Leds frac={memFrac} n={30} redFrom={RED_ZONE} tall label={`${Math.round(memFrac * 100)}% in use`} />
                    <span className={SUB}>{Math.round(memFrac * 100)}% used · red zone above {RED_ZONE * 100}%</span>
                  </>
                ) : <span className={SUB}>host memory unknown</span>}
              </Cell>
              <MetricCell
                label="Containers"
                value={fmtInt(containers.length)}
                sub={system.dockerAvailable ? 'running · sampled every 30s' : 'container stats unavailable'}
              />
            </CellGrid>
            {!system.dockerAvailable ? (
              <div className="p-[18px]">
                <Hint>
                  start the docker-socket-proxy sidecar (docker compose up -d) to see each container
                  {system.dockerError ? ` · ${system.dockerError}` : ''}
                </Hint>
              </div>
            ) : containers.length === 0 ? (
              <div className="p-[18px]"><Hint>no containers reporting</Hint></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse">
                  <thead>
                    <tr className="border-b border-separator-strong font-mono text-[10px] font-bold tracking-[0.14em] uppercase">
                      <th className="w-[34px] py-2.5 pl-[18px] text-left font-bold">unit</th>
                      <th className="px-3.5 py-2.5 text-left font-bold">service</th>
                      <th className="w-[210px] px-3.5 py-2.5 text-left font-bold">cpu</th>
                      <th className="w-[270px] py-2.5 pr-[18px] pl-3.5 text-left font-bold">memory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {containers.map((c, i) => (
                      <tr key={c.name} className="border-b border-separator-soft">
                        <td className="py-2.5 pl-[18px] font-mono text-[10px] text-muted">U{i + 1}</td>
                        <td className="px-3.5 py-2.5 font-mono text-[12px] font-bold">{c.service}</td>
                        <td className="px-3.5 py-2.5">
                          <span className="flex items-center gap-2.5">
                            <Leds frac={c.cpuPct / 100} n={20} />
                            <span className="font-mono text-[12px] tabular-nums">{c.cpuPct.toFixed(1)}%</span>
                          </span>
                        </td>
                        <td className="py-2.5 pr-[18px] pl-3.5">
                          <span className="flex items-center gap-2.5">
                            <Leds frac={c.memPct / 100} n={20} />
                            <span className="font-mono text-[12px] tabular-nums">{fmtBytes(c.memUsed)}</span>
                            <span className="font-mono text-[11px] text-muted tabular-nums">{c.memPct.toFixed(1)}%</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Panel>
    </Section>
  );
}
