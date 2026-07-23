'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { fmtSize, fmtClock } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3Alert } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Card, Btn, Pill, Eyebrow } from './ui';
import { ScrollArea } from '../ui/scroll-area';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { cn } from '../../lib/cn';
import type { StationLocale } from '../../lib/types';
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from '../ai-elements/tool';
import { CodeBlock, CodeBlockCopyButton } from '../ai-elements/code-block';
import { Conversation, ConversationContent } from '../ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '../ai-elements/message';
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
} from '../ai-elements/context';
import { Terminal, TerminalContent } from '../ai-elements/terminal';

// All admin endpoints return loose JSON; type as unknown then narrow with
// optional-chaining at call sites. The shapes mirror the controller's
// /debug response.
interface DebugIcecast {
  listeners?: number;
  peakListeners?: number;
  error?: string;
}

interface DebugLibrary {
  total?: number;
  updatedAt?: string;
}

interface DebugQueueEntry {
  title?: string;
  artist?: string;
  requestedBy?: string;
}

interface DjLogEntry {
  id: string;
  t?: string;
  kind?: string;
  message?: string;
}

interface DebugQueue {
  current?: Record<string, unknown> | null;
  upcoming?: DebugQueueEntry[];
  djLog?: DjLogEntry[];
  djLogCount?: number;
}

interface DebugTtsSpoken {
  engine?: string;
  voice?: string;
  provider?: string;
  fellBack?: boolean;
  requested?: string;
}

/** One entry from the controller's TTS call ring (stats.ts ttsCalls) — every
 * speak() outcome since boot, newest first, incl. silent engine fallbacks. */
interface TtsCall {
  ok?: boolean;
  kind?: string;
  engine?: string;
  requested?: string;
  fellBack?: boolean;
  ms?: number;
  chars?: number;
  t?: string;
  error?: string;
  /** Spoken text, capped at ~240 chars by the controller. */
  text?: string;
  /** Voicing persona name; null for global kinds (jingle/default). */
  persona?: string | null;
}

interface DebugTts {
  spoken?: DebugTtsSpoken;
  jingle?: { engine?: string };
  effectivePersona?: { name?: string };
  recentCalls?: TtsCall[];
  error?: string;
}

interface SessionMessage {
  t?: string;
  role?: string;
  kind?: string;
  text?: string;
}

interface DebugSession {
  kind?: string;
  show?: { name?: string };
  persona?: { name?: string };
  messages?: SessionMessage[];
  handoff?: string;
  error?: string;
}

interface LlmCall {
  ok?: boolean;
  kind?: string;
  model?: string;
  via?: string;
  ms?: number;
  t?: string;
  error?: string;
  user?: string;
  system?: string;
  systemPreview?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  toolCalls?: Array<{ name?: string; args?: unknown; result?: unknown }>;
  response?: string;
  /** What the model said INSTEAD of the expected structured output on a
   * failed call (e.g. "agent did not call the done tool") — one labelled
   * block per attempt that declined. Populated by failureDiagnostics() in
   * the controller; absent on success (see `response` instead). */
  responseText?: string;
  steps?: number;
}

interface DebugLlm {
  activeModel?: string;
  provider?: string;
  budget?: DebugBudget;
  recentCalls?: LlmCall[];
  /** Raw-request capture status — drives the toggle + file-path hint. */
  debug?: {
    enabled?: boolean;
    viaEnv?: boolean;
    file?: string;
    max?: number;
  };
}

interface SubsonicEndpoint {
  endpoint: string;
  calls: number;
}

interface SubsonicCall {
  ok?: boolean;
  endpoint?: string;
  count?: number;
  ms?: number;
  t?: string;
  error?: string;
  params?: Record<string, unknown>;
  songIds?: Array<{ title?: string; artist?: string }>;
}

interface DebugSubsonic {
  recentCalls?: SubsonicCall[];
  endpoints?: SubsonicEndpoint[];
  error?: string;
}

interface FileEntry {
  name: string;
  size?: number;
  mtime?: string;
  isDir?: boolean;
}

type FilesValue = FileEntry[] | { error?: string } | undefined;

// Mirrors the controller's getFullContext() snapshot — what the DJ "feels"
// right now. Rendered human-friendly by <DjContext>, not as raw JSON.
interface DebugContext {
  time?: { period?: string; mood?: string; vibe?: string; show?: string };
  weather?: {
    condition?: string;
    mood?: string | null;
    temp?: number | null;
    tempUnit?: string;
    isDay?: boolean;
    location?: string;
  };
  festival?: { name?: string; mood?: string } | null;
  dominantMood?: string;
  date?: {
    iso?: string;
    dayOfWeek?: number;
    dayLabel?: string;
    monthLabel?: string;
    dayOfMonth?: number;
    season?: string;
  };
  clock?: { hhmm?: string; isWeekend?: boolean; isLateNight?: boolean; isCommute?: boolean };
  activeShow?: { name?: string; mood?: string; topic?: string; persona?: { name?: string } | null } | null;
  listeners?: { count?: number | null };
  error?: string;
}

interface DebugMount {
  path: string;
  codec: string;
  configured: boolean;
  live: boolean;
  bitrate: number | null;
  listeners: number | null;
  sampleRate: number | null;
  channels: number | null;
  contentType: string | null;
  url: string;
}

interface DebugMounts {
  list: DebugMount[];
  tuneIn: { entryCount: number; pls: string; m3u: string };
}

/** Daily token budget snapshot (settings.llm.dailyTokenCap) — mirrors the
 * controller's budgetMode() tiers: soft mutes optional segments, hard stops
 * model calls entirely until the UTC day rolls. */
interface DebugBudget {
  enabled?: boolean;
  cap?: number;
  softPct?: number;
  exemptRequests?: boolean;
  usedToday?: number;
  remaining?: number;
  mode?: 'normal' | 'soft' | 'hard';
}

interface DebugData {
  /** Station IANA zone — render DJ-log timestamps in it (issue #418). */
  timezone?: string;
  locale?: StationLocale;
  icecast?: DebugIcecast;
  liquidsoapLog?: string;
  llm?: DebugLlm;
  queue?: DebugQueue;
  library?: DebugLibrary;
  nowPlaying?: Record<string, unknown> | null;
  context?: DebugContext | null;
  tts?: DebugTts;
  subsonic?: DebugSubsonic;
  session?: DebugSession;
  stateFiles?: FilesValue;
  voiceFiles?: FilesValue;
  config?: Record<string, unknown>;
  mounts?: DebugMounts;
  error?: string;
}

export default function DebugPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<DebugData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      // Single-flight: never start a new poll while one is in flight. A slow
      // /debug (it can take several seconds) must not stack overlapping
      // requests on the single-threaded controller — that pileup starved every
      // other /api/* call and caused edge 524s.
      if (cancelled || running) return;
      running = true;
      try {
        // Skip the fetch when paused or the tab is hidden — no point polling a
        // backgrounded tab — but keep the loop alive so it resumes cleanly.
        if (!paused && !(typeof document !== 'undefined' && document.hidden)) {
          const r = await adminFetch('/debug');
          if (r.status === 401) {
            if (!cancelled) setData(null);
          } else {
            const j = (await r.json()) as DebugData;
            if (!cancelled) {
              if (!j || typeof j !== 'object' || !j.queue) {
                setErr(j?.error || 'unexpected response shape from /debug');
                setData(null);
              } else {
                setData(j);
                setErr(null);
              }
            }
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        running = false;
        // Schedule the next poll only after this one settles, so the gap is
        // measured from completion, not from start — no overlap is possible.
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    };
    tick();
    // Refresh promptly when the tab regains focus so the panel isn't stale.
    const onVisible = () => {
      if (!cancelled && !document.hidden) {
        if (timer) { clearTimeout(timer); timer = null; }
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [paused, needsAuth, hydrated, adminFetch]);

  return (
    <div className="grid gap-4">
      {/* ── HEALTH STRIP ────────────────────────────────────────────────── */}
      <section className="card">
        <div className="flex flex-wrap items-center gap-4 border-b border-ink p-3.5">
          <Eyebrow className={err ? 'text-[var(--danger)]' : 'text-vermilion'}>
            ● {err ? 'down' : 'live'}
          </Eyebrow>
          <span className="caption">refresh · 2s</span>
          {data?.llm?.budget?.enabled ? <BudgetMeter budget={data.llm.budget} /> : null}
          <span className="ml-auto flex gap-2">
            <Btn sm onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Btn>
          </span>
        </div>
        <div className="strip-mobile grid grid-cols-5">
          <HealthCell
            label="Icecast"
            status={data?.icecast && !data.icecast.error ? 'ok' : err ? 'down' : 'idle'}
            v={fmtListeners(data?.icecast)}
            sub={data?.icecast?.peakListeners != null ? `peak ${data.icecast.peakListeners}` : '—'}
          />
          <HealthCell
            label="Liquidsoap"
            status={data?.liquidsoapLog ? 'ok' : err ? 'down' : 'idle'}
            v={data?.liquidsoapLog ? 'up' : '—'}
            sub="log last 100"
          />
          <HealthCell
            label="LLM"
            status={data?.llm ? 'ok' : 'idle'}
            v={data?.llm?.activeModel || '—'}
            sub={data?.llm?.provider ? `provider ${data.llm.provider}` : '—'}
          />
          <HealthCell
            label="Picker"
            status={data?.queue?.current ? 'ok' : 'idle'}
            v={data?.queue?.current ? 'request' : 'auto-playlist'}
            sub={`upcoming ${data?.queue?.upcoming?.length ?? 0}`}
          />
          <HealthCell
            label="Tagger"
            status={data?.library?.total ? 'ok' : 'off'}
            v={data?.library?.total ? `${data.library.total} tracks` : '—'}
            sub={data?.library?.updatedAt ? new Date(data.library.updatedAt).toLocaleDateString('en-GB') : 'not tagged'}
          />
        </div>
      </section>

      {err && <ErrorState error={err} />}

      {!data && !err && (
        <Card title="Debug">
          <SkeletonRows rows={6} />
        </Card>
      )}

      {data && (
        <>
          {/* ── ROW 1 — NOW PLAYING / ICECAST / DJ CONTEXT ──────────────── */}
          <div className="stack-mobile grid grid-cols-3 gap-4">
            <Card
              title="Now playing"
              headClass="flex-nowrap"
              sub={
                <span className="text-[9px] tracking-[0.08em] normal-case">
                  now-playing.json
                </span>
              }
            >
              <ScrollArea className="max-h-80">
                <KvTable obj={data.nowPlaying} />
              </ScrollArea>
            </Card>

            <Card title="Icecast">
              <ScrollArea className="max-h-80">
                <KvTable obj={data.icecast as unknown as Record<string, unknown>} />
              </ScrollArea>
            </Card>

            <Card title="DJ context">
              <ScrollArea className="max-h-[200px]">
                <DjContext ctx={data.context} />
              </ScrollArea>
            </Card>
          </div>

          {/* ── CONFIG + LISTEN MOUNTS ──────────────────────────── */}
          <Card title="Config" sub="redacted · listen mounts">
            <ScrollArea className="max-h-[480px]">
              <KvTable obj={data.config} />
              <MountsTable mounts={data.mounts} />
            </ScrollArea>
          </Card>

          {/* ── TTS ROUTING ────────────────────────────── */}
          {data.tts && !data.tts.error && (
            <Card
              title="TTS routing"
              sub={`who voices the next spoken segment · ${data.tts.recentCalls?.length ?? 0} recent calls`}
            >
              <TtsRouting tts={data.tts} />
            </Card>
          )}

          {/* ── LLM RECENT CALLS ───────────────────────────── */}
          <LlmCalls llm={data.llm} />

          {/* ── SUBSONIC API CALLS ─────────────────────────── */}
          <SubsonicCalls subsonic={data.subsonic} />

          {/* ── LIQUIDSOAP LOG ─────────────────────────────── */}
          <Card
            title="Liquidsoap log"
            sub="last 100 lines"
            className="flex h-[440px] flex-col"
            bodyClass="flex flex-1 flex-col min-h-0"
            right={
              <Label className="flex cursor-pointer items-center gap-1.5 text-[10px] tracking-[0.18em] text-muted uppercase">
                <Checkbox
                  checked={autoScroll}
                  onCheckedChange={v => setAutoScroll(v === true)}
                />
                auto-scroll
              </Label>
            }
          >
            {/* Terminal owns scrolling + tail-follow; the Card checkbox drives
                its autoScroll. Square corners to sit flush in the card body. */}
            <Terminal
              output={data.liquidsoapLog || '— no log —'}
              autoScroll={autoScroll}
              className="min-h-0 flex-1 rounded-none border-separator-strong"
            >
              <TerminalContent className="max-h-none min-h-0 flex-1 p-2.5 text-[11px] leading-[1.6]" />
            </Terminal>
          </Card>

          {/* ── ROW 3 ───────────────────────────────────────── */}
          <div className="stack-mobile grid grid-cols-2 gap-4">
            <Card title="State dir" sub="/var/sub-wave">
              <ScrollArea className="max-h-80">
                <FilesTable files={data.stateFiles} />
              </ScrollArea>
            </Card>

            <Card
              title="DJ voice WAVs"
              sub={`${Array.isArray(data.voiceFiles) ? data.voiceFiles.length : 0} files`}
            >
              <ScrollArea className="max-h-80">
                <FilesTable files={data.voiceFiles} />
              </ScrollArea>
            </Card>
          </div>

          {/* ── QUEUE ──────────────────────── */}
          <div className="stack-mobile grid grid-cols-[1fr_1.2fr] gap-4">
            <Card title="Queue" sub="current served request">
              {data.queue?.current ? (
                <KvTable obj={data.queue.current} />
              ) : (
                <span className="field-hint italic">none (auto-playlist)</span>
              )}
            </Card>

            <Card title="Upcoming queue" sub={`${data.queue?.upcoming?.length ?? 0} tracks`}>
              {(data.queue?.upcoming?.length ?? 0) === 0 ? (
                <span className="field-hint italic">queue empty</span>
              ) : (
                <ScrollArea className="max-h-80">
                  {data.queue?.upcoming?.map((t, i) => (
                    <div key={i} className="track-row grid grid-cols-[24px_1fr_auto]">
                      <span className="idx">{i + 1}</span>
                      <span className="title">
                        {t.title} <span className="artist">— {t.artist}</span>
                      </span>
                      {t.requestedBy ? (
                        <Pill tone="accent">↳ {t.requestedBy}</Pill>
                      ) : (
                        <span />
                      )}
                    </div>
                  ))}
                </ScrollArea>
              )}
            </Card>
          </div>

          {/* ── DJ SESSION ─────────────── */}
          {data.session && !data.session.error && (
            <Card
              title="DJ session"
              sub={
                `${data.session.kind}` +
                (data.session.show ? ` · ${data.session.show.name}` : '') +
                (data.session.persona ? ` · ${data.session.persona.name}` : '') +
                ` · ${data.session.messages?.length ?? 0} turns`
              }
            >
              <SessionChat session={data.session} />
            </Card>
          )}

          {/* ── DJ LOG ─────────────────────────────────────── */}
          <Card title="DJ log" sub={`${data.queue?.djLogCount} total · last 30${data.timezone ? ` · times in ${data.timezone}` : ''}`}>
            <ScrollArea className="max-h-72">
              <div className="grid gap-1">
                <AnimatePresence initial={false} mode="popLayout">
                  {(data.queue?.djLog || []).map(e => (
                    <m.div
                      key={e.id}
                      layout
                      initial={{ opacity: 0, y: -8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.14, ease: [0.2, 0.7, 0.2, 1] }}
                      className={`log ${kindTone(e.kind)}`}
                    >
                      <span className="t">
                        {fmtClock(e.t, data.timezone, data.locale) || '—'}
                      </span>
                      <span className="k">[{e.kind}]</span>
                      <span className="msg">{e.message}</span>
                    </m.div>
                  ))}
                </AnimatePresence>
              </div>
            </ScrollArea>
          </Card>
        </>
      )}
    </div>
  );
}

// Daily token budget meter (health-strip header). The ai-elements Context
// ring shows today's spend against the cap on hover; the Pill mirrors the
// controller's budgetMode() tier. No modelId/cost — self-hosted models have
// no USD price. Renders nothing unless the cap is switched on.
function BudgetMeter({ budget }: { budget: DebugBudget }) {
  const cap = budget.cap ?? 0;
  const used = budget.usedToday ?? 0;
  if (!budget.enabled || cap <= 0) return null;
  const mode = budget.mode || 'normal';
  const compact = (n: number) =>
    new Intl.NumberFormat('en-US', { notation: 'compact' }).format(n);
  const pct = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(used / cap);
  return (
    <span className="flex items-center gap-1.5">
      <span className="caption">tokens</span>
      <Context maxTokens={cap} usedTokens={used}>
        <ContextTrigger className="h-auto gap-1 rounded-none px-1.5 py-0.5 text-[11px]" />
        {/* bg-bg (opaque): --overlay is translucent and lets the strip below
            bleed through a floating card. */}
        <ContextContent align="start" className="rounded-none border-ink bg-bg">
          {/* Custom header children: the stock header's Progress bar paints
              bg-muted, which is a text colour in this theme, not a surface. */}
          <ContextContentHeader>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span>{pct} of daily cap</span>
              <span className="mono-num text-muted">
                {compact(used)} / {compact(cap)}
              </span>
            </div>
          </ContextContentHeader>
          <ContextContentBody className="grid gap-1.5">
            <BudgetRow label="used today" value={used.toLocaleString('en-US')} />
            <BudgetRow
              label="remaining"
              value={(budget.remaining ?? Math.max(0, cap - used)).toLocaleString('en-US')}
            />
            <BudgetRow
              label="soft threshold"
              value={budget.softPct != null ? `${budget.softPct}%` : '—'}
            />
            <BudgetRow label="requests exempt" value={budget.exemptRequests ? 'yes' : 'no'} />
          </ContextContentBody>
        </ContextContent>
      </Context>
      <Pill
        tone={mode === 'soft' ? 'accent' : undefined}
        className={mode === 'hard' ? 'border-[var(--danger)] text-[var(--danger)]' : undefined}
        title={
          mode === 'hard'
            ? 'cap reached — no model calls until the UTC day rolls'
            : mode === 'soft'
              ? 'soft threshold reached — cheap picker, optional segments muted'
              : 'under budget'
        }
      >
        budget {mode}
      </Pill>
    </span>
  );
}

function BudgetRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="caption">{label}</span>
      <span className="mono-num">{value}</span>
    </div>
  );
}

function TtsRouting({ tts }: { tts: DebugTts }) {
  const s = tts.spoken || {};
  const fellBack = !!s.fellBack;
  const voiceLabel = s.voice
    ? (s.provider ? `${s.provider} / ${s.voice}` : s.voice)
    : null;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="caption">persona</span>
        <span className="text-[13px] font-bold">{tts.effectivePersona?.name || '—'}</span>
        <span className="caption ml-2">engine</span>
        <Pill
          tone={fellBack ? undefined : 'accent'}
          className={fellBack ? 'border-[var(--danger)] text-[var(--danger)]' : undefined}
        >
          {s.engine || '—'}
        </Pill>
        {voiceLabel && <Pill>{voiceLabel}</Pill>}
        {fellBack && (
          <span className="caption text-[var(--danger)]">
            requested {s.requested} · fell back
          </span>
        )}
        <span className="caption ml-auto">
          jingle · {tts.jingle?.engine || '—'}
        </span>
      </div>
      {fellBack && (
        <V3Alert tone="error" title={`Cloud voice unavailable, speaking via ${s.engine}`}>
          This persona is set to <strong>{s.requested}</strong> TTS, but it isn’t usable
          (switched off, or the provider’s API key is missing). Spoken segments are coming
          out of <strong>{s.engine}</strong> instead. Fix it in Settings → TTS voice.
        </V3Alert>
      )}
      <TtsCallList calls={tts.recentCalls || []} />
    </div>
  );
}

// Per-call TTS log — the raw speak() ring from the controller, rendered with
// the same expandable-row pattern as the LLM / Subsonic call lists. A row in
// danger tone means the call failed outright; an "↳ from <engine>" note means
// the segment still aired but not through the engine the persona asked for.
function TtsCallList({ calls }: { calls: TtsCall[] }) {
  const [filter, setFilter] = useState('all');
  const kinds = Array.from(new Set(calls.map(c => c.kind).filter(Boolean) as string[]));
  const shown = filter === 'all' ? calls : calls.filter(c => c.kind === filter);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <span className="caption mr-1">recent calls</span>
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          all {calls.length}
        </FilterChip>
        {kinds.map(k => (
          <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)}>
            {k} {calls.filter(c => c.kind === k).length}
          </FilterChip>
        ))}
      </div>
      <ScrollArea className="max-h-[420px]">
        <div className="grid gap-1.5">
        {shown.length === 0 && (
          <span className="field-hint text-muted">
            {calls.length === 0 ? 'No spoken segments yet' : 'No calls match this filter'}
          </span>
        )}
        {shown.map((c, i) => (
          <details key={i} className="border border-separator-strong">
            <summary className="grid cursor-pointer grid-cols-[auto_auto_1fr_auto_auto] items-center gap-2.5 px-2.5 py-2">
              <span className={cn('font-bold', c.ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
                {c.ok ? '✓' : '✗'}
              </span>
              <span className="grid leading-tight">
                <span className="text-[12px] font-bold">{c.kind}</span>
                <span className={cn('text-[10px]', c.fellBack ? 'text-[var(--danger)]' : 'text-muted')}>
                  {c.engine}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {c.fellBack && (
                  <span className="caption flex-none text-[var(--danger)]">↳ from {c.requested}</span>
                )}
                <span className="min-w-0 overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted">
                  {oneLine(c.text)}
                </span>
              </span>
              <span className="mono-num text-[11px] text-muted">{c.ms}ms</span>
              <span className="mono-num text-[10px] text-muted">
                {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
              </span>
            </summary>
            <div className="grid gap-1 px-2.5 pt-1 pb-2.5">
              <div className="caption text-[9px]">
                {c.persona ? `${c.persona} · ` : ''}{c.chars ?? 0} chars
                {c.fellBack ? ` · requested ${c.requested}, spoke via ${c.engine}` : ''}
              </div>
              {c.error && (
                <CallSection label="error" tone="err" preview={oneLine(c.error)}>
                  {c.error}
                </CallSection>
              )}
              {c.text && (
                <CallSection label="spoken text" preview={oneLine(c.text)}>
                  {c.text}
                </CallSection>
              )}
            </div>
          </details>
        ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// Session roles are station-specific (dj / track / segment / listener…) — only
// user/assistant map straight through; everything else renders as "system"
// with the original role·kind kept visible as a label chip.
function mapChatRole(role?: string): 'user' | 'assistant' | 'system' {
  return role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system';
}

function SessionChat({ session }: { session: DebugSession }) {
  const msgs = session.messages || [];
  return (
    // StickToBottom's inner scroll element is height:100%, so it needs a
    // definite outer height to scroll — but a fixed 360px box around two
    // turns is dead space. Short sessions size to content; long ones get the
    // fixed, latest-turn-pinned scroll region.
    <Conversation className={cn('w-full', msgs.length > 6 ? 'h-[360px]' : 'h-auto')}>
      <ConversationContent className="gap-1.5 p-0">
        {session.handoff && (
          <div className="caption italic">
            ↪ continuing from {session.handoff}
          </div>
        )}
        {msgs.length === 0 && (
          <span className="field-hint italic">no turns yet</span>
        )}
        {msgs.map((m, i) => (
          <Message key={i} from={mapChatRole(m.role)} className="max-w-full gap-0.5">
            <span className="flex items-baseline gap-2">
              <span className="mono-num text-[10px] text-muted">
                {m.t ? new Date(m.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
              </span>
              <span
                className={cn(
                  'text-[9px] tracking-[0.12em] uppercase',
                  m.role === 'dj' || m.role === 'segment'
                    ? 'text-vermilion'
                    : m.role === 'track'
                      ? 'text-ink'
                      : 'text-muted',
                )}
              >
                {m.role}{m.kind ? `·${m.kind}` : ''}
              </span>
            </span>
            <MessageContent className="rounded-none text-[12px] group-[.is-user]:rounded-none group-[.is-user]:bg-[var(--overlay)] group-[.is-user]:px-2.5 group-[.is-user]:py-1.5 group-[.is-user]:text-ink">
              {/* Speech scripts — plain text, never markdown (MessageResponse
                  would eat asterisks and underscores). */}
              <div className="break-words whitespace-pre-wrap">{m.text}</div>
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
    </Conversation>
  );
}

function HealthCell({ label, status, v, sub }: { label: string; status: 'ok' | 'idle' | 'off' | 'down'; v: ReactNode; sub: ReactNode }) {
  const tone =
    status === 'ok' ? 'bg-vermilion'
      : status === 'idle' || status === 'off' ? 'bg-muted'
        : 'bg-[var(--danger)]';
  return (
    // min-w-0 lets the 1fr strip column shrink below the value's min-content
    // width, so an unbroken token (openrouter:openai/gpt-5-mini) wraps via
    // break-words instead of spilling into the neighbouring cell.
    <div className="grid min-w-0 gap-0.5 border-l border-separator-strong px-3.5 py-3">
      <div className="flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', tone)} />
        <span className="caption">{label}</span>
      </div>
      <div className="min-w-0 text-[13px] leading-snug font-bold break-words">{v}</div>
      <div className="caption text-[9px]">{sub}</div>
    </div>
  );
}

function KvTable({ obj }: { obj: Record<string, unknown> | null | undefined }) {
  if (!obj || (typeof obj === 'object' && Object.keys(obj).length === 0)) {
    return <span className="field-hint italic">—</span>;
  }
  return (
    <dl className="kv">
      {Object.entries(obj).map(([k, val]) => (
        <KvRow key={k} k={k} val={val} />
      ))}
    </dl>
  );
}

function KvRow({ k, val }: { k: string; val: unknown }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {val === null || val === undefined ? (
          <span className="text-muted italic">null</span>
        ) : typeof val === 'object' ? (
          <pre className="m-0 font-[inherit] text-[11px] break-words whitespace-pre-wrap">
            {JSON.stringify(val, null, 2)}
          </pre>
        ) : (
          String(val)
        )}
      </dd>
    </>
  );
}

// Per-mount status chip: green when Icecast has a live source, red when the
// mount is enabled in settings but no source is attached (encoder didn't
// connect / needs a mixer restart), muted when intentionally disabled.
function MountStatus({ m }: { m: DebugMount }) {
  const [label, color] = m.live
    ? ['live', 'text-emerald-500']
    : m.configured
      ? ['down', 'text-red-500']
      : ['off', 'text-muted'];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${color}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

// Listen-mounts block folded into the Config card: per-mount config-vs-live
// health plus the one-paste tune-in URLs.
function MountsTable({ mounts }: { mounts?: DebugMounts }) {
  if (!mounts) return null;
  return (
    <div className="mt-4 grid gap-3">
      <div className="grid gap-1.5">
        <div className="field-hint tracking-wide uppercase">Listen mounts</div>
        {mounts.list.map(m => (
          <div key={m.path} className="flex items-center justify-between gap-3 text-[12px]">
            <span className="flex items-center gap-2">
              <MountStatus m={m} />
              <span className="font-medium">{m.codec}</span>
              <code className="text-[11px] text-muted">{m.path}</code>
            </span>
            <span className="text-right text-[11px] text-muted">
              {m.live
                ? `${m.bitrate ? `${m.bitrate} kbps` : m.codec === 'FLAC' ? 'lossless' : '—'} · ${
                    m.listeners ?? 0
                  } ${m.listeners === 1 ? 'listener' : 'listeners'}${
                    m.sampleRate ? ` · ${(m.sampleRate / 1000).toFixed(1)}k` : ''
                  }`
                : m.configured
                  ? 'enabled · no source (restart mixer?)'
                  : 'disabled'}
            </span>
          </div>
        ))}
      </div>
      <div className="grid gap-1">
        <div className="field-hint tracking-wide uppercase">
          Tune-in files · {mounts.tuneIn.entryCount}{' '}
          {mounts.tuneIn.entryCount === 1 ? 'mount' : 'mounts'}
        </div>
        <code className="text-[11px] break-all text-muted">{mounts.tuneIn.pls}</code>
        <code className="text-[11px] break-all text-muted">{mounts.tuneIn.m3u}</code>
      </div>
    </div>
  );
}

// Slugs like "early-morning" / "drive-time" → "Early morning".
function titleize(s: unknown): string {
  const t = String(s ?? '').replace(/[-_]/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// The DJ context snapshot, rendered as labelled prose rather than raw JSON.
function DjContext({ ctx }: { ctx?: DebugContext | null }) {
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
        titleize(weather.condition),
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

function FilesTable({ files }: { files: FilesValue }) {
  if (!files || (typeof files === 'object' && !Array.isArray(files) && 'error' in files)) {
    return (
      <span className="field-hint italic">
        {(files && typeof files === 'object' && 'error' in files && files.error) || 'no files'}
      </span>
    );
  }
  if (!Array.isArray(files) || files.length === 0) {
    return <span className="field-hint italic">empty</span>;
  }
  return (
    <div className="grid gap-0">
      {files.map((f, i) => (
        <div
          key={f.name}
          className={cn(
            'grid grid-cols-[1fr_auto_auto] gap-2.5 py-1.5 text-[11px]',
            i < files.length - 1 && 'border-b border-dashed border-separator-strong',
          )}
        >
          <span className={cn('break-all', f.isDir ? 'text-vermilion' : 'text-ink')}>
            {f.isDir ? '📁 ' : ''}{f.name}
          </span>
          <span className="mono-num text-muted">{fmtSize(f.size)}</span>
          <span className="mono-num text-muted">
            {f.mtime ? new Date(f.mtime).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function oneLine(s: unknown, n = 110): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Structured-output responses and JSON user payloads (pickNextTrack,
// generateSegment, matchRequest…) are stored as compact JSON strings —
// pretty-print them for the expanded view. Free text and truncated JSON
// (older ring entries capped mid-string) fall through unchanged.
function prettyMaybeJson(s: string): string {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return s;
  }
}

// Dense newsprint-tuned CodeBlock: shiki-highlighted JSON with a copy button.
// Only ever rendered inside an OPEN CallSection / ToolContent, so collapsed
// rows never pay the tokenization cost (see CallSection's open-state gate).
function JsonBlock({ value }: { value: unknown }) {
  const code = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  return (
    <CodeBlock
      code={code}
      language="json"
      className="rounded-none border-separator-strong [&_code]:text-[11px] [&_pre]:p-2.5 [&_pre]:text-[11px]"
    >
      <CodeBlockCopyButton className="absolute top-1 right-1 z-10 size-6" />
    </CodeBlock>
  );
}

// Body text for a call section: JSON payloads get a highlighted CodeBlock
// with copy, prose renders as-is.
function JsonOrText({ text }: { text: string }) {
  const pretty = prettyMaybeJson(text);
  return pretty !== text ? <JsonBlock value={pretty} /> : <>{text}</>;
}

interface CallSectionProps {
  label: string;
  count?: number;
  preview?: ReactNode;
  tone?: 'err';
  children?: ReactNode;
}

function CallSection({ label, count, preview, tone, children }: CallSectionProps) {
  // Children of a closed <details> still MOUNT — and with a 120-entry ring
  // whose bodies now hold shiki CodeBlocks, eager mounting would tokenize
  // every collapsed row. Mirror the element's open state and only mount the
  // body once the section is actually expanded.
  const [open, setOpen] = useState(false);
  return (
    <details
      className="border border-separator-strong bg-bg"
      onToggle={e => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-baseline gap-2 px-2 py-1">
        <span className={cn('caption flex-none', tone === 'err' && 'text-[var(--danger)]')}>
          {label}{count != null ? ` · ${count}` : ''}
        </span>
        {preview && (
          <span className="min-w-0 overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted">
            {preview}
          </span>
        )}
      </summary>
      <div
        className={cn(
          'px-2.5 pt-1.5 pb-2.5 text-[11px] break-words whitespace-pre-wrap',
          tone === 'err' ? 'text-[var(--danger)]' : 'text-ink',
        )}
      >
        {open ? children : null}
      </div>
    </details>
  );
}

function MessageList({ messages }: { messages: Array<{ role?: string; content?: unknown }> }) {
  return (
    // Same auto-vs-fixed height dance as SessionChat: short exchanges size to
    // content, agent runs (~40 turns) get a bounded, bottom-pinned scroll.
    <Conversation className={cn('w-full', messages.length > 4 ? 'h-80' : 'h-auto')}>
      <ConversationContent className="gap-2 p-0">
        {messages.map((m, i) => (
          <Message key={i} from={mapChatRole(m.role)} className="max-w-full gap-0.5">
            <span
              className={cn(
                'text-[9px] tracking-[0.12em] uppercase',
                m.role === 'assistant' ? 'text-vermilion' : 'text-muted',
              )}
            >
              {m.role || 'system'}
            </span>
            <MessageContent className="rounded-none text-[11px] group-[.is-user]:rounded-none group-[.is-user]:bg-[var(--overlay)] group-[.is-user]:px-2.5 group-[.is-user]:py-1.5 group-[.is-user]:text-ink">
              {typeof m.content === 'string' ? (
                <div className="break-words whitespace-pre-wrap">{m.content}</div>
              ) : (
                <JsonBlock value={m.content} />
              )}
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
    </Conversation>
  );
}

// The LLM ring stores tool calls only after they've run — there's no per-tool
// status flag, so a result object carrying an `error` key is the failure
// signal; everything else completed.
function toolErrorText(result: unknown): string | undefined {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) {
    const e = (result as { error?: unknown }).error;
    if (e != null && e !== false && e !== '') {
      return typeof e === 'string' ? e : JSON.stringify(e);
    }
  }
  return undefined;
}

function ToolList({ calls }: { calls: Array<{ name?: string; args?: unknown; result?: unknown }> }) {
  return (
    <div className="grid gap-1">
      {calls.map((t, i) => {
        const err = toolErrorText(t.result);
        return (
          <Tool
            key={i}
            className="mb-0 w-full rounded-none border-separator-strong bg-[var(--card-bg)]"
          >
            <ToolHeader
              // Completed calls from a log: success → output-available,
              // failure → output-error. ToolUIPart types are `tool-${name}`.
              type={`tool-${t.name || 'unknown'}` as `tool-${string}`}
              state={err ? 'output-error' : 'output-available'}
              className="px-2.5 py-1.5"
            />
            <ToolContent className="space-y-2 p-2.5">
              <ToolInput input={t.args ?? {}} />
              <ToolOutput output={err ? undefined : t.result} errorText={err} />
            </ToolContent>
          </Tool>
        );
      })}
    </div>
  );
}

interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  children?: ReactNode;
}

function FilterChip({ active, onClick, children }: FilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'cursor-pointer border border-separator-strong px-2 py-0.5 text-[10px] tracking-[0.08em] uppercase',
        active ? 'bg-vermilion text-bg' : 'bg-transparent text-muted',
      )}
    >
      {children}
    </button>
  );
}

function LlmCalls({ llm }: { llm: DebugLlm | undefined }) {
  const { adminFetch } = useAdminAuth();
  const calls = llm?.recentCalls || [];
  const [filter, setFilter] = useState('all');
  const kinds = Array.from(new Set(calls.map(c => c.kind).filter(Boolean) as string[]));
  const shown = filter === 'all' ? calls : calls.filter(c => c.kind === filter);

  const dbg = llm?.debug;
  const viaEnv = !!dbg?.viaEnv;
  // Optimistic local view so the checkbox responds instantly; the 2s /debug poll
  // reconciles it. Cleared whenever the server-reported value changes (below).
  const [override, setOverride] = useState<boolean | null>(null);
  const enabled = override ?? !!dbg?.enabled;
  useEffect(() => { setOverride(null); }, [dbg?.enabled]);

  const toggleRaw = async (next: boolean) => {
    if (viaEnv) return; // LLM_DEBUG_RAW forces it on — can't change from here
    setOverride(next);
    try {
      await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: { debugRawRequests: next } }),
      });
    } catch {
      setOverride(null);
    }
  };

  return (
    <Card
      title="LLM recent calls"
      sub={`${calls.length} calls · ${llm?.provider || '—'} / ${llm?.activeModel || '—'}`}
      right={
        <div className="flex flex-wrap justify-end gap-1">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
            all {calls.length}
          </FilterChip>
          {kinds.map(k => (
            <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)}>
              {k} {calls.filter(c => c.kind === k).length}
            </FilterChip>
          ))}
        </div>
      }
    >
      {/* Raw-request capture — writes the last N exact request bodies to a file
          operators can open. Toggle here, or set LLM_DEBUG_RAW in the env. */}
      <div className="mb-2 grid gap-1 border border-separator-strong p-2.5">
        <Label className="flex cursor-pointer items-center gap-2 text-[11px] tracking-[0.12em] text-muted uppercase">
          <Checkbox
            checked={enabled}
            disabled={viaEnv}
            onCheckedChange={v => toggleRaw(v === true)}
          />
          Raw request capture {enabled ? 'on' : 'off'}
          {viaEnv && <span className="normal-case">· forced on by LLM_DEBUG_RAW</span>}
        </Label>
        <span className="field-hint">
          last {dbg?.max ?? 10} raw request bodies (newest first) →{' '}
          <code className="break-all">{dbg?.file || `${'…'}/logs/llm-debug.log`}</code>
        </span>
      </div>
      <ScrollArea className="max-h-[600px]">
        <div className="grid gap-1.5">
          {shown.length === 0 && (
            <span className="field-hint text-muted">
              {calls.length === 0 ? 'No calls yet' : 'No calls match this filter'}
            </span>
          )}
          {shown.map((c, i) => (
            <details
              key={i}
              className={cn(
                'border border-separator-strong',
                i === 0 && filter === 'all' ? 'bg-[var(--ink-softer)]' : 'bg-transparent',
              )}
            >
              <summary className="grid cursor-pointer grid-cols-[auto_1fr_auto_auto_auto] items-center gap-2.5 px-2.5 py-2">
                <span className={cn('font-bold', c.ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
                  {c.ok ? '✓' : '✗'}
                </span>
                <span className="text-[12px] font-bold">{c.kind}</span>
                <span className="caption text-[10px]">
                  {c.toolCalls?.length ? `🔧 ${c.toolCalls.length}` : ''}
                  {c.steps != null ? `${c.toolCalls?.length ? ' · ' : ''}${c.steps} steps` : ''}
                </span>
                <span className="mono-num text-[11px] text-muted">{c.ms}ms</span>
                <span className="mono-num text-[10px] text-muted">
                  {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
                </span>
              </summary>
              <div className="grid gap-1 px-2.5 pt-1 pb-2.5">
                <div className="caption text-[9px]">
                  {c.model || '—'}{c.via ? ` · ${c.via}` : ''}
                </div>
                {c.error && (
                  <CallSection label="error" tone="err" preview={oneLine(c.error)}>
                    {c.error}
                  </CallSection>
                )}
                {c.responseText && (
                  <CallSection label="model said instead" tone="err" preview={oneLine(c.responseText)}>
                    {/* Free text straight from the model — may contain
                        markdown, so this is the one MessageResponse call. */}
                    <MessageResponse className="whitespace-normal">
                      {c.responseText}
                    </MessageResponse>
                  </CallSection>
                )}
                {c.user && (
                  <CallSection label="user" preview={oneLine(c.user)}>
                    <JsonOrText text={c.user} />
                  </CallSection>
                )}
                {(c.system || c.systemPreview) && (
                  <CallSection label="system" preview={oneLine(c.system || c.systemPreview)}>
                    {c.system || `${c.systemPreview}…`}
                  </CallSection>
                )}
                {Array.isArray(c.messages) && c.messages.length > 0 && (
                  <CallSection
                    label="messages"
                    count={c.messages.length}
                    preview={oneLine(c.messages[c.messages.length - 1]?.content)}
                  >
                    <MessageList messages={c.messages} />
                  </CallSection>
                )}
                {Array.isArray(c.toolCalls) && c.toolCalls.length > 0 && (
                  <CallSection
                    label="tools"
                    count={c.toolCalls.length}
                    preview={c.toolCalls.map(t => t.name).join(' → ')}
                  >
                    <ToolList calls={c.toolCalls} />
                  </CallSection>
                )}
                {c.response && (
                  <CallSection label="response" preview={oneLine(c.response)}>
                    <JsonOrText text={c.response} />
                  </CallSection>
                )}
              </div>
            </details>
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
}

function SubsonicCalls({ subsonic }: { subsonic: DebugSubsonic | undefined }) {
  const { adminFetch } = useAdminAuth();
  const [filter, setFilter] = useState('all');
  const [resetting, setResetting] = useState(false);

  if (!subsonic || subsonic.error) {
    return (
      <Card title="Subsonic API calls">
        <span className="field-hint text-muted">
          {subsonic?.error || 'No data yet'}
        </span>
      </Card>
    );
  }

  const calls = subsonic.recentCalls || [];
  const endpoints = subsonic.endpoints || [];
  const totalCalls = endpoints.reduce((s, e) => s + e.calls, 0);
  const shown = filter === 'all' ? calls : calls.filter(c => c.endpoint === filter);

  const reset = async () => {
    setResetting(true);
    try { await adminFetch('/debug/subsonic/reset', { method: 'POST' }); } catch {}
    setResetting(false);
  };

  return (
    <Card
      title="Subsonic API calls"
      sub={`${calls.length} recent · ${totalCalls} total`}
      right={
        <Btn sm onClick={reset} disabled={resetting}>
          {resetting ? 'Resetting…' : 'Reset'}
        </Btn>
      }
    >
      <div className="grid gap-4">
        <div>
          <div className="mb-1.5 flex flex-wrap gap-1">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              all {calls.length}
            </FilterChip>
            {endpoints.map(e => (
              <FilterChip
                key={e.endpoint}
                active={filter === e.endpoint}
                onClick={() => setFilter(e.endpoint)}
              >
                {e.endpoint} {calls.filter(c => c.endpoint === e.endpoint).length}
              </FilterChip>
            ))}
          </div>
          <ScrollArea className="max-h-[480px]">
            <div className="grid gap-1.5">
              {shown.length === 0 && (
                <span className="field-hint text-muted">
                  {calls.length === 0 ? 'No calls yet' : 'No calls match this filter'}
                </span>
              )}
              {shown.map((c, i) => (
                <details key={i} className="border border-separator-strong">
                  <summary className="grid cursor-pointer grid-cols-[auto_1fr_auto_auto_auto] items-center gap-2.5 px-2.5 py-2">
                    <span className={cn('font-bold', c.ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
                      {c.ok ? '✓' : '✗'}
                    </span>
                    <span className="text-[12px] font-bold">{c.endpoint}</span>
                    <span className="caption text-[10px]">{c.count} results</span>
                    <span className="mono-num text-[11px] text-muted">{c.ms}ms</span>
                    <span className="mono-num text-[10px] text-muted">
                      {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
                    </span>
                  </summary>
                  <div className="grid gap-1 px-2.5 pt-1 pb-2.5">
                    {c.error && (
                      <CallSection label="error" tone="err" preview={oneLine(c.error)}>
                        {c.error}
                      </CallSection>
                    )}
                    <CallSection label="params" preview={oneLine(JSON.stringify(c.params || {}))}>
                      <JsonBlock value={c.params || {}} />
                    </CallSection>
                    {Array.isArray(c.songIds) && c.songIds.length > 0 && (
                      <CallSection
                        label="songs"
                        count={c.songIds.length}
                        preview={c.songIds.map(s => `${s.title} — ${s.artist}`).join(' · ')}
                      >
                        {c.songIds.map(s => `${s.title} — ${s.artist}`).join('\n')}
                      </CallSection>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </Card>
  );
}

function fmtListeners(icecast: DebugIcecast | undefined): string {
  if (!icecast || icecast.error) return '—';
  if (icecast.listeners != null) return `${icecast.listeners} listeners`;
  return 'up';
}

function kindTone(k?: string): string {
  switch (k) {
    case 'error':
    case 'miss':
      return 'danger';
    case 'queued':
    case 'scheduler':
      return 'muted';
    default:
      return 'accent';
  }
}
