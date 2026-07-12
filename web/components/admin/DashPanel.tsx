'use client';

// DJ command center — /admin/dash. Lets the operator step into the autonomous
// booth: speak custom text on-air, fire any voice segment on demand,
// flip the autonomous toggles, and watch live on-air status + the booth log.
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { eventTurnSummary, turnClass, turnKey, turnText } from '../../lib/sessionFeed';
import { fmtClock } from '../../lib/format';
import type { SessionTurn } from '../../lib/types';
import type {
  NowPlayingTrack,
  StationContext,
  ActiveShow,
  DjState,
  ListenerCount,
  QueueEntry,
  StationLocale,
} from '../../lib/types';
import { V3AlertDialog } from '../ui/alert-dialog';
import { V3Alert } from '../ui/alert';
import { Card, Btn, Pill, Seg, Toggle } from './ui';
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from '../ai-elements/queue';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '../ai-elements/prompt-input';
import { Suggestion, Suggestions } from '../ai-elements/suggestion';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '../ai-elements/conversation';
import { Message, MessageContent } from '../ai-elements/message';
import type { ChatStatus } from 'ai';
import { ScrollArea, ScrollBar } from '../ui/scroll-area';
import { AudioLines, Clock3, MessagesSquare, RadioTower, type LucideIcon } from 'lucide-react';
import StationHeader, { type HealthMetrics } from './StationHeader';
import { cn } from '../../lib/cn';

const SAY_KINDS = [
  { id: 'dj-speak', label: 'Solo' },
  { id: 'link', label: 'Over' },
];
const SAY_MODES = [
  { id: 'raw', label: 'Raw' },
  { id: 'styled', label: 'Styled' },
];

// Canned prompts for the manual voice box, in station voice. Written as
// instructions (they shine with mode=styled — the DJ rewrites them in persona,
// though raw works too). Clicking one FILLS the textarea; nothing goes to air
// until the operator hits send.
const SAY_SUGGESTIONS = [
  'Tease the weather like it’s a rumour you can’t quite confirm.',
  'Do a station ID like you suspect nobody’s listening — and you’re fine with it.',
  'Salute the graveyard shift: night drivers, dish pits, the deliberately awake.',
  'Tease the next track without giving up the title.',
  'Remind everyone the request line exists and judges no one.',
  'Announce the time like it’s classified information.',
];

type SegmentType = 'station-id' | 'hourly' | 'link' | 'banter';
const SEGMENTS: { type: SegmentType; label: string; icon: LucideIcon }[] = [
  { type: 'station-id', label: 'Station ID', icon: RadioTower },
  { type: 'hourly', label: 'Time check', icon: Clock3 },
  { type: 'link', label: 'Track link', icon: AudioLines },
];
// Only offered while a show with guest co-hosts is on air — a one-person
// "exchange" is a 400 from the controller anyway.
const BANTER_SEGMENT: { type: SegmentType; label: string; icon: LucideIcon } =
  { type: 'banter', label: 'Banter', icon: MessagesSquare };

interface QueueState {
  upcoming?: QueueEntry[];
  history?: QueueEntry[];
  autoPick?: boolean;
  autoLink?: boolean;
  pickerBusy?: boolean;
}

interface DashStatus {
  nowPlaying?: NowPlayingTrack | null;
  context?: StationContext | null;
  dj?: DjState | null;
  listeners?: ListenerCount | number | null;
  streamOnline?: boolean;
  streamBitrate?: number | null;
  activeShow?: ActiveShow | null;
  queue?: QueueState;
  sessionMessages?: SessionTurn[];
  /** Station IANA zone — render on-air timestamps in it (issue #418). */
  timezone?: string;
  locale?: StationLocale;
}

// Subset of /stats (admin) the health strip reads: DJ p95 latency + the TTS
// fallback rate, both since-boot rollups. Polled slower than live status since
// they move slowly and the endpoint is heavier.
interface HealthStats {
  llm?: { count?: number; latency?: { p95?: number }; agentTimeoutMs?: number };
  tts?: { count?: number; fallbackRate?: number | null };
}

interface ActResponse {
  ok?: boolean;
  spoken?: string;
  error?: string;
}

interface ListenerConnection {
  ip: string;
  mount: string;
  userAgent: string;
  connectedSeconds: number;
  // Raw sockets folded into this row. Safari opens 2 per client (counts as one
  // listener); >1 surfaces as a ×N badge. Absent/1 for normal single-socket clients.
  connections?: number;
}

interface ConnectionsState {
  count: number;
  connections: ListenerConnection[];
}

// One resolved/failed listener request, as returned by GET /requests. Mirrors
// the durable record written by the controller's request-log.
interface RequestEntry {
  t?: string;
  requester?: string;
  text?: string;
  status?: string;
  ms?: number | null;
  path?: string | null;
  pickSource?: string | null;
  intent?: string | null;
  mood?: string | null;
  scope?: string | null;
  sort?: string | null;
  artist?: string | null;
  genre?: string | null;
  language?: string | null;
  searchTerms?: string[] | null;
  track?: { title?: string; artist?: string; id?: string } | null;
  ack?: string | null;
  introScript?: string | null;
  message?: string | null;
}

// connectedSeconds → short human string. Listeners rarely sit for days, so
// hours is the coarsest unit we bother with.
function fmtConnected(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Hide the host portion of an IP so a glance at the screen doesn't expose a
// listener's full address. IPv4 drops the last octet, IPv6 keeps the first two
// groups (the routing prefix) and masks the rest. The raw IP is still in the
// row's title attribute and one toggle away — this is a display default, not
// redaction.
function maskIp(ip: string): string {
  if (!ip) return '—';
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.×');
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean);
    return groups.length > 2 ? `${groups[0]}:${groups[1]}:×` : ip;
  }
  return ip;
}

// Collapse a raw user-agent into a short "Device · App" label. Best-effort and
// deliberately shallow — the full UA stays in the title attribute. Order
// matters: check the specific players (Sonos, VLC) before the generic browser
// families, since some embed "Mozilla" boilerplate.
function clientLabel(ua: string): string {
  if (!ua) return 'unknown';
  const u = ua.toLowerCase();
  if (u.includes('sonos')) return 'Sonos';
  if (u.includes('vlc')) return 'VLC';
  if (u.includes('itunes') || u.includes('applecoremedia')) return 'iTunes / Music';
  if (u.includes('winamp')) return 'Winamp';
  if (u.includes('foobar')) return 'foobar2000';
  const device = u.includes('iphone')
    ? 'iPhone'
    : u.includes('ipad')
      ? 'iPad'
      : u.includes('android')
        ? 'Android'
        : u.includes('macintosh') || u.includes('mac os')
          ? 'Mac'
          : u.includes('windows')
            ? 'Windows'
            : u.includes('linux')
              ? 'Linux'
              : '';
  const browser = u.includes('firefox')
    ? 'Firefox'
    : u.includes('edg')
      ? 'Edge'
      : u.includes('chrome') || u.includes('chromium')
        ? 'Chrome'
        : u.includes('safari')
          ? 'Safari'
          : '';
  const label = [device, browser].filter(Boolean).join(' · ');
  // Nothing recognised — show the first token of the raw UA rather than a
  // useless "unknown" (helps with hardware radios / odd clients).
  return label || ua.split(/[\s/]/)[0] || 'unknown';
}

type SortKey = 'ip' | 'mount' | 'connectedSeconds' | 'client';
interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

// Sort connections by the active column. `client` sorts on the friendly label
// (what the operator actually sees), everything else on the raw field.
function sortConnections(
  rows: ListenerConnection[],
  { key, dir }: SortState,
): ListenerConnection[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp: number;
    if (key === 'connectedSeconds') cmp = a.connectedSeconds - b.connectedSeconds;
    else if (key === 'client') cmp = clientLabel(a.userAgent).localeCompare(clientLabel(b.userAgent));
    else cmp = String(a[key]).localeCompare(String(b[key]));
    return cmp * sign;
  });
}

export default function DashPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [status, setStatus] = useState<DashStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [sayText, setSayText] = useState('');
  const [sayMode, setSayMode] = useState('raw');
  const [sayKind, setSayKind] = useState('dj-speak');
  // POST lifecycle for the PromptInputSubmit glyph: ready → submitted while
  // the /dj/say call is in flight → a brief error flash on failure → ready.
  const [sayStatus, setSayStatus] = useState<ChatStatus>('ready');
  const [confirmSkip, setConfirmSkip] = useState(false);

  const [conns, setConns] = useState<ConnectionsState | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [stats, setStats] = useState<HealthStats | null>(null);
  const [requests, setRequests] = useState<RequestEntry[] | null>(null);
  const [reqErr, setReqErr] = useState<string | null>(null);
  // Longest-connected first by default — the most stable listeners on top.
  const [sort, setSort] = useState<SortState>({ key: 'connectedSeconds', dir: 'desc' });
  const [revealIps, setRevealIps] = useState(false);

  // Live status — poll /now-playing + /state together every 3s.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [npR, stR, seR] = await Promise.all([
          adminFetch('/now-playing'),
          adminFetch('/state'),
          adminFetch('/session'),
        ]);
        if (cancelled) return;
        const np = (await npR.json().catch(() => null)) as Partial<DashStatus> | null;
        const st = (await stR.json().catch(() => null)) as QueueState | null;
        const se = (await seR.json().catch(() => null)) as { messages?: SessionTurn[] } | null;
        setStatus({
          ...(np || {}),
          queue: st || {},
          sessionMessages: se?.messages || [],
        });
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hydrated, needsAuth, adminFetch]);

  // Live listener connections — polled slower than status (10s) since it hits
  // Icecast's admin interface, and the table doesn't need 3s freshness.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await adminFetch('/listeners/connections');
        const j = (await r.json().catch(() => null)) as
          | (ConnectionsState & { error?: string })
          | null;
        if (cancelled) return;
        if (!r.ok) throw new Error(j?.error || `failed (${r.status})`);
        setConns({ count: j?.count ?? 0, connections: j?.connections ?? [] });
        setConnErr(null);
      } catch (e) {
        if (!cancelled) setConnErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hydrated, needsAuth, adminFetch]);

  // Usage rollups for the health strip (DJ latency + TTS fallback) — polled
  // every 15s. /stats is heavier than live status and both figures move slowly,
  // so it gets its own slower cadence. Soft-fails: a miss just freezes the two
  // meters at their last reading rather than erroring the dash.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await adminFetch('/stats');
        const j = (await r.json().catch(() => null)) as HealthStats | null;
        if (!cancelled && r.ok && j) setStats(j);
      } catch {
        /* leave last reading in place */
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hydrated, needsAuth, adminFetch]);

  // Recent listener requests + how the DJ resolved each — admin-gated, durable
  // across restarts. Polled at the slower 10s cadence; this is a review surface,
  // not a live ticker.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await adminFetch('/requests');
        const j = (await r.json().catch(() => null)) as
          | { requests?: RequestEntry[]; error?: string }
          | null;
        if (cancelled) return;
        if (!r.ok) throw new Error(j?.error || `failed (${r.status})`);
        setRequests(j?.requests ?? []);
        setReqErr(null);
      } catch (e) {
        if (!cancelled) setReqErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hydrated, needsAuth, adminFetch]);

  // Generic POST helper — drives the busy state; result goes to the toast.
  const act = async (
    key: string,
    path: string,
    body: Record<string, unknown> | null,
    label: string,
  ): Promise<ActResponse | null> => {
    setBusy(key);
    try {
      const r = await adminFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const j = (await r.json().catch(() => ({}))) as ActResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(j.spoken ? `on air: “${j.spoken}”` : `${label} done`);
      return j;
    } catch (e) {
      notify.err(`${label}: ${errorMessage(e)}`);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const sendVoice = async (text: string) => {
    setSayStatus('submitted');
    const j = await act('say', '/dj/say', { text, mode: sayMode, kind: sayKind }, 'manual voice');
    if (j?.ok) {
      setSayText('');
      setSayStatus('ready');
    } else {
      // Brief error flash on the submit glyph, then back to ready. The toast
      // from act() carries the actual message; the text stays for a retry.
      setSayStatus('error');
      window.setTimeout(() => setSayStatus('ready'), 1500);
    }
  };

  // PromptInput hands us { text, files }; only text matters here. Guard empty
  // text and double-submits (Enter while a send is already in flight).
  const onSaySubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    void sendVoice(text);
  };

  // Skip is disruptive — it cuts the track for every listener — so the Skip
  // button opens a confirm dialog; this runs only after the operator accepts.
  const doSkip = () => act('skip', '/dj/skip', {}, 'skip track');

  const np = status?.nowPlaying;
  const ctx = status?.context;
  // Station zone — on-air timestamps render in it so they match what the DJ
  // speaks, regardless of the operator's own browser timezone (issue #418).
  const tz = status?.timezone;
  const locale = status?.locale;
  const q: QueueState = status?.queue || {};
  const listenersValue = status?.listeners;
  const listenersObj = listenersValue && typeof listenersValue === 'object' ? listenersValue : null;
  const upcoming = q.upcoming || [];
  const history = q.history || [];
  // Booth log is the live DJ session in air order — oldest first, newest at
  // the bottom, where the Conversation's stick-to-bottom tail holds the view.
  // (The controller's djLog ring buffer is operator diagnostics — it lives on
  // /admin/debug only.)
  const booth = status?.sessionMessages || [];

  const showName = status?.activeShow?.name || ctx?.time?.show || '—';
  const weatherText = ctx?.weather?.condition
    ? `${ctx.weather.condition}${ctx.weather.temp != null ? ` ${Math.round(ctx.weather.temp)}°` : ''}`
    : '—';

  // Inputs for the top-of-dash health strip. Listeners/queue/online come from
  // the 3s live poll; latency + TTS-fallback from the 15s /stats poll. A meter
  // with no data yet (stats not loaded, or zero calls since boot) is passed
  // null so the strip shows "—" rather than a misleading zero.
  const lCurrent =
    listenersObj?.current ?? (typeof listenersValue === 'number' ? listenersValue : 0);
  const lPeak = listenersObj?.peak ?? lCurrent;
  const healthMetrics: HealthMetrics = {
    listeners: lCurrent,
    listenersPeak: lPeak,
    latencyMs: stats?.llm?.count ? (stats.llm.latency?.p95 ?? null) : null,
    // Redline at the DJ-agent deadline (the fallback threshold), so the gauge
    // tracks the model in use instead of a fixed ceiling. Null until /stats
    // loads → StationHeader falls back to its built-in default scale.
    latencyDeadlineMs: stats?.llm?.agentTimeoutMs ?? null,
    ttsFallbackPct: stats?.tts?.count ? Math.round((stats.tts.fallbackRate ?? 0) * 1000) / 10 : null,
    online: status?.streamOnline ?? null,
    bitrateKbps: status?.streamBitrate ?? null,
  };

  const djName =
    status?.dj && typeof status.dj === 'object' && 'name' in status.dj
      ? String((status.dj as { name?: unknown }).name ?? '—')
      : '—';

  return (
    <div className="grid gap-4">
      {/* ── STATION HEADER: now-playing + unified health/status strip ───── */}
      <StationHeader
        metrics={healthMetrics}
        np={np}
        djName={djName}
        showName={showName}
        weatherText={weatherText}
        pickerBusy={!!q.pickerBusy}
        busy={busy}
        onSkip={() => setConfirmSkip(true)}
      />

      {err && (
        <V3Alert tone="error" title="controller error">
          {err}
        </V3Alert>
      )}

      {/* ── 2-COL OPS ──────────────────────────────────────────────────── */}
      <div className="stack-mobile grid grid-cols-[1.4fr_1fr] gap-4">
        {/* LEFT */}
        <div className="grid grid-rows-[auto_1fr] gap-4">
          <Card title="Queue" sub={`${upcoming.length} upcoming`} bodyClass="px-3.5 py-1.5">
            {/* The Card supplies the newsprint chrome; the Queue's own border/
                radius/shadow are stripped so it reads as the card body. */}
            <Queue className="rounded-none border-0 bg-transparent p-0 shadow-none">
              {upcoming.length === 0 ? (
                <div className="py-1 text-muted italic">queue empty, auto-playlist fallback</div>
              ) : (
                // --queue-max-h lifts the vendored max-h-40 so all 8 rows show.
                <QueueList className="mt-0 -mb-0 [--queue-max-h:26rem]">
                  {upcoming.slice(0, 8).map((t, i) => (
                    <QueueItem
                      key={`${t.subsonic_id ?? ''}:${i}`}
                      className="rounded-none border-b border-dashed border-separator-strong px-1.5 py-1.5 last:border-b-0 hover:bg-[var(--overlay)]"
                    >
                      <div className="flex items-center gap-2.5">
                        <QueueItemIndicator
                          className={cn(
                            'mt-0 rounded-none',
                            t.requestedBy
                              ? 'border-vermilion bg-vermilion'
                              : 'border-ink/40 bg-transparent',
                          )}
                        />
                        <span className="mono-num text-[10px] text-muted">
                          {(i + 1).toString().padStart(2, '0')}
                        </span>
                        <QueueItemContent className="text-[12px] text-ink">
                          {t.title} <span className="text-muted">— {t.artist}</span>
                        </QueueItemContent>
                        <span className="mono-num text-[10px] whitespace-nowrap text-muted">
                          {typeof t.duration === 'number' || typeof t.duration === 'string'
                            ? t.duration
                            : ''}
                        </span>
                      </div>
                      {t.requestedBy ? (
                        <QueueItemDescription className="ml-10 text-[9px] font-bold tracking-[0.2em] text-vermilion uppercase">
                          ↳ {t.requestedBy}
                        </QueueItemDescription>
                      ) : null}
                    </QueueItem>
                  ))}
                </QueueList>
              )}

              {/* Recently played — collapsed by default; a review surface,
                  not part of the live queue read. */}
              {history.length > 0 && (
                <QueueSection defaultOpen={false} className="border-t border-separator-strong">
                  <QueueSectionTrigger className="rounded-none bg-transparent px-1.5 py-2 text-[9px] font-bold tracking-[0.2em] text-muted uppercase hover:bg-[var(--overlay)] hover:text-ink">
                    <QueueSectionLabel
                      count={history.length}
                      label="recently played"
                      className="[&_svg]:size-3"
                    />
                  </QueueSectionTrigger>
                  <QueueSectionContent>
                    <QueueList className="mt-0">
                      {history.slice(0, 8).map((t, i) => (
                        <QueueItem
                          key={`${t.subsonic_id ?? ''}:${t.t ?? ''}:${i}`}
                          className="rounded-none px-1.5 py-1 hover:bg-[var(--overlay)]"
                        >
                          <div className="flex items-center gap-2.5">
                            <QueueItemIndicator completed className="mt-0 rounded-none" />
                            <QueueItemContent completed className="text-[12px] no-underline">
                              {t.title} <span className="text-muted">— {t.artist}</span>
                            </QueueItemContent>
                            <span className="mono-num text-[10px] whitespace-nowrap text-muted">
                              {fmtClock(t.t, tz, locale)}
                            </span>
                          </div>
                        </QueueItem>
                      ))}
                    </QueueList>
                  </QueueSectionContent>
                </QueueSection>
              )}
            </Queue>
          </Card>

          <Card
            title="Booth log"
            sub={`${booth.length} session turns${tz ? ` · times in ${tz}` : ''}`}
            className="flex min-h-0 flex-col"
            bodyClass="flex flex-1 flex-col min-h-0"
          >
            {booth.length === 0 ? (
              <div className="text-muted italic">no session turns yet</div>
            ) : (
              <div className="relative min-h-[220px] flex-1">
                {/* The absolute-inset wrapper keeps the log's content out of
                    the card's intrinsic height, so the card tracks the right
                    column instead of growing to fit every session turn. The
                    Conversation (stick-to-bottom) owns the scroll region and
                    holds the view pinned to the newest turn — a live tail. */}
                <div className="absolute inset-0">
                  <Conversation className="h-full">
                    <ConversationContent className="gap-2 p-0 pr-2">
                      {booth.map((turn, i) => (
                        <Message
                          key={turnKey(turn, i)}
                          from="assistant"
                          className="max-w-full gap-0.5"
                        >
                          <MessageContent className="gap-0.5 text-[11px] leading-relaxed">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="mono-num text-[10px] text-muted">
                                {fmtClock(turn.t, tz, locale)}
                              </span>
                              <span
                                className={cn(
                                  'border px-1 py-px text-[8px] font-bold tracking-[0.18em] uppercase',
                                  classTone(turnClass(turn)) === 'accent'
                                    ? 'border-vermilion text-vermilion'
                                    : 'border-separator-strong text-muted',
                                )}
                              >
                                {turn.kind}
                              </span>
                            </div>
                            <BoothTurnText turn={turn} />
                          </MessageContent>
                        </Message>
                      ))}
                    </ConversationContent>
                    <ConversationScrollButton className="rounded-none border-ink" />
                  </Conversation>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* RIGHT */}
        <div className="grid gap-4">
          <Card title="Manual voice DJ" sub="speak now">
            {/* Canned prompt chips — clicking fills the textarea, never sends. */}
            <div className="mb-2.5">
              <Suggestions className="gap-1.5">
                {SAY_SUGGESTIONS.map(s => (
                  <Suggestion
                    key={s}
                    suggestion={s}
                    onClick={setSayText}
                    className="h-auto rounded-none border-separator-strong px-2 py-[3px] text-[9px] font-medium tracking-[0.04em] text-muted normal-case hover:bg-[var(--overlay)] hover:text-ink"
                  />
                ))}
              </Suggestions>
            </div>
            <PromptInput onSubmit={onSaySubmit}>
              <PromptInputBody>
                <PromptInputTextarea
                  className="min-h-[88px] text-[13px]"
                  value={sayText}
                  onChange={e => setSayText(e.target.value)}
                  maxLength={500}
                  placeholder={
                    sayMode === 'raw'
                      ? 'Exact words the DJ will speak, verbatim…'
                      : 'An instruction or topic. The DJ writes it in persona…'
                  }
                />
              </PromptInputBody>
              <PromptInputFooter className="flex-wrap gap-3.5">
                <PromptInputTools className="flex-wrap gap-3.5">
                  <div className="flex items-center gap-1.5">
                    <span className="caption">mode</span>
                    <Seg value={sayMode} options={SAY_MODES} onChange={setSayMode} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="caption">duck</span>
                    <Seg value={sayKind} options={SAY_KINDS} onChange={setSayKind} />
                  </div>
                </PromptInputTools>
                <PromptInputSubmit
                  status={sayStatus}
                  variant="accent"
                  size="sm"
                  disabled={!!busy || !sayText.trim()}
                  className="ml-auto rounded-none px-3"
                >
                  {/* No children while in flight / erroring so the status
                      glyphs (spinner / ✕) take over from the label. */}
                  {sayStatus === 'ready' ? 'Send to air →' : undefined}
                </PromptInputSubmit>
              </PromptInputFooter>
            </PromptInput>
          </Card>

          <Card title="DJ segments" sub="fire on demand">
            <div className="grid grid-cols-3 gap-2">
              {[...SEGMENTS, ...((status?.activeShow?.guests?.length ?? 0) > 0 ? [BANTER_SEGMENT] : [])].map(s => {
                const k = `seg:${s.type}`;
                return (
                  <SegmentButton
                    key={s.type}
                    label={s.label}
                    icon={s.icon}
                    busyHere={busy === k}
                    anyBusy={!!busy}
                    onFire={() => act(k, '/dj/segment', { type: s.type }, s.label)}
                  />
                );
              })}
            </div>
          </Card>

          <Card title="Broadcast">
            <div className="grid gap-2.5">
              <ToggleRow
                label="Auto-pick"
                desc="picks next track when queue runs dry"
                on={!!q.autoPick}
                disabled={!!busy || !status}
                onToggle={() => act('autopick', '/auto-pick', { on: !q.autoPick }, 'auto-pick')}
              />
              <ToggleRow
                label="Auto-link"
                desc="DJ talks between auto-played tracks"
                on={!!q.autoLink}
                disabled={!!busy || !status}
                onToggle={() => act('autolink', '/dj/auto-link', { on: !q.autoLink }, 'auto-link')}
              />
              <div className="flex items-center justify-between border-t border-dashed border-separator-strong pt-2">
                <div>
                  <div className="text-[12px] font-bold">Auto-playlist</div>
                  <div className="text-[10px] text-muted">rebuild liquidsoap fallback</div>
                </div>
                <Btn
                  sm
                  disabled={!!busy}
                  onClick={() =>
                    act('refresh', '/dj/refresh-playlist', {}, 'auto-playlist refresh')
                  }
                >
                  {busy === 'refresh' ? 'firing…' : 'Refresh'}
                </Btn>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* ── LISTENERS ──────────────────────────────────────────────────── */}
      <Card
        title="Listeners"
        sub={conns ? `${conns.count} connected` : 'live connections'}
        right={
          connErr ? (
            <Pill>unavailable</Pill>
          ) : conns && conns.connections.length > 0 ? (
            <button
              type="button"
              className="text-[9px] font-bold tracking-[0.2em] text-muted uppercase hover:text-ink"
              onClick={() => setRevealIps(v => !v)}
            >
              {revealIps ? 'hide IPs' : 'show IPs'}
            </button>
          ) : null
        }
      >
        {connErr ? (
          <div className="text-muted italic">can’t reach Icecast admin: {connErr}</div>
        ) : !conns ? (
          <div className="text-muted italic">loading…</div>
        ) : conns.connections.length === 0 ? (
          <div className="text-muted italic">nobody listening right now</div>
        ) : (
          <ScrollArea>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[9px] tracking-[0.2em] text-muted uppercase">
                  <SortableTh label="IP" col="ip" sort={sort} onSort={setSort} className="pr-3" />
                  <SortableTh label="Mount" col="mount" sort={sort} onSort={setSort} className="pr-3" />
                  <SortableTh
                    label="Connected"
                    col="connectedSeconds"
                    sort={sort}
                    onSort={setSort}
                    className="pr-3"
                  />
                  <SortableTh label="Client" col="client" sort={sort} onSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {sortConnections(conns.connections, sort).map((c, i) => (
                  <tr
                    key={`${c.ip}:${c.mount}:${i}`}
                    className="border-t border-dashed border-separator-strong"
                  >
                    <td className="py-1.5 pr-3 font-mono whitespace-nowrap" title={c.ip}>
                      {revealIps ? c.ip || '—' : maskIp(c.ip)}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted">{c.mount}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {fmtConnected(c.connectedSeconds)}
                    </td>
                    <td className="max-w-[360px] truncate py-1.5" title={c.userAgent}>
                      {clientLabel(c.userAgent)}
                      {c.connections && c.connections > 1 ? (
                        <span
                          className="ml-1.5 text-[10px] font-bold text-muted"
                          title={`${c.connections} connections (Safari opens 2 sockets per listener)`}
                        >
                          ×{c.connections}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        )}
      </Card>

      {/* ── REQUESTS ───────────────────────────────────────────────────── */}
      <RequestsCard requests={requests} err={reqErr} tz={tz} locale={locale} />

      {!status && !err && <div className="text-muted italic">connecting…</div>}

      <V3AlertDialog
        open={confirmSkip}
        onOpenChange={setConfirmSkip}
        title="Skip current track"
        description="Skip the current track for all listeners? Everyone tuned in jumps straight to the next track."
        confirmLabel="skip track"
        danger
        onConfirm={doSkip}
      />
    </div>
  );
}

// A clickable column header. Clicking the active column flips direction;
// clicking a new one selects it (descending for the duration column, ascending
// for the text columns — the order an operator usually wants first).
function SortableTh({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string;
  col: SortKey;
  sort: SortState;
  onSort: (s: SortState) => void;
  className?: string;
}) {
  const active = sort.key === col;
  const arrow = active ? (sort.dir === 'asc' ? '↑' : '↓') : '';
  return (
    <th className={cn('py-1.5 font-bold', className)}>
      <button
        type="button"
        className={cn('uppercase hover:text-ink', active && 'text-ink')}
        onClick={() =>
          onSort(
            active
              ? { key: col, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: col, dir: col === 'connectedSeconds' ? 'desc' : 'asc' },
          )
        }
      >
        {label}
        {arrow ? <span className="ml-1">{arrow}</span> : null}
      </button>
    </th>
  );
}

interface SegmentButtonProps {
  label: string;
  icon: LucideIcon;
  busyHere: boolean;
  anyBusy: boolean;
  onFire: () => void;
}

// A studio cart-machine pad — all visual states live in .seg-pad (globals.css):
// hover arms the LED, .is-firing blinks it and sweeps the base while on air.
function SegmentButton({ label, icon: Icon, busyHere, anyBusy, onFire }: SegmentButtonProps) {
  return (
    <button
      type="button"
      disabled={anyBusy}
      onClick={onFire}
      className={cn('seg-pad', busyHere && 'is-firing')}
    >
      <span className="seg-led" aria-hidden />
      <Icon className="seg-glyph" strokeWidth={1.5} aria-hidden />
      <span className="seg-label">{label}</span>
      <span className="seg-cta">{busyHere ? 'on air' : 'fire'}</span>
    </button>
  );
}

interface ToggleRowProps {
  label: string;
  desc: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

function ToggleRow({ label, desc, on, disabled, onToggle }: ToggleRowProps) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1">
        <div className="text-[12px] font-bold">{label}</div>
        <div className="text-[10px] text-muted">{desc}</div>
      </div>
      <Toggle on={on} disabled={disabled} onClick={onToggle} />
    </div>
  );
}

function classTone(cls: string): string {
  switch (cls) {
    case 'voice':
    case 'track':
      return 'accent';
    default:
      return 'muted';
  }
}

// One booth-log message. Long `event` turns (the pick prompt posted to the DJ
// agent — link/clock/transition coaching) render as a one-line summary; the
// raw prompt never shows here (it's in the session JSON if ever needed).
function BoothTurnText({ turn }: { turn: SessionTurn }) {
  // Plain text, deliberately not markdown-rendered — booth turns are speech
  // scripts, not documents.
  return <span className="break-words text-ink">{eventTurnSummary(turn) ?? turnText(turn)}</span>;
}

// Collapse whitespace + truncate, for the one-line request preview in a summary.
function oneLine(s: unknown, n = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// The Requests card — every listener request and exactly how the AI DJ
// resolved it. Newest first; each row expands to the full debug trace.
function RequestsCard({
  requests,
  err,
  tz,
  locale,
}: {
  requests: RequestEntry[] | null;
  err: string | null;
  tz?: string;
  locale?: StationLocale;
}) {
  return (
    <Card
      title="Requests"
      sub={
        err
          ? 'unavailable'
          : requests
            ? `${requests.length} recent · what listeners asked + how the DJ answered`
            : 'loading…'
      }
    >
      {err ? (
        <div className="text-muted italic">can’t load requests: {err}</div>
      ) : !requests ? (
        <div className="text-muted italic">loading…</div>
      ) : requests.length === 0 ? (
        <div className="text-muted italic">no requests yet</div>
      ) : (
        <ScrollArea className="max-h-[520px]">
          <div className="grid gap-1.5">
            {requests.map((r, i) => (
              <RequestRow key={`${r.t ?? ''}:${i}`} r={r} tz={tz} locale={locale} />
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
}

function RequestRow({ r, tz, locale }: { r: RequestEntry; tz?: string; locale?: StationLocale }) {
  const ok = r.status === 'resolved';
  // Matcher breakdown — only the fields that carry a value, joined compactly.
  const trace = [
    r.intent && `intent ${r.intent}`,
    r.mood && `mood ${r.mood}`,
    r.scope && `scope ${r.scope}`,
    r.sort && `sort ${r.sort}`,
    r.artist && `artist ${r.artist}`,
    r.genre && `genre ${r.genre}`,
    r.language && `lang ${r.language}`,
  ].filter(Boolean) as string[];

  return (
    <details className="border border-separator-strong">
      <summary className="grid cursor-pointer grid-cols-[auto_1fr_auto_auto] items-center gap-2.5 px-2.5 py-2">
        <span className={cn('font-bold', ok ? 'text-vermilion' : 'text-[var(--danger)]')}>
          {ok ? '✓' : '✗'}
        </span>
        <span className="min-w-0 truncate text-[12px]">
          <span className="font-bold">{r.requester || 'anon'}</span>
          <span className="text-muted"> · {oneLine(r.text)}</span>
        </span>
        <span className="caption text-[10px]">{r.ms != null ? `${r.ms}ms` : ''}</span>
        <span className="mono-num text-[10px] text-muted">
          {fmtClock(r.t, tz, locale) || '—'}
        </span>
      </summary>
      <div className="grid gap-2 px-2.5 pt-1 pb-2.5 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          {r.path && <Pill tone="accent">{r.path}</Pill>}
          {r.pickSource && <Pill>{r.pickSource}</Pill>}
        </div>

        {trace.length > 0 && (
          <div className="caption text-[10px]">{trace.join(' · ')}</div>
        )}

        {ok ? (
          <RequestField label="track">
            {r.track?.title ? (
              <span>
                {r.track.title}{' '}
                <span className="text-muted">— {r.track.artist}</span>
              </span>
            ) : (
              <span className="text-muted italic">—</span>
            )}
          </RequestField>
        ) : (
          <RequestField label="failed">
            <span className="text-[var(--danger)]">{r.message || '—'}</span>
          </RequestField>
        )}

        {r.ack && <RequestField label="ack">{r.ack}</RequestField>}
        {r.introScript && (
          <RequestField label="intro">
            <span className="break-words whitespace-pre-wrap">{r.introScript}</span>
          </RequestField>
        )}
      </div>
    </details>
  );
}

function RequestField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[60px_1fr] items-baseline gap-2">
      <span className="caption text-[9px]">{label}</span>
      <span className="break-words">{children}</span>
    </div>
  );
}
