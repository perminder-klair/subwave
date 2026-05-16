'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtSize } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3Alert } from '../ui/alert';
import { Card, Btn, Pill, Eyebrow } from './ui';

export default function DebugPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef(null);

  useEffect(() => {
    // Wait for the auth token to hydrate from localStorage — fetching before
    // then sends an unauthenticated request that 401s.
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      if (paused) return;
      try {
        const r = await adminFetch('/debug');
        if (r.status === 401) {
          // adminFetch already flipped needsAuth; the shell will swap in the sign-in.
          if (!cancelled) setData(null);
          return;
        }
        const j = await r.json();
        if (!cancelled) {
          // Defensive: a malformed payload (anything missing the queue
          // block) would crash the renderer. Surface as an error instead.
          if (!j || typeof j !== 'object' || !j.queue) {
            setErr(j?.error || 'unexpected response shape from /debug');
            setData(null);
          } else {
            setData(j);
            setErr(null);
          }
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, needsAuth, hydrated]);

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [data?.liquidsoapLog, autoScroll]);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── HEALTH STRIP ────────────────────────────────────────────────── */}
      <section className="card">
        <div style={{ padding: 14, borderBottom: '1px solid var(--ink)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Eyebrow color={err ? 'var(--danger)' : 'var(--accent)'}>
            ● {err ? 'down' : 'live'}
          </Eyebrow>
          <span className="caption">refresh · 2s</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Btn sm onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Btn>
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)' }}>
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
            label="DJ log"
            status={data?.queue ? 'ok' : 'idle'}
            v={data?.queue?.djLogCount != null ? String(data.queue.djLogCount) : '—'}
            sub="entries total"
          />
          <HealthCell
            label="Tagger"
            status={data?.library?.total ? 'ok' : 'off'}
            v={data?.library?.total ? `${data.library.total} tracks` : '—'}
            sub={data?.library?.updatedAt ? new Date(data.library.updatedAt).toLocaleDateString('en-GB') : 'not tagged'}
          />
        </div>
      </section>

      {err && <V3Alert tone="error" title="controller error">{err}</V3Alert>}

      {!data && !err && (
        <Card title="Debug">
          <span className="field-hint" style={{ fontStyle: 'italic' }}>connecting…</span>
        </Card>
      )}

      {data && (
        <>
          {/* ── ROW 1 — NOW PLAYING / ICECAST / DJ CONTEXT ──────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <Card title="Now playing" sub="now-playing.json">
              <KvTable obj={data.nowPlaying} />
            </Card>

            <Card title="Icecast">
              <KvTable obj={data.icecast} />
            </Card>

            <Card title="DJ context">
              <KvTable obj={data.context} />
            </Card>
          </div>

          {/* ── ROW 2 — LLM + LIQUIDSOAP ────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 16 }}>
            <Card
              title="LLM recent calls"
              sub={`${data.llm?.recentCalls?.length ?? 0} · ${data.llm?.provider || '—'} / ${data.llm?.activeModel || '—'}`}
            >
              <div style={{ display: 'grid', gap: 6, maxHeight: 384, overflowY: 'auto' }}>
                {(data.llm?.recentCalls?.length ?? 0) === 0 && (
                  <span className="field-hint" style={{ fontStyle: 'italic' }}>no calls yet</span>
                )}
                {(data.llm?.recentCalls || []).map((c, i) => (
                  <details key={i} style={{
                    border: '1px solid var(--separator-strong)',
                    background: i === 0 ? 'var(--ink-softer)' : 'transparent',
                  }}>
                    <summary style={{
                      display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10,
                      padding: '8px 10px', alignItems: 'center', cursor: 'pointer',
                    }}>
                      <span style={{ color: c.ok ? 'var(--accent)' : 'var(--danger)', fontWeight: 700 }}>
                        {c.ok ? '✓' : '✗'}
                      </span>
                      <span style={{ fontSize: 12 }}>{c.kind}</span>
                      <span className="mono-num" style={{ fontSize: 11, color: 'var(--muted)' }}>{c.ms}ms</span>
                      <span className="mono-num" style={{ fontSize: 10, color: 'var(--muted)' }}>
                        {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
                      </span>
                    </summary>
                    <div style={{ padding: '4px 10px 10px', display: 'grid', gap: 4, fontSize: 11 }}>
                      {c.user && <CallField label="user">{c.user}</CallField>}
                      {c.systemPreview && <CallField label="system…">{c.systemPreview}…</CallField>}
                      {c.response && <CallField label="response">{c.response}</CallField>}
                      {c.error && <CallField label="error" tone="err">{c.error}</CallField>}
                    </div>
                  </details>
                ))}
              </div>
            </Card>

            <Card
              title="Liquidsoap log"
              sub="last 100 lines"
              right={
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 10,
                  color: 'var(--muted)', letterSpacing: '0.18em', textTransform: 'uppercase',
                }}>
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={e => setAutoScroll(e.target.checked)}
                  />
                  auto-scroll
                </label>
              }
            >
              <pre ref={logRef} className="term" style={{ maxHeight: 260 }}>
                {data.liquidsoapLog || '— no log —'}
              </pre>
            </Card>
          </div>

          {/* ── ROW 3 — STATE DIR + VOICE WAVS + LIBRARY ────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 16 }}>
            <Card title="State dir" sub="/var/sub-wave">
              <FilesTable files={data.stateFiles} />
            </Card>

            <Card title="DJ voice WAVs" sub={`${data.voiceFiles?.length ?? 0} files`}>
              <FilesTable files={data.voiceFiles} />
            </Card>

            <Card
              title="Library tags"
              sub={`${data.library?.total ?? 0} tracks${data.library?.updatedAt ? ' · ' + new Date(data.library.updatedAt).toLocaleString('en-GB') : ''}`}
            >
              {!data.library?.total ? (
                <span className="field-hint" style={{ fontStyle: 'italic' }}>
                  not tagged yet — start tagger from settings
                </span>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div>
                    <div className="caption" style={{ marginBottom: 6 }}>by mood</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {Object.entries(data.library.byMood || {})
                        .sort((a, b) => b[1] - a[1])
                        .map(([m, n]) => (
                          <span key={m} className="tag" style={{ fontSize: 10 }}>
                            {m} <span className="mono-num" style={{ marginLeft: 4, color: 'var(--muted)' }}>{n}</span>
                          </span>
                        ))}
                    </div>
                  </div>
                  <div>
                    <div className="caption" style={{ marginBottom: 6 }}>by energy</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {Object.entries(data.library.byEnergy || {}).map(([e, n]) => (
                        <span key={e} className="tag" style={{ fontSize: 10 }}>
                          {e} <span className="mono-num" style={{ marginLeft: 4, color: 'var(--muted)' }}>{n}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* ── QUEUE — current request + upcoming ──────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 16 }}>
            <Card title="Queue" sub="current served request">
              {data.queue?.current ? (
                <KvTable obj={data.queue.current} />
              ) : (
                <span className="field-hint" style={{ fontStyle: 'italic' }}>none (auto-playlist)</span>
              )}
            </Card>

            <Card title="Upcoming queue" sub={`${data.queue?.upcoming?.length ?? 0} tracks`}>
              {(data.queue?.upcoming?.length ?? 0) === 0 ? (
                <span className="field-hint" style={{ fontStyle: 'italic' }}>queue empty</span>
              ) : (
                <div>
                  {data.queue.upcoming.map((t, i) => (
                    <div key={i} className="track-row" style={{ gridTemplateColumns: '24px 1fr auto' }}>
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
                </div>
              )}
            </Card>
          </div>

          {/* ── DJ LOG (full width) ─────────────────────────────────────── */}
          <Card title="DJ log" sub={`${data.queue.djLogCount} total · last 30`}>
            <div style={{ display: 'grid', gap: 4, maxHeight: 288, overflowY: 'auto' }}>
              {(data.queue.djLog || []).map(e => (
                <div key={e.id} className={`log ${kindTone(e.kind)}`}>
                  <span className="t">
                    {new Date(e.t).toLocaleTimeString('en-GB', { hour12: false })}
                  </span>
                  <span className="k">[{e.kind}]</span>
                  <span className="msg">{e.message}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* ── CONFIG (full width) ─────────────────────────────────────── */}
          <Card title="Config" sub="redacted">
            <KvTable obj={data.config} />
          </Card>
        </>
      )}
    </div>
  );
}

function HealthCell({ label, status, v, sub }) {
  const color =
    status === 'ok' ? 'var(--accent)'
    : status === 'idle' || status === 'off' ? 'var(--muted)'
    : 'var(--danger)';
  return (
    <div style={{
      padding: '12px 14px',
      borderLeft: '1px solid var(--separator-strong)',
      display: 'grid', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
        <span className="caption">{label}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, wordBreak: 'break-word' }}>{v}</div>
      <div className="caption" style={{ fontSize: 9 }}>{sub}</div>
    </div>
  );
}

function KvTable({ obj }) {
  if (!obj || (typeof obj === 'object' && Object.keys(obj).length === 0)) {
    return <span className="field-hint" style={{ fontStyle: 'italic' }}>—</span>;
  }
  return (
    <dl className="kv">
      {Object.entries(obj).map(([k, val]) => (
        <KvRow key={k} k={k} val={val} />
      ))}
    </dl>
  );
}

function KvRow({ k, val }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {val === null || val === undefined ? (
          <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>null</span>
        ) : typeof val === 'object' ? (
          <pre style={{
            margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: 'inherit',
          }}>
            {JSON.stringify(val, null, 2)}
          </pre>
        ) : (
          String(val)
        )}
      </dd>
    </>
  );
}

function FilesTable({ files }) {
  if (!files || files.error) {
    return (
      <span className="field-hint" style={{ fontStyle: 'italic' }}>
        {files?.error || 'no files'}
      </span>
    );
  }
  if (files.length === 0) {
    return <span className="field-hint" style={{ fontStyle: 'italic' }}>empty</span>;
  }
  return (
    <div style={{ display: 'grid', gap: 0 }}>
      {files.map((f, i) => (
        <div key={f.name} style={{
          display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10,
          padding: '6px 0', fontSize: 11,
          borderBottom: i < files.length - 1 ? '1px dashed var(--separator-strong)' : 'none',
        }}>
          <span style={{ color: f.isDir ? 'var(--accent)' : 'var(--ink)', wordBreak: 'break-all' }}>
            {f.isDir ? '📁 ' : ''}{f.name}
          </span>
          <span className="mono-num" style={{ color: 'var(--muted)' }}>{fmtSize(f.size)}</span>
          <span className="mono-num" style={{ color: 'var(--muted)' }}>
            {f.mtime ? new Date(f.mtime).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

function CallField({ label, children, tone }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span className="caption" style={{ flex: 'none', width: 64 }}>{label}</span>
      <span style={{
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        color: tone === 'err' ? 'var(--danger)' : 'var(--ink)',
      }}>
        {children}
      </span>
    </div>
  );
}

function fmtListeners(icecast) {
  if (!icecast || icecast.error) return '—';
  if (icecast.listeners != null) return `${icecast.listeners} listeners`;
  return 'up';
}

function kindTone(k) {
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
