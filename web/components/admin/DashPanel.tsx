'use client';

// DJ command center — /admin/dash. Lets the operator step into the autonomous
// booth: speak custom text on-air, fire any voice segment on demand,
// flip the autonomous toggles, and watch live on-air status + the booth log.
import type { ChangeEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { turnClass, turnKey, turnText } from '../../lib/sessionFeed';
import type { SessionTurn } from '../../lib/types';
import type { NowPlayingTrack, StationContext, ActiveShow, DjState, ListenerCount, QueueEntry } from '../../lib/types';
import { V3AlertDialog } from '../ui/alert-dialog';
import { V3Alert } from '../ui/alert';
import { Textarea } from '../ui/textarea';
import { Card, Btn, Pill, Eyebrow, Seg, Toggle } from './ui';
import { cn } from '../../lib/cn';

const SAY_KINDS = [
  { id: 'dj-speak', label: 'Solo' },
  { id: 'link', label: 'Over' },
];
const SAY_MODES = [
  { id: 'raw', label: 'Raw' },
  { id: 'styled', label: 'Styled' },
];

type SegmentType = 'station-id' | 'hourly' | 'link';
const SEGMENTS: { type: SegmentType; label: string }[] = [
  { type: 'station-id', label: 'Station ID' },
  { type: 'hourly', label: 'Time check' },
  { type: 'link', label: 'Track link' },
];

interface QueueState {
  upcoming?: QueueEntry[];
  autoPick?: boolean;
  autoLink?: boolean;
  pickerBusy?: boolean;
}

interface DashStatus {
  nowPlaying?: NowPlayingTrack | null;
  context?: StationContext | null;
  dj?: DjState | null;
  listeners?: ListenerCount | number | null;
  activeShow?: ActiveShow | null;
  queue?: QueueState;
  sessionMessages?: SessionTurn[];
}

interface ActResponse {
  ok?: boolean;
  spoken?: string;
  error?: string;
}

export default function DashPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [status, setStatus] = useState<DashStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [sayText, setSayText] = useState('');
  const [sayMode, setSayMode] = useState('raw');
  const [sayKind, setSayKind] = useState('dj-speak');
  const [confirmSkip, setConfirmSkip] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [status?.sessionMessages?.length]);

  // Generic POST helper — drives the busy state; result goes to the toast.
  const act = async (key: string, path: string, body: Record<string, unknown> | null, label: string): Promise<ActResponse | null> => {
    setBusy(key);
    try {
      const r = await adminFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const j = (await r.json().catch(() => ({}))) as ActResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(j.spoken ? `on air: “${j.spoken}”` : `${label} — done`);
      return j;
    } catch (e) {
      notify.err(`${label}: ${errorMessage(e)}`);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const sendVoice = async () => {
    const text = sayText.trim();
    if (!text) return;
    const j = await act('say', '/dj/say', { text, mode: sayMode, kind: sayKind }, 'manual voice');
    if (j?.ok) setSayText('');
  };

  // Skip is disruptive — it cuts the track for every listener — so the Skip
  // button opens a confirm dialog; this runs only after the operator accepts.
  const doSkip = () => act('skip', '/dj/skip', {}, 'skip track');

  const np = status?.nowPlaying;
  const ctx = status?.context;
  const q: QueueState = status?.queue || {};
  const listenersValue = status?.listeners;
  const listenersObj = listenersValue && typeof listenersValue === 'object' ? listenersValue : null;
  const upcoming = q.upcoming || [];
  // Booth log is the live DJ session, newest first. (The controller's djLog
  // ring buffer is operator diagnostics — it lives on /admin/debug only.)
  const booth = [...(status?.sessionMessages || [])].reverse();

  const showName = status?.activeShow?.name || ctx?.time?.show || '—';
  const weatherText = ctx?.weather?.condition
    ? `${ctx.weather.condition}${ctx.weather.temp != null ? ` ${Math.round(ctx.weather.temp)}°` : ''}`
    : '—';

  // 6-cell status strip — real data.
  interface StripCell {
    l: string;
    v: ReactNode;
    sub?: ReactNode;
    accent?: boolean;
  }
  const djName = status?.dj && typeof status.dj === 'object' && 'name' in status.dj
    ? String((status.dj as { name?: unknown }).name ?? '—')
    : '—';
  const strip: StripCell[] = [
    { l: 'dj on air', v: djName, accent: true },
    { l: 'show', v: showName },
    {
      l: 'listeners',
      v: listenersObj?.current != null ? String(listenersObj.current) : '—',
      sub: listenersObj?.peak != null ? `peak ${listenersObj.peak}` : null,
    },
    { l: 'weather', v: weatherText },
    {
      l: 'picker',
      v: q.pickerBusy ? 'thinking' : 'idle',
      accent: !!q.pickerBusy,
    },
  ];

  return (
    <div className="grid gap-4">
      {err && (
        <V3Alert tone="error" title="controller error">
          {err}
        </V3Alert>
      )}

      {/* ── ON AIR HERO ────────────────────────────────────────────────── */}
      <HeroSection
        err={err}
        np={np}
        q={q}
        busy={busy}
        onSkip={() => setConfirmSkip(true)}
        strip={strip}
      />

      {/* ── 2-COL OPS ──────────────────────────────────────────────────── */}
      <div className="stack-mobile grid grid-cols-[1.4fr_1fr] gap-4">
        {/* LEFT */}
        <div className="grid grid-rows-[auto_1fr] gap-4">
          <Card
            title="Queue"
            sub={`${upcoming.length} upcoming`}
            right={
              <>
                <Pill tone="accent" dot={!!q.autoPick}>
                  auto-pick {q.autoPick ? 'on' : 'off'}
                </Pill>
                <Pill tone="accent" dot={!!q.autoLink}>
                  auto-link {q.autoLink ? 'on' : 'off'}
                </Pill>
              </>
            }
            bodyClass="px-3.5 py-1"
          >
            {upcoming.length === 0 ? (
              <div className="py-2.5 text-muted italic">
                queue empty — auto-playlist fallback
              </div>
            ) : (
              upcoming.slice(0, 8).map((t, i) => (
                <div className="track-row" key={i}>
                  <span className="idx">{(i + 1).toString().padStart(2, '0')}</span>
                  <span className="title">
                    {t.title} <span className="artist">— {t.artist}</span>
                  </span>
                  <span className="dur">
                    {typeof t.duration === 'number' || typeof t.duration === 'string'
                      ? t.duration
                      : ''}
                  </span>
                  <span></span>
                  {t.requestedBy ? (
                    <span className="text-right text-[9px] font-bold tracking-[0.2em] text-vermilion uppercase">
                      ↳ {t.requestedBy}
                    </span>
                  ) : (
                    <span></span>
                  )}
                </div>
              ))
            )}
          </Card>

          <Card
            title="Booth log"
            sub={`${booth.length} session turns`}
            right={<Pill>session · live</Pill>}
            className="flex flex-col"
            bodyClass="flex flex-1 flex-col min-h-0"
          >
            {booth.length === 0 ? (
              <div className="text-muted italic">no session turns yet</div>
            ) : (
              <div
                ref={logRef}
                className="max-h-[360px] min-h-[220px] flex-1 overflow-y-auto"
              >
                {booth.map((turn, i) => (
                  <div key={turnKey(turn, i)} className={`log ${classTone(turnClass(turn))}`}>
                    <span className="t">
                      {turn.t != null
                        ? new Date(turn.t).toLocaleTimeString('en-GB', { hour12: false })
                        : ''}
                    </span>
                    <span className="k">[{turn.kind}]</span>
                    <span className="msg">{turnText(turn)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* RIGHT */}
        <div className="grid gap-4">
          <Card title="Manual voice DJ" sub="speak now">
            <Textarea
              className="min-h-[88px]"
              value={sayText}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSayText(e.target.value)}
              maxLength={500}
              placeholder={
                sayMode === 'raw'
                  ? 'Exact words the DJ will speak, verbatim…'
                  : 'An instruction or topic — the DJ writes it in persona…'
              }
            />
            <div className="mt-2.5 flex flex-wrap items-center gap-3.5">
              <div className="flex items-center gap-1.5">
                <span className="caption">mode</span>
                <Seg value={sayMode} options={SAY_MODES} onChange={setSayMode} />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="caption">duck</span>
                <Seg value={sayKind} options={SAY_KINDS} onChange={setSayKind} />
              </div>
              <Btn
                tone="accent"
                className="ml-auto"
                disabled={!!busy || !sayText.trim()}
                onClick={sendVoice}
              >
                {busy === 'say' ? 'sending…' : 'Send to air →'}
              </Btn>
            </div>
          </Card>

          <Card title="DJ segments" sub="fire on demand">
            <div className="grid grid-cols-3 gap-2">
              {SEGMENTS.map(s => {
                const k = `seg:${s.type}`;
                return (
                  <SegmentButton
                    key={s.type}
                    label={s.label}
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
                  <div className="text-[10px] text-muted">
                    rebuild liquidsoap fallback
                  </div>
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

      {!status && !err && (
        <div className="text-muted italic">connecting…</div>
      )}

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

interface HeroSectionProps {
  err: string | null;
  np: NowPlayingTrack | null | undefined;
  q: QueueState;
  busy: string | null;
  onSkip: () => void;
  strip: { l: string; v: ReactNode; sub?: ReactNode; accent?: boolean }[];
}

function HeroSection({ err, np, q, busy, onSkip, strip }: HeroSectionProps) {
  // live-dot is admin-scoped CSS with `background: var(--accent)` already; we
  // only need to override when there's a controller error, so route through
  // the dynamic-style hook (via the DotWithBg helper below).
  return (
    <section className="card border-ink">
      <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-6 border-b border-ink p-[18px]">
        <div>
          <div className="mb-2.5 flex items-center gap-2.5">
            <DotWithBg background={err ? 'var(--danger)' : 'var(--accent)'} />
            <Eyebrow className="text-vermilion">on air</Eyebrow>
            <span className="caption">
              auto-pick {q.autoPick ? 'on' : 'off'} · auto-link {q.autoLink ? 'on' : 'off'}
            </span>
          </div>
          {np?.title ? (
            <>
              <div className="text-[18px] leading-[1.2] font-bold tracking-[-0.01em]">
                {np.title}{' '}
                <span className="font-semibold text-muted">— {np.artist}</span>
              </div>
              {np.album && (
                <div className="caption mt-1.5">
                  album · {np.album}
                </div>
              )}
            </>
          ) : (
            <div className="text-[22px] font-bold text-muted">
              nothing reported playing
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Btn
            lg
            tone="danger"
            disabled={!!busy || !np?.title}
            onClick={onSkip}
          >
            {busy === 'skip' ? 'skipping…' : 'Skip track'}
          </Btn>
        </div>
      </div>

      {/* status strip */}
      <div className="strip-mobile grid grid-cols-6">
        {strip.map((c, i) => (
          <div
            key={i}
            className={cn(
              'flex flex-col gap-0.5 px-3.5 py-3',
              i > 0 && 'border-l border-separator-strong',
            )}
          >
            <span className="caption">{c.l}</span>
            <span
              className={cn(
                'text-[14px] font-semibold',
                c.accent ? 'text-vermilion' : 'text-ink',
              )}
            >
              {c.v}
            </span>
            {c.sub && (
              <span className="caption text-[9px]">
                {c.sub}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

import { useDynamicStyle } from '../../hooks/useDynamicStyle';

interface DotWithBgProps {
  background: string;
}

function DotWithBg({ background }: DotWithBgProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background });
  return <span ref={ref} className="live-dot" />;
}

interface SegmentButtonProps {
  label: string;
  busyHere: boolean;
  anyBusy: boolean;
  onFire: () => void;
}

function SegmentButton({ label, busyHere, anyBusy, onFire }: SegmentButtonProps) {
  const onEnter = (e: MouseEvent<HTMLButtonElement>) => {
    if (!anyBusy) e.currentTarget.style.background = 'color-mix(in oklab, var(--accent) 18%, transparent)';
  };
  const onLeave = (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'color-mix(in oklab, var(--accent) 8%, transparent)';
  };
  const ref = useRef<HTMLButtonElement>(null);
  useDynamicStyle(ref, {
    background: 'color-mix(in oklab, var(--accent) 8%, transparent)',
    cursor: anyBusy ? 'not-allowed' : 'pointer',
    opacity: anyBusy ? '0.4' : '1',
  });
  return (
    <button
      ref={ref}
      disabled={anyBusy}
      onClick={onFire}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="flex flex-col gap-1 border border-[var(--accent)] px-2.5 py-3 text-left font-[inherit] text-ink transition-[background] duration-[120ms] ease-out"
    >
      <span className="text-[11px] font-bold tracking-[0.18em] uppercase">{label}</span>
      <span className="caption text-[9px] font-bold text-vermilion">
        {busyHere ? 'firing…' : 'fire ▸'}
      </span>
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
