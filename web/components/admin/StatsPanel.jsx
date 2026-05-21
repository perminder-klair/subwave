'use client';

/* Admin Stats page — usage rollups for the LLM and TTS call rings plus DJ
   activity. Polls the controller's /stats endpoint, which aggregates the
   in-memory call buffers (since boot, lost on restart). Deliberately carries
   only rollups — the raw per-call lists live on /debug. */

import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3Alert } from '../ui/alert';
import { Card, Btn, Pill, Eyebrow } from './ui';

// --- formatters ---------------------------------------------------------

const fmtInt = n => (n == null ? '—' : Number(n).toLocaleString('en-GB'));

const fmtMs = n => {
  if (n == null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
};

const fmtPct = n => (n == null ? '—' : `${Math.round(n * 100)}%`);

const fmtTokens = n => {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
};

// --- small building blocks ---------------------------------------------

function StatCell({ label, value, sub, accent, danger, last }) {
  const color = danger ? 'var(--danger)' : accent ? 'var(--accent)' : 'inherit';
  return (
    <div style={{
      padding: 14, display: 'grid', gap: 3,
      borderRight: last ? 'none' : '1px solid var(--separator-soft)',
    }}>
      <span className="caption">{label}</span>
      <span className="mono-num" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color }}>
        {value}
      </span>
      {sub && <span className="caption" style={{ color: 'var(--muted)' }}>{sub}</span>}
    </div>
  );
}

function MetricStrip({ children }) {
  return (
    <div
      className="strip-mobile"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${children.length}, 1fr)`,
        borderBottom: '1px solid var(--separator-strong)',
      }}
    >
      {children}
    </div>
  );
}

function Bar({ frac }) {
  return (
    <span style={{
      display: 'inline-block', width: 56, height: 6,
      background: 'var(--separator-soft)', borderRadius: 2, overflow: 'hidden',
      verticalAlign: 'middle',
    }}>
      <span style={{
        display: 'block', height: '100%',
        width: `${Math.max(2, Math.round((frac || 0) * 100))}%`,
        background: 'var(--accent)',
      }} />
    </span>
  );
}

function Table({ cols, rows, empty }) {
  if (!rows?.length) {
    return <span className="field-hint" style={{ fontStyle: 'italic' }}>{empty}</span>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {cols.map(c => (
            <th key={c.key} className="caption" style={{
              textAlign: c.align || 'left', padding: '4px 8px', whiteSpace: 'nowrap',
              borderBottom: '1px solid var(--separator-strong)',
            }}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {cols.map(c => (
              <td key={c.key} style={{
                textAlign: c.align || 'left', padding: '5px 8px', fontSize: 12,
                borderBottom: '1px solid var(--separator-soft)',
              }}>
                {c.render ? c.render(r) : r[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --- panel --------------------------------------------------------------

export default function StatsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    const tick = async () => {
      if (paused) return;
      try {
        const r = await adminFetch('/stats');
        if (r.status === 401) {
          if (!cancelled) setData(null);
          return;
        }
        const j = await r.json();
        if (cancelled) return;
        if (!j || typeof j !== 'object' || !j.llm) {
          setErr(j?.error || 'unexpected response shape from /stats');
          setData(null);
        } else {
          setData(j);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, needsAuth, hydrated]);

  const llm = data?.llm;
  const tts = data?.tts;
  const djLog = data?.djLog;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <section className="card">
        <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Eyebrow color={err ? 'var(--danger)' : 'var(--accent)'}>
            ● {err ? 'down' : 'live'}
          </Eyebrow>
          <span className="caption">refresh · 5s</span>
          <span className="caption" style={{ color: 'var(--muted)' }}>
            in-memory · since controller boot
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <Btn sm onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</Btn>
          </span>
        </div>
      </section>

      {err && <V3Alert tone="error" title="controller error">{err}</V3Alert>}

      {!data && !err && (
        <Card title="Stats">
          <span className="field-hint" style={{ fontStyle: 'italic' }}>connecting…</span>
        </Card>
      )}

      {data && (
        <>
          {/* ── LLM USAGE ─────────────────────────────────────────────── */}
          <Card
            title="LLM usage"
            sub={`last ${llm.window} model calls`}
            right={llm.activeModel ? <Pill tone="accent">{llm.activeModel}</Pill> : null}
          >
            {llm.count === 0 ? (
              <span className="field-hint" style={{ fontStyle: 'italic' }}>
                no model calls recorded yet
              </span>
            ) : (
              <div style={{ display: 'grid', gap: 0 }}>
                <MetricStrip>
                  <StatCell label="Calls" value={fmtInt(llm.count)}
                    sub={`${llm.ok} ok · ${llm.failed} failed`} />
                  <StatCell label="Success rate" value={fmtPct(llm.successRate)}
                    danger={llm.successRate != null && llm.successRate < 0.9} />
                  <StatCell label="Avg latency" value={fmtMs(llm.latency.avg)}
                    sub={`p95 ${fmtMs(llm.latency.p95)}`} />
                  <StatCell label="Tokens" value={fmtTokens(llm.tokens?.total)}
                    sub={llm.tokens
                      ? `${fmtTokens(llm.tokens.input)} in · ${fmtTokens(llm.tokens.output)} out`
                      : 'provider reports none'} />
                  <StatCell label="Agent runs" value={fmtInt(llm.agent.calls)} last
                    sub={llm.agent.calls
                      ? `${llm.agent.avgSteps} steps · ${llm.agent.avgTools} tools avg`
                      : 'none'} />
                </MetricStrip>

                <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                  <div style={{ padding: 14, borderRight: '1px solid var(--separator-soft)' }}>
                    <div className="caption" style={{ marginBottom: 8 }}>by call kind</div>
                    <Table
                      empty="no calls"
                      rows={llm.byKind}
                      cols={[
                        { key: 'kind', label: 'Kind', render: r => r.kind.replace(/^sdk\./, '') },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'ok', label: 'OK', align: 'right',
                          render: r => <span className="mono-num">{r.ok}/{r.count}</span> },
                        { key: 'avgMs', label: 'Avg', align: 'right',
                          render: r => <span className="mono-num">{fmtMs(r.avgMs)}</span> },
                        { key: 'tokens', label: 'Tokens', align: 'right',
                          render: r => <span className="mono-num">{fmtTokens(r.tokens || null)}</span> },
                      ]}
                    />
                  </div>
                  <div style={{ padding: 14 }}>
                    <div className="caption" style={{ marginBottom: 8 }}>by model</div>
                    <Table
                      empty="no calls"
                      rows={llm.byModel}
                      cols={[
                        { key: 'model', label: 'Model' },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'tokens', label: 'Tokens', align: 'right',
                          render: r => <span className="mono-num">{fmtTokens(r.tokens || null)}</span> },
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* ── TTS USAGE ─────────────────────────────────────────────── */}
          <Card title="Voice / TTS usage" sub={`last ${tts.window} spoken segments`}>
            {tts.count === 0 ? (
              <span className="field-hint" style={{ fontStyle: 'italic' }}>
                no spoken segments recorded yet
              </span>
            ) : (
              <div style={{ display: 'grid', gap: 0 }}>
                <MetricStrip>
                  <StatCell label="Segments" value={fmtInt(tts.count)}
                    sub={`${tts.ok} ok · ${tts.failed} failed`} />
                  <StatCell label="Avg latency" value={fmtMs(tts.latency.avg)}
                    sub={`p95 ${fmtMs(tts.latency.p95)}`} />
                  <StatCell label="Slowest" value={fmtMs(tts.latency.max)} />
                  <StatCell label="Fallbacks" value={fmtInt(tts.fellBack)}
                    danger={tts.fellBack > 0}
                    sub={`${fmtPct(tts.fallbackRate)} of calls`} />
                  <StatCell label="Characters" value={fmtTokens(tts.chars)} last
                    sub="voiced" />
                </MetricStrip>

                <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                  <div style={{ padding: 14, borderRight: '1px solid var(--separator-soft)' }}>
                    <div className="caption" style={{ marginBottom: 8 }}>by engine</div>
                    <Table
                      empty="no segments"
                      rows={tts.byEngine}
                      cols={[
                        { key: 'engine', label: 'Engine' },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'ok', label: 'OK', align: 'right',
                          render: r => <span className="mono-num">{r.ok}/{r.count}</span> },
                        { key: 'avgMs', label: 'Avg', align: 'right',
                          render: r => <span className="mono-num">{fmtMs(r.avgMs)}</span> },
                      ]}
                    />
                  </div>
                  <div style={{ padding: 14 }}>
                    <div className="caption" style={{ marginBottom: 8 }}>by segment kind</div>
                    <Table
                      empty="no segments"
                      rows={tts.byKind}
                      cols={[
                        { key: 'kind', label: 'Kind' },
                        { key: 'count', label: 'Calls', align: 'right',
                          render: r => <span className="mono-num">{r.count}</span> },
                        { key: 'avgMs', label: 'Avg', align: 'right',
                          render: r => <span className="mono-num">{fmtMs(r.avgMs)}</span> },
                      ]}
                    />
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* ── DJ ACTIVITY ───────────────────────────────────────────── */}
          <Card title="DJ activity" sub={`${djLog.count} log events by kind`}>
            {!djLog.byKind.length ? (
              <span className="field-hint" style={{ fontStyle: 'italic' }}>
                no DJ-log events yet
              </span>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {djLog.byKind.map(r => {
                  const max = djLog.byKind[0].count || 1;
                  return (
                    <div key={r.kind} style={{
                      display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
                    }}>
                      <span style={{ width: 110, color: 'var(--muted)' }}>{r.kind}</span>
                      <Bar frac={r.count / max} />
                      <span className="mono-num" style={{ fontWeight: 700 }}>{r.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
