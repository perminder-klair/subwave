'use client';

// Engine room: the DJ's model and voice since boot. Latency reads on a tuner
// scale against what it has to beat: the agent deadline for model calls (past
// it a pick falls back), and the slowest render for speech.

import { cn } from '../../../lib/cn';
import { llmHealth, voiceFailureHealth, voiceFallbackHealth } from '../../../lib/statsHealth';
import { Pill } from '../ui';
import { Bar, Cell, CellGrid, Hint, LABEL, MetricCell, NOTE, Panel, PanelHead, SUB, Section, StackBar, Swatch, Tuner, healthTone, type TunerMark } from './parts';
import { fmtInt, fmtPct, fmtSec, fmtShare, fmtTokens, fmtUsd, kindName } from './format';
import type { LlmStats, TtsStats } from './types';

interface MixRow {
  key: string;
  name: string;
  count: number;
  // Figures after the share, already formatted; `alert` ones print vermilion.
  details: { text: string; alert?: boolean }[];
}

// A whole split by who did the work (which model answered, which engine spoke),
// shown only when more than one did: with one, the header badge already says it.
function Mix({ title, note, rows, total }: { title: string; note: string; rows: MixRow[]; total: number }) {
  if (rows.length < 2) return null;
  return (
    <div className="grid gap-2.5 border-b border-ink px-[18px] py-3.5">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className={LABEL}>{title}</span>
        <span className={NOTE}>{note}</span>
      </div>
      <StackBar
        label={rows.map(r => `${r.name} ${fmtShare(r.count, total)}`).join(', ')}
        parts={rows.map(r => ({ key: r.key, frac: total ? r.count / total : 0 }))}
      />
      <ul className="m-0 grid list-none gap-1.5 p-0 text-[12px]">
        {rows.map((r, i) => (
          <li key={r.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            <Swatch index={i} />
            <span className="min-w-0 truncate font-semibold">{r.name}</span>
            <span className="font-mono text-[11px] text-muted">
              {fmtInt(r.count)} · {fmtShare(r.count, total)}
              {r.details.map(d => (
                <span key={d.text} className={d.alert ? 'text-vermilion' : undefined}> · {d.text}</span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const sec = (ms: number | undefined) => (ms == null ? null : ms / 1000);

// A step that divides the scale into at most a dozen whole divisions.
function scaleStep(max: number): number {
  return [5, 10, 15, 20, 30, 60].find(s => max % s === 0 && max / s <= 12) ?? max / 9;
}

function marks(list: [string, number | null, boolean?][]): TunerMark[] {
  return list
    .filter((m): m is [string, number, boolean?] => m[1] != null)
    .map(([name, v, accent]) => ({ label: `${name} ${v.toFixed(1)}s`, value: v, accent }));
}

function LlmPanel({ llm }: { llm: LlmStats }) {
  const deadline = Math.round((llm.agentTimeoutMs ?? 45_000) / 1000);
  const p95 = sec(llm.latency.p95);
  const slowest = [...llm.byKind].filter(k => k.avgMs != null).sort((a, b) => (b.avgMs ?? 0) - (a.avgMs ?? 0))[0];
  const kinds = [...llm.byKind].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || b.count - a.count);
  const tokenTotal = kinds.reduce((a, k) => a + (k.tokens ?? 0), 0);
  const health = llmHealth(llm).health;
  return (
    <Panel>
      <PanelHead
        title="LLM usage"
        sub={`last ${llm.window} model calls`}
        right={(llm.provider || llm.activeModel) && (
          <>
            {llm.provider && <Pill>{llm.provider}</Pill>}
            {llm.activeModel && <Pill tone="accent">{llm.activeModel}</Pill>}
          </>
        )}
      />
      {llm.count === 0 ? (
        <div className="p-[18px]"><Hint>no model calls recorded yet</Hint></div>
      ) : (
        <>
          <CellGrid min={170} className="border-b border-ink">
            <MetricCell label="Calls" value={fmtInt(llm.count)} sub={`${fmtInt(llm.ok)} ok · ${fmtInt(llm.failed)} failed`} />
            <MetricCell
              label="Success"
              value={fmtPct(llm.successRate)}
              tone={healthTone(health)}
              sub={llm.deadlineHits != null ? `${fmtInt(llm.deadlineHits)} deadline ${llm.deadlineHits === 1 ? 'hit' : 'hits'}` : undefined}
            />
            <MetricCell
              label="Tokens"
              value={fmtTokens(llm.tokens?.total)}
              sub={llm.tokens ? `${fmtTokens(llm.tokens.input)} in · ${fmtTokens(llm.tokens.output)} out` : 'provider reports none'}
            />
            <MetricCell
              label="Est. cost"
              value={llm.cost ? fmtUsd(llm.cost.usd) : '—'}
              sub={!llm.cost
                ? 'no token usage reported'
                : !llm.cost.complete
                  ? 'partial: a model with no list price'
                  : `≈ ${fmtUsd(llm.cost.usd / llm.count)} per call`}
            />
            <MetricCell
              label="Agent runs"
              value={fmtInt(llm.agent.calls)}
              sub={llm.agent.calls ? `${llm.agent.avgSteps} steps · ${llm.agent.avgTools} tools avg` : 'none'}
            />
          </CellGrid>
          <Mix
            title="Model mix"
            note="which model answered"
            total={llm.count}
            rows={(llm.byModel ?? []).map(m => ({
              key: m.model,
              name: m.model,
              count: m.count,
              details: [
                ...(m.tokens ? [{ text: `${fmtTokens(m.tokens)} tokens` }] : []),
                ...(m.costUsd != null && m.priced !== false && m.tokens ? [{ text: `≈ ${fmtUsd(m.costUsd)}` }] : []),
                ...(m.priced === false ? [{ text: 'no list price' }] : []),
              ],
            }))}
          />
          <CellGrid min={360}>
            <Cell className="gap-3.5 px-[18px] pt-4 pb-5">
              <span className={LABEL}>Latency vs agent deadline</span>
              <Tuner
                max={deadline}
                step={scaleStep(deadline)}
                deadline
                marks={marks([
                  ['p50', sec(llm.latency.p50)],
                  ['avg', sec(llm.latency.avg)],
                  ['p95', p95, true],
                ])}
              />
              <span className={cn(SUB, 'leading-normal')}>
                {p95 != null && `p95 sits at ${Math.round((p95 / deadline) * 100)}% of the deadline.`}
                {slowest && ` ${kindName(slowest.kind)} is the slowest kind at ${fmtSec(slowest.avgMs)} avg.`}
              </span>
            </Cell>
            <Cell className="gap-2 px-[18px] py-4">
              {/* The share bar drops out on a phone so the kind names keep their room. */}
              <div className="grid grid-cols-[minmax(0,1fr)_36px_40px_46px] gap-2.5 border-b border-separator-strong pb-1.5 font-mono text-[10px] font-bold tracking-[0.14em] uppercase sm:grid-cols-[minmax(0,1fr)_36px_40px_minmax(48px,84px)_46px]">
                <span>by call kind</span>
                <span className="text-right">calls</span>
                <span className="text-right">avg</span>
                <span className="hidden sm:block">token share</span>
                <span className="text-right">tokens</span>
              </div>
              {kinds.map((k, i) => (
                <div
                  key={k.kind}
                  className="grid grid-cols-[minmax(0,1fr)_36px_40px_46px] items-center gap-2.5 text-[12px] sm:grid-cols-[minmax(0,1fr)_36px_40px_minmax(48px,84px)_46px]"
                >
                  <span className="flex min-w-0 items-baseline gap-1.5" title={k.kind}>
                    <span className="truncate">{kindName(k.kind)}</span>
                    {k.ok < k.count && (
                      <span className="shrink-0 font-mono text-[10px] font-bold whitespace-nowrap text-vermilion">
                        {fmtInt(k.count - k.ok)} failed
                      </span>
                    )}
                  </span>
                  <span className="text-right font-mono tabular-nums">{fmtInt(k.count)}</span>
                  <span className="text-right font-mono text-muted tabular-nums">{fmtSec(k.avgMs)}</span>
                  <Bar frac={tokenTotal ? (k.tokens ?? 0) / tokenTotal : 0} lead={i === 0} className="hidden sm:block" />
                  <span className="text-right font-mono font-bold tabular-nums">{fmtTokens(k.tokens || null)}</span>
                </div>
              ))}
            </Cell>
          </CellGrid>
        </>
      )}
    </Panel>
  );
}

function TtsPanel({ tts }: { tts: TtsStats }) {
  const max = sec(tts.latency.max);
  // Room past the slowest render, in whole fives, ten at least.
  const scale = Math.max(10, Math.ceil(((max ?? 0) * 1.2) / 5) * 5);
  const kindMax = tts.byKind[0]?.count || 1;
  return (
    <Panel>
      <PanelHead
        title="Voice / TTS"
        sub={`last ${tts.window} spoken segments`}
        right={tts.byEngine.length > 0 && tts.byEngine.map(e => <Pill key={e.engine} tone="ink">{e.engine}</Pill>)}
      />
      {tts.count === 0 ? (
        <div className="p-[18px]"><Hint>no spoken segments recorded yet</Hint></div>
      ) : (
        <>
          <CellGrid min={170} className="border-b border-ink">
            <MetricCell
              label="Segments"
              value={fmtInt(tts.count)}
              tone={healthTone(voiceFailureHealth(tts).health)}
              sub={`${fmtInt(tts.ok)} ok · ${fmtInt(tts.failed)} failed`}
            />
            <MetricCell
              label="Fallbacks"
              value={fmtInt(tts.fellBack)}
              tone={healthTone(voiceFallbackHealth(tts).health)}
              sub={`${fmtPct(tts.fallbackRate)} of calls`}
            />
            <MetricCell
              label="Characters"
              value={fmtTokens(tts.chars)}
              sub={tts.chars ? `≈ ${fmtInt(Math.round(tts.chars / tts.count))} per segment` : undefined}
            />
            <MetricCell
              label="Slowest"
              value={fmtSec(tts.latency.max)}
              sub={tts.slowest?.kind ? `a ${tts.slowest.kind} segment` : undefined}
            />
          </CellGrid>
          <Mix
            title="Voice mix"
            note="which engine spoke · a backup engine means the main voice failed"
            total={tts.count}
            rows={tts.byEngine.map(e => ({
              key: e.engine,
              name: e.engine,
              count: e.count,
              details: [
                ...(e.avgMs != null ? [{ text: `${fmtSec(e.avgMs)} avg` }] : []),
                ...(e.ok < e.count ? [{ text: `${fmtInt(e.count - e.ok)} failed`, alert: true }] : []),
              ],
            }))}
          />
          <CellGrid min={360}>
            <Cell className="gap-3.5 px-[18px] pt-4 pb-5">
              <span className={LABEL}>Time to speak</span>
              <Tuner
                max={scale}
                step={scaleStep(scale)}
                marks={marks([
                  ['avg', sec(tts.latency.avg)],
                  ['p95', sec(tts.latency.p95)],
                  ['max', max, true],
                ])}
              />
            </Cell>
            <Cell className="gap-2 px-[18px] py-4">
              <div className="grid grid-cols-[minmax(0,96px)_minmax(0,1fr)_30px_40px] gap-2.5 border-b border-separator-strong pb-1.5 font-mono text-[10px] font-bold tracking-[0.14em] uppercase">
                <span>by kind</span>
                <span />
                <span className="text-right">segs</span>
                <span className="text-right">avg</span>
              </div>
              {tts.byKind.map((k, i) => (
                <div key={k.kind} className="grid grid-cols-[minmax(0,96px)_minmax(0,1fr)_30px_40px] items-center gap-2.5 text-[12px]">
                  <span className="truncate font-mono text-[11px]" title={k.kind}>{k.kind}</span>
                  <Bar frac={k.count / kindMax} lead={i === 0} />
                  <span className="text-right font-mono font-bold tabular-nums">{fmtInt(k.count)}</span>
                  <span className="text-right font-mono text-muted tabular-nums">{fmtSec(k.avgMs)}</span>
                </div>
              ))}
            </Cell>
          </CellGrid>
        </>
      )}
    </Panel>
  );
}

export function EngineRoom({ llm, tts }: { llm: LlmStats | null; tts: TtsStats | null }) {
  return (
    <Section title="Engine room" sub="the DJ's brain and voice · since boot" id="stats-engine">
      {llm ? <LlmPanel llm={llm} /> : <Panel className="p-[18px]"><Hint>connecting…</Hint></Panel>}
      {tts ? <TtsPanel tts={tts} /> : null}
    </Section>
  );
}
