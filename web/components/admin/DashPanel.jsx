'use client';

// DJ command center — /admin/dash. Lets the operator step into the autonomous
// booth: speak custom text on-air, fire any voice segment on demand,
// flip the autonomous toggles, and watch live on-air status + the booth log.
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3AlertDialog } from '../ui/alert-dialog';
import { V3Alert } from '../ui/alert';
import { Card, Btn, Pill, Eyebrow, Seg, Toggle } from './ui';

const SAY_KINDS = [
  { id: 'dj-speak', label: 'Solo' },
  { id: 'link',     label: 'Over' },
];
const SAY_MODES = [
  { id: 'raw',    label: 'Raw' },
  { id: 'styled', label: 'Styled' },
];
const SEGMENTS = [
  { type: 'station-id', label: 'Station ID' },
  { type: 'hourly',     label: 'Time check' },
  { type: 'link',       label: 'Track link' },
];

export default function DashPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [status, setStatus] = useState(null);   // { nowPlaying, context, listeners, dj, queue }
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);       // key of the running action
  const [feedback, setFeedback] = useState(null); // { tone, text }

  const [sayText, setSayText] = useState('');
  const [sayMode, setSayMode] = useState('raw');
  const [sayKind, setSayKind] = useState('dj-speak');
  const [confirmSkip, setConfirmSkip] = useState(false);

  const logRef = useRef(null);

  // Live status — poll /now-playing + /state together every 3s.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [npR, stR] = await Promise.all([adminFetch('/now-playing'), adminFetch('/state')]);
        if (cancelled) return;
        const np = await npR.json().catch(() => null);
        const st = await stR.json().catch(() => null);
        setStatus({ ...(np || {}), queue: st || {} });
        setErr(null);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, needsAuth]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [status?.queue?.djLog?.[0]?.id]);

  // Generic POST helper — drives the busy + feedback state.
  const act = async (key, path, body, label) => {
    setBusy(key);
    setFeedback(null);
    try {
      const r = await adminFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setFeedback({ tone: 'ok', text: j.spoken ? `on air: “${j.spoken}”` : `${label} — done` });
      return j;
    } catch (e) {
      setFeedback({ tone: 'err', text: `${label}: ${e.message}` });
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
  const q = status?.queue || {};
  const listeners = status?.listeners;
  const upcoming = q.upcoming || [];
  const djLog = q.djLog || [];

  const showName = status?.activeShow?.name || ctx?.time?.period || '—';
  const weatherText = ctx?.weather?.condition
    ? `${ctx.weather.condition}${ctx.weather.temp != null ? ` ${Math.round(ctx.weather.temp)}°` : ''}`
    : '—';

  // 6-cell status strip — real data.
  const strip = [
    { l: 'dj on air',  v: status?.dj?.name || '—', accent: true },
    { l: 'show',       v: showName },
    { l: 'mood',       v: ctx?.dominantMood || '—' },
    { l: 'listeners',  v: listeners ? String(listeners.current) : '—',
      sub: listeners ? `peak ${listeners.peak}` : null },
    { l: 'weather',    v: weatherText },
    { l: 'picker',     v: q.pickerBusy ? 'thinking' : 'idle', accent: !!q.pickerBusy },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── HEADER STRIP ───────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        paddingBottom: 12, borderBottom: '1px solid var(--ink)',
      }}>
        <span className="live-dot" style={{ background: err ? 'var(--danger)' : 'var(--accent)' }} />
        <Eyebrow color={err ? 'var(--danger)' : 'var(--accent)'}>{err ? 'down' : 'live'}</Eyebrow>
        <span className="caption">dj command center</span>
        {feedback && (
          <span style={{
            marginLeft: 'auto', fontSize: 11,
            color: feedback.tone === 'err' ? 'var(--danger)' : 'var(--accent)',
          }}>
            {feedback.text}
          </span>
        )}
      </div>

      {err && <V3Alert tone="error" title="controller error">{err}</V3Alert>}

      {/* ── ON AIR HERO ────────────────────────────────────────────────── */}
      <section className="card" style={{ borderColor: 'var(--ink)' }}>
        <div style={{
          padding: 18, display: 'grid', gridTemplateColumns: '1fr auto', gap: 24,
          alignItems: 'center', borderBottom: '1px solid var(--ink)',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span className="live-dot" style={{ background: err ? 'var(--danger)' : 'var(--accent)' }} />
              <Eyebrow color="var(--accent)">on air</Eyebrow>
              <span className="caption">
                auto-pick {q.autoPick ? 'on' : 'off'} · auto-link {q.autoLink ? 'on' : 'off'}
              </span>
            </div>
            {np?.title ? (
              <>
                <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.05 }}>
                  {np.title} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>— {np.artist}</span>
                </div>
                {np.album && (
                  <div className="caption" style={{ marginTop: 6 }}>album · {np.album}</div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--muted)' }}>
                nothing reported playing
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn lg tone="danger" disabled={!!busy || !np?.title} onClick={() => setConfirmSkip(true)}>
              {busy === 'skip' ? 'skipping…' : 'Skip track'}
            </Btn>
          </div>
        </div>

        {/* status strip */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)',
        }}>
          {strip.map((c, i) => (
            <div key={i} style={{
              padding: '12px 14px',
              borderLeft: i === 0 ? 'none' : '1px solid var(--separator-strong)',
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              <span className="caption">{c.l}</span>
              <span style={{
                fontSize: 14, fontWeight: 600,
                color: c.accent ? 'var(--accent)' : 'var(--ink)',
              }}>
                {c.v}
              </span>
              {c.sub && <span className="caption" style={{ fontSize: 9 }}>{c.sub}</span>}
            </div>
          ))}
        </div>
      </section>

      {/* ── 2-COL OPS ──────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        {/* LEFT */}
        <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', gap: 16 }}>
          <Card
            title="Queue"
            sub={`${upcoming.length} upcoming`}
            right={<>
              <Pill tone={`accent ${q.autoPick ? 'dot' : ''}`}>auto-pick {q.autoPick ? 'on' : 'off'}</Pill>
              <Pill tone={`accent ${q.autoLink ? 'dot' : ''}`}>auto-link {q.autoLink ? 'on' : 'off'}</Pill>
            </>}
            bodyStyle={{ padding: '4px 14px' }}
          >
            {upcoming.length === 0 ? (
              <div style={{ padding: '10px 0', fontStyle: 'italic', color: 'var(--muted)' }}>
                queue empty — auto-playlist fallback
              </div>
            ) : (
              upcoming.slice(0, 8).map((t, i) => (
                <div className="track-row" key={i}>
                  <span className="idx">{(i + 1).toString().padStart(2, '0')}</span>
                  <span className="title">{t.title} <span className="artist">— {t.artist}</span></span>
                  <span className="dur">{t.duration || ''}</span>
                  <span></span>
                  {t.requestedBy ? (
                    <span style={{
                      fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase',
                      color: 'var(--accent)', textAlign: 'right',
                    }}>↳ {t.requestedBy}</span>
                  ) : <span></span>}
                </div>
              ))
            )}
          </Card>

          <Card
            title="Booth log"
            sub={`${djLog.length} recent`}
            right={<Pill>tail · live</Pill>}
            style={{ display: 'flex', flexDirection: 'column' }}
            bodyStyle={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
          >
            {djLog.length === 0 ? (
              <div style={{ fontStyle: 'italic', color: 'var(--muted)' }}>nothing logged yet</div>
            ) : (
              <div ref={logRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {djLog.map(e => (
                  <div key={e.id} className={`log ${kindTone(e.kind)}`}>
                    <span className="t">{new Date(e.t).toLocaleTimeString('en-GB', { hour12: false })}</span>
                    <span className="k">[{e.kind}]</span>
                    <span className="msg">{e.message}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* RIGHT */}
        <div style={{ display: 'grid', gap: 16 }}>
          <Card title="Manual voice DJ" sub="speak now">
            <textarea
              className="textarea"
              style={{ width: '100%', minHeight: 88, boxSizing: 'border-box' }}
              value={sayText}
              onChange={e => setSayText(e.target.value)}
              maxLength={500}
              placeholder={sayMode === 'raw'
                ? 'Exact words the DJ will speak, verbatim…'
                : 'An instruction or topic — the DJ writes it in persona…'}
            />
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="caption">mode</span>
                <Seg value={sayMode} options={SAY_MODES} onChange={setSayMode} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="caption">duck</span>
                <Seg value={sayKind} options={SAY_KINDS} onChange={setSayKind} />
              </div>
              <Btn
                tone="accent"
                style={{ marginLeft: 'auto' }}
                disabled={!!busy || !sayText.trim()}
                onClick={sendVoice}
              >
                {busy === 'say' ? 'sending…' : 'Send to air →'}
              </Btn>
            </div>
          </Card>

          <Card title="DJ segments" sub="fire on demand">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {SEGMENTS.map(s => {
                const k = `seg:${s.type}`;
                return (
                  <button
                    key={s.type}
                    disabled={!!busy}
                    onClick={() => act(k, '/dj/segment', { type: s.type }, s.label)}
                    style={{
                      border: '1px solid var(--ink)', background: 'transparent',
                      padding: '12px 10px', textAlign: 'left', fontFamily: 'inherit',
                      display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--ink)',
                      cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.4 : 1,
                    }}
                  >
                    <span style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 700 }}>
                      {s.label}
                    </span>
                    <span className="caption" style={{ fontSize: 9 }}>
                      {busy === k ? 'firing…' : 'ready'}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card title="Broadcast">
            <div style={{ display: 'grid', gap: 10 }}>
              <ToggleRow
                label="Auto-pick" desc="picks next track when queue runs dry"
                on={!!q.autoPick} disabled={!!busy || !status}
                onToggle={() => act('autopick', '/auto-pick', { on: !q.autoPick }, 'auto-pick')}
              />
              <ToggleRow
                label="Auto-link" desc="DJ talks between auto-played tracks"
                on={!!q.autoLink} disabled={!!busy || !status}
                onToggle={() => act('autolink', '/dj/auto-link', { on: !q.autoLink }, 'auto-link')}
              />
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                paddingTop: 8, borderTop: '1px dashed var(--separator-strong)',
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>Auto-playlist</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>rebuild liquidsoap fallback</div>
                </div>
                <Btn
                  sm
                  disabled={!!busy}
                  onClick={() => act('refresh', '/dj/refresh-playlist', {}, 'auto-playlist refresh')}
                >
                  {busy === 'refresh' ? 'firing…' : 'Refresh'}
                </Btn>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {!status && !err && (
        <div style={{ fontStyle: 'italic', color: 'var(--muted)' }}>connecting…</div>
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

function ToggleRow({ label, desc, on, disabled, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>{desc}</div>
      </div>
      <Toggle on={on} disabled={disabled} onClick={onToggle} />
    </div>
  );
}

function kindTone(k) {
  switch (k) {
    case 'playing':
    case 'request':
    case 'dj-speak':
    case 'hourly-check':
    case 'hourly':
    case 'weather':
    case 'news':
    case 'traffic':
    case 'random-facts':
    case 'link':
    case 'station-id': return 'accent';
    case 'error':
    case 'miss': return 'danger';
    default: return 'muted';
  }
}
