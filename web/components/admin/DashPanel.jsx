'use client';

// DJ command center — /admin/dash. Lets the operator step into the autonomous
// booth: speak custom text on-air, fire any voice segment or skill on demand,
// flip the autonomous toggles, and watch live on-air status + the booth log.
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';

const SAY_KINDS = [
  { id: 'dj-speak', label: 'Heavy duck (solo)' },
  { id: 'link',     label: 'Light duck (over track)' },
];
const SAY_MODES = [
  { id: 'raw',    label: 'Raw' },
  { id: 'styled', label: 'Styled' },
];
const SEGMENTS = [
  { type: 'station-id', label: 'Station ID' },
  { type: 'hourly',     label: 'Time Check' },
  { type: 'link',       label: 'Track Link' },
];

export default function DashPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [status, setStatus] = useState(null);   // { nowPlaying, context, listeners, dj, queue }
  const [skills, setSkills] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);       // key of the running action
  const [feedback, setFeedback] = useState(null); // { tone, text }

  const [sayText, setSayText] = useState('');
  const [sayMode, setSayMode] = useState('raw');
  const [sayKind, setSayKind] = useState('dj-speak');

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

  // Skill catalogue — fetched once.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/dj/skills');
        const j = await r.json();
        if (!cancelled && Array.isArray(j?.skills)) setSkills(j.skills);
      } catch {}
    })();
    return () => { cancelled = true; };
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

  // Skip is disruptive — it cuts the track for every listener — so confirm.
  const skipCurrent = async () => {
    if (!window.confirm('Skip the current track for all listeners?')) return;
    await act('skip', '/dj/skip', {}, 'skip track');
  };

  // Toggle a skill's autonomous firing. Server returns the fresh catalogue.
  const toggleSkill = async (s) => {
    const next = s.enabled === false;
    const j = await act(`skilltoggle:${s.name}`, '/dj/skill-toggle',
      { name: s.name, on: next }, `${s.name} ${next ? 'enable' : 'disable'}`);
    if (Array.isArray(j?.skills)) setSkills(j.skills);
  };

  const np = status?.nowPlaying;
  const ctx = status?.context;
  const q = status?.queue || {};
  const listeners = status?.listeners;

  return (
    <div className="space-y-4" style={{ fontSize: 12 }}>
      <div className="flex flex-wrap items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-caption" style={{ color: err ? '#c5302a' : 'var(--accent)' }}>
          ● {err ? 'down' : 'live'}
        </span>
        <span className="v3-caption" style={{ color: 'var(--muted)' }}>dj command center</span>
        {feedback && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: feedback.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
            {feedback.text}
          </span>
        )}
      </div>

      {err && (
        <div style={{ border: '1px solid #c5302a', color: '#c5302a', padding: '8px 12px' }}>
          controller error: {err}
        </div>
      )}

      {/* ── ON AIR ───────────────────────────────────────────────────── */}
      <Section title="On air">
        {!np?.title ? (
          <Empty>nothing reported playing</Empty>
        ) : (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div style={{ fontSize: 15, color: 'var(--ink)' }}>
                {np.title} <span style={{ color: 'var(--muted)' }}>— {np.artist}</span>
              </div>
              <ActionButton
                label="Skip"
                busy={busy === 'skip'}
                disabled={!!busy}
                onClick={skipCurrent}
              />
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 v3-caption" style={{ color: 'var(--muted)' }}>
              {status?.dj?.name && <span>dj · {status.dj.name}</span>}
              {listeners && <span>listeners · {listeners.current} (peak {listeners.peak})</span>}
              {ctx?.time?.period && <span>show · {ctx.time.period}</span>}
              {ctx?.dominantMood && <span>mood · {ctx.dominantMood}</span>}
              {ctx?.weather?.condition && (
                <span>weather · {ctx.weather.condition}{ctx.weather.temp != null ? ` ${Math.round(ctx.weather.temp)}°` : ''}</span>
              )}
              <span>auto-pick · {q.autoPick ? 'on' : 'off'}</span>
              <span>auto-link · {q.autoLink ? 'on' : 'off'}</span>
              <span style={{ color: q.pickerBusy ? 'var(--accent)' : 'var(--muted)' }}>
                picker · {q.pickerBusy ? 'thinking' : 'idle'}
              </span>
            </div>
            <div>
              <div className="v3-caption mb-1" style={{ color: 'var(--muted)' }}>
                upcoming ({q.upcoming?.length ?? 0})
              </div>
              {(q.upcoming?.length ?? 0) === 0 ? (
                <Empty>queue empty — auto-playlist fallback</Empty>
              ) : (
                <ol className="space-y-0.5">
                  {q.upcoming.slice(0, 5).map((t, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="v3-tab-num" style={{ color: 'var(--muted)', width: 20 }}>{i + 1}</span>
                      <span className="truncate flex-1" style={{ color: 'var(--ink)' }}>
                        {t.title} <span style={{ color: 'var(--muted)' }}>— {t.artist}</span>
                      </span>
                      {t.requestedBy && (
                        <span style={{ color: 'var(--accent)', fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
                          ↳ {t.requestedBy}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* ── MANUAL VOICE DJ ──────────────────────────────────────────── */}
      <Section title="Manual voice DJ">
        <div className="space-y-3">
          <textarea
            value={sayText}
            onChange={e => setSayText(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder={sayMode === 'raw'
              ? 'Exact words the DJ will speak, verbatim…'
              : 'An instruction or topic — the DJ writes it in persona…'}
            style={{
              boxSizing: 'border-box', width: '100%', resize: 'vertical',
              border: '1px solid var(--ink)', background: 'transparent',
              padding: '8px 12px', fontSize: 13, fontFamily: 'inherit',
              color: 'var(--ink)', outline: 'none',
            }}
          />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <SegGroup label="mode" value={sayMode} options={SAY_MODES} onPick={setSayMode} />
            <SegGroup label="duck" value={sayKind} options={SAY_KINDS} onPick={setSayKind} />
            <button
              onClick={sendVoice}
              disabled={!!busy || !sayText.trim()}
              className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                marginLeft: 'auto', background: 'var(--accent)', color: '#fff',
                border: '1px solid var(--accent)', padding: '8px 18px', fontSize: 10,
              }}
            >
              {busy === 'say' ? 'sending…' : 'send to air'}
            </button>
          </div>
        </div>
      </Section>

      {/* ── DJ SEGMENTS ──────────────────────────────────────────────── */}
      <Section title="DJ segments">
        <div className="flex flex-wrap gap-2">
          {SEGMENTS.map(s => (
            <ActionButton
              key={s.type}
              label={s.label}
              busy={busy === `seg:${s.type}`}
              disabled={!!busy}
              onClick={() => act(`seg:${s.type}`, '/dj/segment', { type: s.type }, s.label)}
            />
          ))}
        </div>
      </Section>

      {/* ── SKILLS ───────────────────────────────────────────────────── */}
      <Section title="Skills">
        {skills.length === 0 ? (
          <Empty>no skills reported</Empty>
        ) : (
          <div className="space-y-2">
            <div className="v3-caption" style={{ color: 'var(--muted)' }}>
              fire on demand · toggle autonomous firing
            </div>
            {skills.map(s => {
              const enabled = s.enabled !== false;
              return (
                <div key={s.name} className="flex items-center justify-between gap-3">
                  <ActionButton
                    label={s.name}
                    busy={busy === `skill:${s.name}`}
                    disabled={!!busy}
                    onClick={() => act(`skill:${s.name}`, '/dj/skill', { name: s.name }, s.name)}
                  />
                  <button
                    onClick={() => toggleSkill(s)}
                    disabled={!!busy}
                    className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      border: `1px solid ${enabled ? 'var(--accent)' : 'var(--ink)'}`,
                      background: enabled ? 'var(--accent)' : 'transparent',
                      color: enabled ? '#fff' : 'var(--ink)',
                      padding: '5px 14px', fontSize: 10, minWidth: 56,
                    }}
                  >
                    {busy === `skilltoggle:${s.name}` ? '…' : (enabled ? 'auto on' : 'auto off')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ── BROADCAST CONTROLS ───────────────────────────────────────── */}
      <Section title="Broadcast">
        <div className="space-y-2">
          <ToggleRow
            label="Auto-pick" desc="LLM picks the next track when the queue runs dry"
            on={!!q.autoPick} disabled={!!busy || !status}
            onToggle={() => act('autopick', '/auto-pick', { on: !q.autoPick }, 'auto-pick')}
          />
          <ToggleRow
            label="Auto-link" desc="DJ talks between auto-played tracks"
            on={!!q.autoLink} disabled={!!busy || !status}
            onToggle={() => act('autolink', '/dj/auto-link', { on: !q.autoLink }, 'auto-link')}
          />
          <div className="flex items-center justify-between gap-3 pt-1">
            <div>
              <div style={{ color: 'var(--ink)' }}>Auto-playlist</div>
              <div className="v3-caption" style={{ color: 'var(--muted)' }}>
                rebuild the Liquidsoap fallback playlist now
              </div>
            </div>
            <ActionButton
              label="Refresh"
              busy={busy === 'refresh'}
              disabled={!!busy}
              onClick={() => act('refresh', '/dj/refresh-playlist', {}, 'auto-playlist refresh')}
            />
          </div>
        </div>
      </Section>

      {/* ── BOOTH LOG ────────────────────────────────────────────────── */}
      <Section title={`Booth log (${q.djLog?.length ?? 0})`}>
        {(q.djLog?.length ?? 0) === 0 ? (
          <Empty>nothing logged yet</Empty>
        ) : (
          <div ref={logRef} className="v3-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
            {q.djLog.map(e => (
              <div key={e.id} className="flex gap-3" style={{ lineHeight: 1.6 }}>
                <span className="v3-tab-num shrink-0" style={{ color: 'var(--muted)', width: 72 }}>
                  {new Date(e.t).toLocaleTimeString('en-GB', { hour12: false })}
                </span>
                <span
                  className="shrink-0"
                  style={{ width: 92, color: kindColor(e.kind), fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase' }}
                >
                  [{e.kind}]
                </span>
                <span className="break-all" style={{ color: 'var(--ink)' }}>{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {!status && !err && <div className="italic" style={{ color: 'var(--muted)' }}>connecting…</div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ border: '1px solid var(--ink)' }}>
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-caption" style={{ color: 'var(--ink)' }}>{title}</span>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function ActionButton({ label, onClick, busy, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        border: '1px solid var(--ink)', background: 'transparent',
        color: 'var(--ink)', padding: '6px 14px', fontSize: 10,
      }}
    >
      {busy ? 'firing…' : label}
    </button>
  );
}

// Segmented single-choice control (mode / duck pickers).
function SegGroup({ label, value, options, onPick }) {
  return (
    <div className="flex items-center gap-2">
      <span className="v3-caption" style={{ color: 'var(--muted)' }}>{label}</span>
      <div className="flex">
        {options.map(o => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              onClick={() => onPick(o.id)}
              className="v3-focus cursor-pointer"
              style={{
                border: '1px solid var(--ink)', marginLeft: -1,
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--bg)' : 'var(--ink)',
                padding: '5px 10px', fontSize: 10,
                letterSpacing: '0.1em', textTransform: 'uppercase',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({ label, desc, on, disabled, onToggle }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div style={{ color: 'var(--ink)' }}>{label}</div>
        <div className="v3-caption" style={{ color: 'var(--muted)' }}>{desc}</div>
      </div>
      <button
        onClick={onToggle}
        disabled={disabled}
        className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          border: `1px solid ${on ? 'var(--accent)' : 'var(--ink)'}`,
          background: on ? 'var(--accent)' : 'transparent',
          color: on ? '#fff' : 'var(--ink)',
          padding: '5px 14px', fontSize: 10, minWidth: 56,
        }}
      >
        {on ? 'on' : 'off'}
      </button>
    </div>
  );
}

function Empty({ children }) {
  return <div className="italic" style={{ color: 'var(--muted)' }}>{children}</div>;
}

function kindColor(k) {
  switch (k) {
    case 'playing':
    case 'request':
    case 'dj-speak':
    case 'hourly-check':
    case 'weather':
    case 'news':
    case 'traffic':
    case 'random-facts':
    case 'link':
    case 'station-id': return 'var(--accent)';
    case 'error':
    case 'miss': return '#c5302a';
    default: return 'var(--muted)';
  }
}
