'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtSize } from '../../lib/format';
import { useAdminAuth } from '../../lib/adminAuth';
import { V3Alert } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
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
        <div className="strip-mobile" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)' }}>
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
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            <Card title="Now playing" sub="now-playing.json" bodyStyle={{ maxHeight: 320, overflowY: 'auto' }}>
              <KvTable obj={data.nowPlaying} />
            </Card>

            <Card title="Icecast" bodyStyle={{ maxHeight: 320, overflowY: 'auto' }}>
              <KvTable obj={data.icecast} />
            </Card>

            <Card title="DJ context" bodyStyle={{ maxHeight: 200, overflowY: 'auto' }}>
              <KvTable obj={data.context} />
            </Card>
          </div>

          {/* ── TTS ROUTING — who speaks the next segment ───────────────── */}
          {data.tts && !data.tts.error && (
            <Card title="TTS routing" sub="who voices the next spoken segment">
              <TtsRouting tts={data.tts} />
            </Card>
          )}

          {/* ── LLM RECENT CALLS (full width) ───────────────────────────── */}
          <LlmCalls llm={data.llm} />

          {/* ── LIQUIDSOAP LOG (full width) ─────────────────────────────── */}
          <Card
            title="Liquidsoap log"
            sub="last 100 lines"
            style={{ display: 'flex', flexDirection: 'column', height: 440 }}
            bodyStyle={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
            right={
              <Label
                className="flex cursor-pointer items-center gap-1.5 text-[10px] uppercase tracking-[0.18em]"
                style={{ color: 'var(--muted)' }}
              >
                <Checkbox
                  checked={autoScroll}
                  onCheckedChange={v => setAutoScroll(v === true)}
                />
                auto-scroll
              </Label>
            }
          >
            <pre ref={logRef} className="term" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {data.liquidsoapLog || '— no log —'}
            </pre>
          </Card>

          {/* ── ROW 3 — STATE DIR + VOICE WAVS + LIBRARY ────────────────── */}
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.2fr', gap: 16 }}>
            <Card title="State dir" sub="/var/sub-wave" bodyStyle={{ maxHeight: 320, overflowY: 'auto' }}>
              <FilesTable files={data.stateFiles} />
            </Card>

            <Card
              title="DJ voice WAVs"
              sub={`${data.voiceFiles?.length ?? 0} files`}
              bodyStyle={{ maxHeight: 320, overflowY: 'auto' }}
            >
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
                          <Pill key={m}>
                            {m} <span className="mono-num" style={{ marginLeft: 4, color: 'var(--muted)' }}>{n}</span>
                          </Pill>
                        ))}
                    </div>
                  </div>
                  <div>
                    <div className="caption" style={{ marginBottom: 6 }}>by energy</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {Object.entries(data.library.byEnergy || {}).map(([e, n]) => (
                        <Pill key={e}>
                          {e} <span className="mono-num" style={{ marginLeft: 4, color: 'var(--muted)' }}>{n}</span>
                        </Pill>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* ── QUEUE — current request + upcoming ──────────────────────── */}
          <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 16 }}>
            <Card title="Queue" sub="current served request">
              {data.queue?.current ? (
                <KvTable obj={data.queue.current} />
              ) : (
                <span className="field-hint" style={{ fontStyle: 'italic' }}>none (auto-playlist)</span>
              )}
            </Card>

            <Card title="Upcoming queue" sub={`${data.queue?.upcoming?.length ?? 0} tracks`} bodyStyle={{ maxHeight: 320, overflowY: 'auto' }}>
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

          {/* ── DJ SESSION — the current run's chat history ─────────────── */}
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
          <Card title="Config" sub="redacted" bodyStyle={{ maxHeight: 360, overflowY: 'auto' }}>
            <KvTable obj={data.config} />
          </Card>
        </>
      )}
    </div>
  );
}

function TtsRouting({ tts }) {
  const s = tts.spoken || {};
  const fellBack = !!s.fellBack;
  const voiceLabel = s.voice
    ? (s.provider ? `${s.provider} / ${s.voice}` : s.voice)
    : null;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="caption">persona</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{tts.effectivePersona?.name || '—'}</span>
        <span className="caption" style={{ marginLeft: 8 }}>engine</span>
        <Pill
          tone={fellBack ? undefined : 'accent'}
          style={fellBack ? { color: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
        >
          {s.engine || '—'}
        </Pill>
        {voiceLabel && <Pill>{voiceLabel}</Pill>}
        {fellBack && (
          <span className="caption" style={{ color: 'var(--danger)' }}>
            requested {s.requested} · fell back
          </span>
        )}
        <span className="caption" style={{ marginLeft: 'auto' }}>
          jingle · {tts.jingle?.engine || '—'}
        </span>
      </div>
      {fellBack && (
        <V3Alert tone="error" title={`Cloud voice unavailable — speaking via ${s.engine}`}>
          This persona is set to <strong>{s.requested}</strong> TTS, but it isn’t usable
          (switched off, or the provider’s API key is missing). Spoken segments are coming
          out of <strong>{s.engine}</strong> instead. Fix it in Settings → TTS voice.
        </V3Alert>
      )}
    </div>
  );
}

function SessionChat({ session }) {
  const msgs = session.messages || [];
  return (
    <div style={{ display: 'grid', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
      {session.handoff && (
        <div className="caption" style={{ fontStyle: 'italic' }}>
          ↪ continuing from {session.handoff}
        </div>
      )}
      {msgs.length === 0 && (
        <span className="field-hint" style={{ fontStyle: 'italic' }}>no turns yet</span>
      )}
      {msgs.map((m, i) => (
        <div
          key={i}
          style={{
            display: 'grid', gridTemplateColumns: 'auto 64px 1fr', gap: 8,
            alignItems: 'baseline', fontSize: 12,
            padding: '3px 0',
            borderBottom: i < msgs.length - 1 ? '1px dashed var(--separator-strong)' : 'none',
          }}
        >
          <span className="mono-num" style={{ fontSize: 10, color: 'var(--muted)' }}>
            {m.t ? new Date(m.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
          </span>
          <span style={{
            fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase',
            color: roleColor(m.role),
          }}>
            {m.role}{m.kind ? `·${m.kind}` : ''}
          </span>
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</span>
        </div>
      ))}
    </div>
  );
}

function roleColor(role) {
  if (role === 'dj' || role === 'segment') return 'var(--accent)';
  if (role === 'track') return 'var(--ink)';
  return 'var(--muted)';
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

// One-line preview of a longer value, for collapsed section summaries.
function oneLine(s, n = 110) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// A collapsible labelled field inside an LLM call. Collapsed by default with a
// one-line preview in the summary, so a call can be scanned without expanding
// every field — the whole point of the browsable layout.
function CallSection({ label, count, preview, tone, children }) {
  return (
    <details style={{
      border: '1px solid var(--separator-strong)', background: 'var(--bg)',
    }}>
      <summary style={{
        display: 'flex', gap: 8, alignItems: 'baseline',
        padding: '5px 8px', cursor: 'pointer',
      }}>
        <span className="caption" style={{
          flex: 'none', color: tone === 'err' ? 'var(--danger)' : undefined,
        }}>
          {label}{count != null ? ` · ${count}` : ''}
        </span>
        {preview && (
          <span style={{
            fontSize: 11, color: 'var(--muted)', minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {preview}
          </span>
        )}
      </summary>
      <div style={{
        padding: '6px 10px 10px', fontSize: 11,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        color: tone === 'err' ? 'var(--danger)' : 'var(--ink)',
      }}>
        {children}
      </div>
    </details>
  );
}

// The agent's message window — one block per turn, role-chipped.
function MessageList({ messages }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {messages.map((m, i) => {
        const body = typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content, null, 2);
        return (
          <div key={i} style={{ borderLeft: '2px solid var(--separator-strong)', paddingLeft: 8 }}>
            <span style={{
              fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: m.role === 'assistant' ? 'var(--accent)' : 'var(--muted)',
            }}>
              {m.role}
            </span>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body}</div>
          </div>
        );
      })}
    </div>
  );
}

// The agent tool-loop trail — each call its own collapsible row with args and
// a result block, so the picker's reasoning path can be drilled into.
function ToolList({ calls }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {calls.map((t, i) => {
        const result = t.result == null
          ? null
          : (typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2));
        return (
          <details key={i} style={{
            border: '1px solid var(--separator-strong)', background: 'var(--card-bg)',
          }}>
            <summary style={{
              display: 'flex', gap: 8, alignItems: 'baseline',
              padding: '4px 8px', cursor: 'pointer',
            }}>
              <span className="mono-num" style={{ color: 'var(--muted)' }}>{i + 1}</span>
              <span style={{ fontWeight: 700 }}>{t.name}</span>
              <span style={{
                fontSize: 11, color: 'var(--muted)', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {oneLine(t.args ? JSON.stringify(t.args) : '', 90)}
              </span>
            </summary>
            <div style={{ padding: '4px 10px 8px', display: 'grid', gap: 4, fontSize: 11 }}>
              <span className="caption">args</span>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>
                {JSON.stringify(t.args ?? {}, null, 2)}
              </pre>
              {result != null && (
                <>
                  <span className="caption">result</span>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>
                    {result}
                  </pre>
                </>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
        padding: '3px 8px', cursor: 'pointer',
        border: '1px solid var(--separator-strong)',
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? 'var(--bg)' : 'var(--muted)',
      }}
    >
      {children}
    </button>
  );
}

// Full-width LLM recent-calls browser: kind-filter chips, per-call collapse,
// and per-field collapsible sections so each call can be drilled into cleanly.
function LlmCalls({ llm }) {
  const calls = llm?.recentCalls || [];
  const [filter, setFilter] = useState('all');
  const kinds = Array.from(new Set(calls.map(c => c.kind).filter(Boolean)));
  const shown = filter === 'all' ? calls : calls.filter(c => c.kind === filter);
  return (
    <Card
      title="LLM recent calls"
      sub={`${calls.length} calls · ${llm?.provider || '—'} / ${llm?.activeModel || '—'}`}
      right={
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
      <div style={{ display: 'grid', gap: 6, maxHeight: 600, overflowY: 'auto' }}>
        {shown.length === 0 && (
          <span className="field-hint" style={{ fontStyle: 'italic' }}>
            {calls.length === 0 ? 'no calls yet' : 'no calls match this filter'}
          </span>
        )}
        {shown.map((c, i) => (
          <details key={i} style={{
            border: '1px solid var(--separator-strong)',
            background: i === 0 && filter === 'all' ? 'var(--ink-softer)' : 'transparent',
          }}>
            <summary style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto auto auto',
              gap: 10, padding: '8px 10px', alignItems: 'center', cursor: 'pointer',
            }}>
              <span style={{ color: c.ok ? 'var(--accent)' : 'var(--danger)', fontWeight: 700 }}>
                {c.ok ? '✓' : '✗'}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{c.kind}</span>
              <span className="caption" style={{ fontSize: 10 }}>
                {c.toolCalls?.length ? `🔧 ${c.toolCalls.length}` : ''}
                {c.steps != null ? `${c.toolCalls?.length ? ' · ' : ''}${c.steps} steps` : ''}
              </span>
              <span className="mono-num" style={{ fontSize: 11, color: 'var(--muted)' }}>{c.ms}ms</span>
              <span className="mono-num" style={{ fontSize: 10, color: 'var(--muted)' }}>
                {c.t ? new Date(c.t).toLocaleTimeString('en-GB', { hour12: false }) : '—'}
              </span>
            </summary>
            <div style={{ padding: '4px 10px 10px', display: 'grid', gap: 4 }}>
              <div className="caption" style={{ fontSize: 9 }}>
                {c.model || '—'}{c.via ? ` · ${c.via}` : ''}
              </div>
              {c.error && (
                <CallSection label="error" tone="err" preview={oneLine(c.error)}>
                  {c.error}
                </CallSection>
              )}
              {c.user && (
                <CallSection label="user" preview={oneLine(c.user)}>{c.user}</CallSection>
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
                  {c.response}
                </CallSection>
              )}
            </div>
          </details>
        ))}
      </div>
    </Card>
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
