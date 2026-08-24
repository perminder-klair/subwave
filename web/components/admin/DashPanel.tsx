'use client';

// DJ command center — /admin/dash. Speak custom text on air, fire voice segments,
// flip the autonomous toggles, watch live status + the booth log.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAdminAuth } from '../../lib/adminAuth';
import { useAdminMutation, useAdminQuery } from '../../lib/admin-query';
import { notify, errorMessage } from '../../lib/notify';
import { turnClass, turnKey } from '../../lib/sessionFeed';
import { fmtClock } from '../../lib/format';
import { clientLabel, fmtConnected } from '../../lib/clientLabel';
import type { QueueEntry } from '../../lib/types';
import { V3AlertDialog } from '../ui/alert-dialog';
import { SkeletonText } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { Card, Btn, Pill, Seg } from './ui';
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
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
import { Message, MessageContent } from '../ai-elements/message';
import type { ChatStatus } from 'ai';
import { ScrollArea, ScrollBar } from '../ui/scroll-area';
import { RefreshCw, X } from 'lucide-react';
import StationHeader, { type HealthMetrics } from './StationHeader';
import { cn } from '../../lib/cn';
import { RequestsCard } from './dash/RequestsCard';
import { TakeoverCard } from './dash/TakeoverCard';
import QueueHeldBadge from './dash/QueueHeldBadge';
import { BoothTurnText, SegmentButton, SortableTh, ToggleRow, classTone } from './dash/bits';
import type {
  ActResponse,
  ConnectionsState,
  DashStatus,
  HealthStats,
  QueueState,
  RequestEntry,
  SortState,
} from './dash/types';
import {
  BANTER_SEGMENT,
  SAY_KINDS,
  SAY_MODES,
  SAY_SUGGESTIONS,
  SEGMENTS,
  maskIp,
  sortConnections,
} from './dash/types';
import {
  dashKeys,
  fetchConnections,
  fetchDashStatus,
  fetchHealthStats,
  fetchRequests,
  fetchSuggestions,
  runDashAction,
} from './dash/queries';

// Listeners-table header cells. `sticky top-0` resolves against the ScrollArea
// viewport, and the opaque card-bg stops rows showing through underneath. The
// rule is an inset shadow, not `border-b`: under border-collapse (Tailwind
// preflight) the border belongs to the table, so it stays behind while the cell
// scrolls away.
const STICKY_TH =
  'sticky top-0 z-[1] bg-[var(--card-bg)] shadow-[inset_0_-1px_0_var(--separator-strong)]';

export default function DashPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const [sayText, setSayText] = useState('');
  const [sayMode, setSayMode] = useState('raw');
  const [sayKind, setSayKind] = useState('dj-speak');
  // Drives the PromptInputSubmit glyph: ready → submitted → error flash → ready.
  const [sayStatus, setSayStatus] = useState<ChatStatus>('ready');
  const [confirmSkip, setConfirmSkip] = useState(false);

  // Hardcoded set until the controller has a generated batch. The GET on mount
  // never calls a model; the ↻ button's POST does.
  // Longest-connected first by default — the most stable listeners on top.
  const [sort, setSort] = useState<SortState>({ key: 'connectedSeconds', dir: 'desc' });
  const [revealIps, setRevealIps] = useState(false);

  const ready = hydrated && !needsAuth;
  const statusQuery = useAdminQuery<DashStatus>({
    key: dashKeys.status(), adminFetch, enabled: ready, staleTime: 0,
    refetchInterval: () => 3_000,
    request: fetchDashStatus,
  });
  // Polled slower than status because it hits Icecast's admin interface.
  const connectionsQuery = useAdminQuery<ConnectionsState>({
    key: dashKeys.connections(), adminFetch, enabled: ready, staleTime: 0,
    refetchInterval: () => 10_000,
    request: fetchConnections,
  });
  // A miss freezes the health meters rather than erroring the dash.
  const statsQuery = useAdminQuery<HealthStats>({
    key: dashKeys.stats(), adminFetch, enabled: ready, staleTime: 0,
    refetchInterval: () => 15_000,
    request: fetchHealthStats,
  });
  // A review surface, not a live ticker — keep the existing 10s cadence.
  const requestsQuery = useAdminQuery<RequestEntry[]>({
    key: dashKeys.requests(), adminFetch, enabled: ready, staleTime: 0,
    refetchInterval: () => 10_000,
    request: fetchRequests,
  });
  const suggestionsQuery = useAdminQuery<string[] | null>({
    key: dashKeys.suggestions(), adminFetch, enabled: ready,
    request: fetchSuggestions,
  });

  const status = statusQuery.data ?? null;
  const err = statusQuery.error ? errorMessage(statusQuery.error) : null;
  const conns = connectionsQuery.data ?? null;
  const connErr = connectionsQuery.error ? errorMessage(connectionsQuery.error) : null;
  const stats = statsQuery.data ?? null;
  const requests = requestsQuery.data ?? null;
  const reqErr = requestsQuery.error ? errorMessage(requestsQuery.error) : null;
  const saySuggestions = suggestionsQuery.data ?? SAY_SUGGESTIONS;

  const refreshSuggestionsMutation = useAdminMutation<{ suggestions?: string[] }, void>({
    adminFetch,
    toastOnError: false,
    request: async (_vars, fetcher) => {
      const response = await fetcher('/generate/say-suggestions', { method: 'POST' });
      const body = await response.json().catch(() => null) as
        | { suggestions?: string[]; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error || `failed (${response.status})`);
      return body ?? {};
    },
    onDone: (data, _vars, client) => {
      if (Array.isArray(data.suggestions) && data.suggestions.length) {
        client.setQueryData(dashKeys.suggestions(), data.suggestions);
      }
    },
  });

  // Asks the station LLM for a fresh batch; failure leaves the current chips.
  const refreshSuggestions = async () => {
    try {
      await refreshSuggestionsMutation.mutateAsync();
    } catch (e) {
      notify.err(`new prompts: ${errorMessage(e)}`);
    }
  };

  interface DashAction {
    path: string;
    body: Record<string, unknown> | null;
  }
  const actionMutation = useAdminMutation<ActResponse, DashAction>({
    adminFetch,
    toastOnError: false,
    request: ({ path, body }, fetcher) => runDashAction(fetcher, path, body),
    onDone: (_data, _vars, client) => client.invalidateQueries({ queryKey: dashKeys.status() }),
  });

  const act = async (
    key: string,
    path: string,
    body: Record<string, unknown> | null,
    label: string,
  ): Promise<ActResponse | null> => {
    setBusy(key);
    try {
      const j = await actionMutation.mutateAsync({ path, body });
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
      // act() already toasted the message; the text stays for a retry.
      setSayStatus('error');
      window.setTimeout(() => setSayStatus('ready'), 1500);
    }
  };

  // Guards empty text and double-submits (Enter while a send is in flight).
  const onSaySubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || busy) return;
    void sendVoice(text);
  };

  // Runs only after the confirm dialog — a skip cuts the track for every listener.
  const doSkip = () => act('skip', '/dj/skip', {}, 'skip track');

  // No confirm: nothing on-air changes, worst case a 409 because the track went
  // on air first. The row drops optimistically; the poll confirms.
  const cancelQueueItem = useAdminMutation<ActResponse, string>({
    adminFetch,
    toastOnError: false,
    request: async (id, fetcher) => {
      const response = await fetcher(`/dj/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const body = await response.json().catch(() => ({})) as ActResponse;
      if (!response.ok) throw new Error(body.error || `failed (${response.status})`);
      return body;
    },
    onDone: async (_data, _id, client) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: dashKeys.status() }),
        client.invalidateQueries({ queryKey: dashKeys.requests() }),
      ]);
    },
  });

  const cancelQueued = async (t: QueueEntry) => {
    const id = typeof t.subsonic_id === 'string' ? t.subsonic_id : '';
    if (!id) return;
    setBusy(`cancel:${id}`);
    await queryClient.cancelQueries(
      { queryKey: dashKeys.status(), exact: true },
      { silent: true },
    );
    queryClient.setQueryData<DashStatus>(dashKeys.status(), current => current
      ? {
          ...current,
          queue: {
            ...(current.queue || {}),
            upcoming: (current.queue?.upcoming || []).filter(item => item.subsonic_id !== id),
          },
        }
      : current);
    try {
      await cancelQueueItem.mutateAsync(id);
      notify.ok(`removed from queue: ${t.title || 'track'}`);
    } catch (e) {
      // A 409 usually means the row crossed the live boundary. Never restore
      // the old full envelope over a newer poll; ask both owners for truth.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashKeys.status() }),
        queryClient.invalidateQueries({ queryKey: dashKeys.requests() }),
      ]);
      notify.err(`cancel: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const np = status?.nowPlaying;
  const ctx = status?.context;
  // On-air timestamps render in the station zone so they match what the DJ
  // speaks, not the operator's browser timezone (issue #418).
  const tz = status?.timezone;
  const locale = status?.locale;
  const q: QueueState = status?.queue || {};
  const listenersValue = status?.listeners;
  const listenersObj = listenersValue && typeof listenersValue === 'object' ? listenersValue : null;
  const upcoming = q.upcoming || [];
  const history = q.history || [];
  // The controller publishes a label only after the incoming item has drained
  // and its transition flags are final. Never reconstruct it from raw queue
  // flags here: an unsent proposal can still be vetoed or replaced.
  const nextTransition = q.nextTransition ?? '—';
  // Under pair-aware drain the first upcoming item is held unsent for most of
  // each track, so the em dash is the NORMAL reading rather than a fault — say
  // so, or it reads as a broken panel. The armed tooltip names the pair the
  // label describes: this is the seam out of the on-air track, not out of the
  // queue row it sits above.
  const nextTransitionHint = q.nextTransition
    ? 'How the on-air track hands over to the first queued track'
    : 'Not armed yet — the seam is decided when the next track is handed to the mixer';
  // `sessionMessages` arrives in air order and is shown newest first. Each turn
  // carries its ORIGINAL index: turnKey() folds the index into the React key, and
  // a display index would shift under every new turn, remounting the whole list.
  const booth = status?.sessionMessages || [];
  const boothNewestFirst = booth.map((turn, i) => ({ turn, i })).reverse();

  const showName = status?.activeShow?.name || ctx?.time?.show || '—';
  const weatherText = ctx?.weather?.condition
    ? `${ctx.weather.condition}${ctx.weather.temp != null ? ` ${Math.round(ctx.weather.temp)}°` : ''}`
    : '—';

  // A meter with no data yet (stats not loaded, or zero calls since boot) is
  // passed null so the strip shows "—" rather than a misleading zero.
  const lCurrent =
    listenersObj?.current ?? (typeof listenersValue === 'number' ? listenersValue : 0);
  const lPeak = listenersObj?.peak ?? lCurrent;
  const healthMetrics: HealthMetrics = {
    listeners: lCurrent,
    listenersPeak: lPeak,
    latencyMs: stats?.llm?.count ? (stats.llm.latency?.p95 ?? null) : null,
    // Redline at the DJ-agent deadline so the gauge tracks the model in use, not
    // a fixed ceiling. Null until /stats loads → StationHeader's default scale.
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

      {err && <ErrorState error={err} />}

      <div className="stack-mobile grid grid-cols-[1.4fr_1fr] gap-4">
        <div className="grid grid-rows-[auto_1fr] gap-4">
          <Card
            title="Queue"
            sub={`${upcoming.length} upcoming`}
            right={
              <span
                title={nextTransitionHint}
                className="text-[9px] font-bold tracking-[0.18em] text-muted uppercase"
              >
                Next transition: <span className="text-ink">{nextTransition}</span>
              </span>
            }
            bodyClass="px-3.5 py-1.5"
          >
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
                        {/* `stemSeam` rides the successor, so keep its definitive
                            marker on that row even while the header describes
                            the earlier current → first-upcoming transition. Text
                            makes the meaning explicit without the old opaque icon. */}
                        {t.stemSeam ? (
                          <span
                            title="Arrives via a rendered blend mixed from cached stems"
                            className="shrink-0 text-[8px] font-bold tracking-[0.14em] whitespace-nowrap text-vermilion/80 uppercase"
                          >
                            Stem blend
                          </span>
                        ) : null}
                        <QueueHeldBadge sent={t.sent} />
                        <span className="mono-num text-[10px] whitespace-nowrap text-muted">
                          {typeof t.duration === 'number' || typeof t.duration === 'string'
                            ? t.duration
                            : ''}
                        </span>
                        {/* Per-track cancel (#1006). */}
                        {typeof t.subsonic_id === 'string' && t.subsonic_id ? (
                          <QueueItemActions className="opacity-100">
                            <QueueItemAction
                              onClick={() => cancelQueued(t)}
                              disabled={busy === `cancel:${t.subsonic_id}`}
                              title="Remove from queue"
                              aria-label={`Remove ${t.title || 'track'} from queue`}
                              className="size-5 rounded-none text-muted hover:bg-vermilion/10 hover:text-vermilion"
                            >
                              <X className="h-3 w-3" />
                            </QueueItemAction>
                          </QueueItemActions>
                        ) : null}
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

              {history.length > 0 && (
                <QueueSection defaultOpen={false} className="border-t border-separator-strong">
                  <QueueSectionTrigger className="min-h-9 rounded-none bg-transparent px-1.5 py-2 text-[9px] font-bold tracking-[0.2em] text-muted uppercase hover:bg-[var(--overlay)] hover:text-ink sm:min-h-0">
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
                {/* The absolute-inset wrapper keeps the log out of the card's
                    intrinsic height, so the card tracks the right column instead
                    of growing to fit every turn. The scroller stays anchored at
                    the TOP: newest first means turns prepend, so scrollTop 0
                    keeps showing the newest turn on its own. */}
                <div className="absolute inset-0">
                  <div
                    className="h-full overflow-y-auto"
                    role="log"
                    aria-live="polite"
                  >
                    <div className="flex flex-col gap-2 pr-2">
                      {boothNewestFirst.map(({ turn, i }) => (
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
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="grid gap-4">
          <Card title="Manual voice DJ" sub="speak now">
            {/* Chips fill the textarea, never send, and flip the box to Styled —
                they are directions for the DJ, and raw would air the instruction. */}
            <div className="mb-2.5 flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <Suggestions className="gap-1.5">
                  {saySuggestions.map(s => (
                    <Suggestion
                      key={s}
                      suggestion={s}
                      onClick={text => {
                        setSayText(text);
                        setSayMode('styled');
                      }}
                      // min-h-9 is a thumb-sized target on a phone; sm: drops
                      // back to the dense desktop pill.
                      className="h-auto min-h-9 rounded-none border-separator-strong px-3 py-[3px] text-[9px] font-medium tracking-[0.04em] text-muted normal-case hover:bg-[var(--overlay)] hover:text-ink sm:min-h-0 sm:px-2"
                    />
                  ))}
                </Suggestions>
              </div>
              <button
                type="button"
                onClick={refreshSuggestions}
                disabled={refreshSuggestionsMutation.isPending}
                title="New prompts — written by the station LLM for right now"
                aria-label="Generate new prompts"
                className="shrink-0 border border-separator-strong p-3 text-muted transition-colors hover:bg-[var(--overlay)] hover:text-ink disabled:pointer-events-none disabled:opacity-60 sm:p-[5px]"
              >
                <RefreshCw className={cn('h-3 w-3', refreshSuggestionsMutation.isPending && 'animate-spin')} />
              </button>
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
              {/* Two rows (controls, then a full-width send bar): on the ~550px
                  column a single flex-wrap row broke unpredictably, leaving the
                  button dangling under empty space. */}
              <PromptInputFooter className="flex-col items-stretch gap-2.5">
                <PromptInputTools className="flex-wrap items-center gap-x-5 gap-y-2">
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
                  className="w-full rounded-none px-3"
                >
                  {/* No children while in flight / erroring, so the status glyphs
                      take over from the label. */}
                  {sayStatus === 'ready' ? 'Send to air →' : undefined}
                </PromptInputSubmit>
              </PromptInputFooter>
            </PromptInput>
          </Card>

          <Card title="DJ segments" sub="fire on demand">
            {/* 2-up on a phone so each pad keeps a full-width label, and a 4th
                "banter" pad squares off rather than dangling. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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

          <TakeoverCard tz={tz} locale={locale} />

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

      <Card
        title="Listeners"
        sub={conns ? `${conns.count} connected` : 'live connections'}
        right={
          connErr ? (
            <Pill>unavailable</Pill>
          ) : conns && conns.connections.length > 0 ? (
            <button
              type="button"
              className="inline-flex min-h-9 items-center text-[9px] font-bold tracking-[0.2em] text-muted uppercase hover:text-ink sm:min-h-0"
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
          <SkeletonText lines={2} />
        ) : conns.connections.length === 0 ? (
          <div className="text-muted italic">nobody listening right now</div>
        ) : (
          /* Capped like the other admin lists so a busy station's connection list
             scrolls inside the card instead of stretching the dash down the page. */
          <ScrollArea className="max-h-[360px]">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[9px] tracking-[0.2em] text-muted uppercase">
                  <SortableTh
                    label="IP"
                    col="ip"
                    sort={sort}
                    onSort={setSort}
                    className={STICKY_TH + ' pr-3'}
                  />
                  {/* Mount is dropped on a phone; the other three fit 390px
                      without a sideways scroll. */}
                  <SortableTh
                    label="Mount"
                    col="mount"
                    sort={sort}
                    onSort={setSort}
                    className={STICKY_TH + ' hidden pr-3 sm:table-cell'}
                  />
                  <SortableTh
                    label="Connected"
                    col="connectedSeconds"
                    sort={sort}
                    onSort={setSort}
                    className={STICKY_TH + ' pr-3'}
                  />
                  <SortableTh
                    label="Client"
                    col="client"
                    sort={sort}
                    onSort={setSort}
                    className={STICKY_TH}
                  />
                </tr>
              </thead>
              <tbody>
                {sortConnections(conns.connections, sort).map((c, i) => (
                  <tr
                    key={`${c.ip}:${c.mount}:${i}`}
                    // The sticky header already draws a solid rule, so the top
                    // row's dashed border would double it.
                    className="border-t border-dashed border-separator-strong first:border-t-0"
                  >
                    <td className="py-1.5 pr-3 font-mono whitespace-nowrap" title={c.ip}>
                      {revealIps ? c.ip || '—' : maskIp(c.ip)}
                    </td>
                    <td className="hidden py-1.5 pr-3 whitespace-nowrap text-muted sm:table-cell">
                      {c.mount}
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {fmtConnected(c.connectedSeconds)}
                    </td>
                    <td className="max-w-[150px] truncate py-1.5 sm:max-w-[360px]" title={c.userAgent}>
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
