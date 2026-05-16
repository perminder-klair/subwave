'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtSize } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3Alert } from '../ui/alert';

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
    <div className="space-y-4" style={{ fontSize: 12 }}>
      <div className="flex flex-wrap items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span style={{ color: err ? '#c5302a' : 'var(--accent)' }} className="v3-caption">
          <span style={{ color: err ? '#c5302a' : 'var(--accent)' }}>●</span>{' '}
          {err ? 'down' : 'live'}
        </span>
        <button
          onClick={() => setPaused(!paused)}
          className="v3-focus cursor-pointer"
          style={{
            border: '1px solid var(--ink)',
            padding: '4px 10px',
            background: 'transparent',
            color: 'var(--ink)',
            fontSize: 10,
            letterSpacing: '0.3em',
            textTransform: 'uppercase',
          }}
        >
          {paused ? 'resume' : 'pause'}
        </button>
        <span style={{ color: 'var(--muted)' }} className="v3-caption">refresh 2s</span>
      </div>

      {err && <V3Alert tone="error" title="controller error">{err}</V3Alert>}

      {data && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Panel title="Now playing (now-playing.json)">
            <KV obj={data.nowPlaying} />
          </Panel>

          <Panel title="Icecast">
            <KV obj={data.icecast} />
          </Panel>

          <Panel title="Queue · current served request">
            {data.queue?.current ? <KV obj={data.queue.current} /> : <Empty>none (auto-playlist)</Empty>}
          </Panel>

          <Panel title="DJ context">
            <KV obj={data.context} />
          </Panel>

          <Panel title={`Upcoming queue (${data.queue?.upcoming?.length ?? 0})`} fullWidth>
            {(data.queue?.upcoming?.length ?? 0) === 0 ? <Empty>queue empty</Empty> : (
              <ol className="space-y-1">
                {data.queue.upcoming.map((t, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="v3-tab-num" style={{ color: 'var(--muted)', width: 24 }}>{i + 1}</span>
                    <span className="truncate flex-1" style={{ color: 'var(--ink)' }}>
                      {t.title} — <span style={{ color: 'var(--muted)' }}>{t.artist}</span>
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
          </Panel>

          <Panel title={`DJ log (${data.queue.djLogCount} total, last 30)`} fullWidth>
            <div className="v3-scroll" style={{ maxHeight: 288, overflowY: 'auto' }}>
              {data.queue.djLog.map(e => (
                <div key={e.id} className="flex gap-3" style={{ lineHeight: 1.6 }}>
                  <span
                    className="v3-tab-num shrink-0"
                    style={{ color: 'var(--muted)', width: 80 }}
                  >
                    {new Date(e.t).toLocaleTimeString('en-GB', { hour12: false })}
                  </span>
                  <span
                    className="shrink-0"
                    style={{ width: 96, color: kindColor(e.kind), fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase' }}
                  >
                    [{e.kind}]
                  </span>
                  <span className="break-all" style={{ color: 'var(--ink)' }}>{e.message}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={`LLM recent calls (${data.llm.recentCalls.length})`} fullWidth>
            <div className="v3-caption mb-2" style={{ color: 'var(--muted)' }}>
              {data.llm.activeModel} · provider {data.llm.provider}
            </div>
            <div className="space-y-2 v3-scroll" style={{ maxHeight: 384, overflowY: 'auto' }}>
              {data.llm.recentCalls.length === 0 && <Empty>no calls yet</Empty>}
              {data.llm.recentCalls.map((c, i) => (
                <details key={i} style={{ border: '1px solid var(--ink)', padding: '4px 8px' }}>
                  <summary className="cursor-pointer flex flex-wrap items-center gap-2">
                    <span style={{ color: c.ok ? 'var(--accent)' : '#c5302a' }}>{c.ok ? '✓' : '✗'}</span>
                    <span style={{ color: 'var(--ink)' }}>{c.kind}</span>
                    <span style={{ color: 'var(--muted)' }}>{c.ms}ms</span>
                    <span className="ml-auto v3-tab-num" style={{ color: 'var(--muted)' }}>
                      {new Date(c.t).toLocaleTimeString('en-GB', { hour12: false })}
                    </span>
                  </summary>
                  <div className="mt-2 space-y-1" style={{ fontSize: 11 }}>
                    {c.user && <Field label="user">{c.user}</Field>}
                    {c.systemPreview && <Field label="system…">{c.systemPreview}…</Field>}
                    {c.response && <Field label="response">{c.response}</Field>}
                    {c.error && <Field label="error" tone="err">{c.error}</Field>}
                  </div>
                </details>
              ))}
            </div>
          </Panel>

          <Panel
            title="Liquidsoap log (last 100 lines)"
            fullWidth
            extra={
              <label className="flex items-center gap-1 v3-caption" style={{ color: 'var(--muted)' }}>
                <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                auto-scroll
              </label>
            }
          >
            <pre
              ref={logRef}
              className="v3-scroll"
              style={{
                fontSize: 11,
                lineHeight: 1.4,
                maxHeight: 384,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: 'var(--ink)',
                background: 'transparent',
                padding: 8,
                border: '1px solid rgba(0,0,0,0.1)',
              }}
            >
              {data.liquidsoapLog}
            </pre>
          </Panel>

          <Panel title="State dir /var/sub-wave">
            <Files files={data.stateFiles} />
          </Panel>

          <Panel title={`DJ voice WAVs (${data.voiceFiles?.length ?? 0})`}>
            <Files files={data.voiceFiles} />
          </Panel>

          <Panel title={`Library tags · ${data.library?.total ?? 0} tracks`} fullWidth>
            {!data.library?.total ? (
              <Empty>not tagged yet — start tagger from settings</Empty>
            ) : (
              <div className="space-y-3">
                <div className="v3-caption" style={{ color: 'var(--muted)' }}>
                  last updated: {data.library.updatedAt ? new Date(data.library.updatedAt).toLocaleString('en-GB') : '?'}
                </div>
                <div>
                  <div className="v3-caption mb-1" style={{ color: 'var(--muted)' }}>by mood</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(data.library.byMood || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([m, n]) => (
                        <span key={m} style={{ border: '1px solid var(--ink)', padding: '2px 8px' }}>
                          <span style={{ color: 'var(--ink)' }}>{m}</span>{' '}
                          <span className="v3-tab-num" style={{ color: 'var(--muted)' }}>{n}</span>
                        </span>
                      ))}
                  </div>
                </div>
                <div>
                  <div className="v3-caption mb-1" style={{ color: 'var(--muted)' }}>by energy</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(data.library.byEnergy || {}).map(([e, n]) => (
                      <span key={e} style={{ border: '1px solid var(--ink)', padding: '2px 8px' }}>
                        <span style={{ color: 'var(--ink)' }}>{e}</span>{' '}
                        <span className="v3-tab-num" style={{ color: 'var(--muted)' }}>{n}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Panel>

          <Panel title="Config (redacted)" fullWidth>
            <KV obj={data.config} />
          </Panel>
        </div>
      )}

      {!data && !err && <div className="italic" style={{ color: 'var(--muted)' }}>connecting…</div>}
    </div>
  );
}

function Panel({ title, children, fullWidth, extra }) {
  return (
    <section
      className={fullWidth ? 'lg:col-span-2' : ''}
      style={{ border: '1px solid var(--ink)' }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid var(--ink)' }}
      >
        <span className="v3-caption" style={{ color: 'var(--ink)' }}>{title}</span>
        {extra}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function KV({ obj }) {
  if (!obj) return <Empty>—</Empty>;
  return (
    <div className="space-y-0.5">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k} className="flex gap-3">
          <span className="shrink-0 w-32 truncate v3-caption" style={{ color: 'var(--muted)' }}>{k}</span>
          <span className="break-all flex-1" style={{ color: 'var(--ink)' }}>
            {v === null ? <em style={{ color: 'var(--muted)' }}>null</em>
              : typeof v === 'object' ? <pre className="inline whitespace-pre-wrap" style={{ fontSize: 11 }}>{JSON.stringify(v, null, 2)}</pre>
              : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Files({ files }) {
  if (!files || files.error) return <Empty>{files?.error || 'no files'}</Empty>;
  return (
    <div className="space-y-0.5">
      {files.map(f => (
        <div key={f.name} className="flex gap-3">
          <span className="shrink-0 truncate" style={{ width: 176, color: f.isDir ? 'var(--accent)' : 'var(--ink)' }}>
            {f.isDir ? '📁 ' : ''}{f.name}
          </span>
          <span className="v3-tab-num shrink-0 text-right" style={{ width: 64, color: 'var(--muted)' }}>
            {fmtSize(f.size)}
          </span>
          <span className="v3-tab-num ml-auto shrink-0" style={{ color: 'var(--muted)' }}>
            {f.mtime ? new Date(f.mtime).toLocaleTimeString('en-GB', { hour12: false }) : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children, tone }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 v3-caption" style={{ color: 'var(--muted)', width: 64 }}>{label}</span>
      <span
        className="whitespace-pre-wrap break-all"
        style={{ color: tone === 'err' ? '#c5302a' : 'var(--ink)' }}
      >
        {children}
      </span>
    </div>
  );
}

function Empty({ children }) {
  return <div className="italic" style={{ color: 'var(--muted)' }}>{children}</div>;
}

function kindColor(k) {
  switch (k) {
    case 'playing': return 'var(--accent)';
    case 'queued':  return 'var(--muted)';
    case 'request': return 'var(--accent)';
    case 'dj-speak':
    case 'hourly-check':
    case 'weather':
    case 'station-id': return 'var(--accent)';
    case 'scheduler': return 'var(--muted)';
    case 'error':
    case 'miss': return '#c5302a';
    default: return 'var(--muted)';
  }
}
