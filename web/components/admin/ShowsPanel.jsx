'use client';

// Shows scheduler — /admin/shows. A show is a reusable definition (name,
// topic, owner persona, music mood). The weekly grid assigns a show to any
// 1-hour cell, Mon–Sun. When the current hour has a show, its persona goes on
// air, its mood overrides the autonomous mood, and its topic feeds the DJ.
// An empty hour = the station runs autonomously, as it does today.
// Everything POSTs to /settings and applies live.
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Card, Btn, Pill, Eyebrow, Metric } from './ui';

const NAME_MAX = 60;
const TOPIC_MAX = 500;
const SHOWS_MAX = 64;

// Storage keys are 0=Sun..6=Sat (JS getDay); display Mon-first.
const DAYS = [
  { key: 1, label: 'Mon' }, { key: 2, label: 'Tue' }, { key: 3, label: 'Wed' },
  { key: 4, label: 'Thu' }, { key: 5, label: 'Fri' }, { key: 6, label: 'Sat' },
  { key: 0, label: 'Sun' },
];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const SHOW_COLORS = [
  '#c5302a', '#2f6f4f', '#3a5fa8', '#9a5b1f', '#6b4a8a', '#1f7a7a',
  '#a83a6b', '#4a6b1f', '#8a6a1f', '#3a3a8a', '#7a2f5a', '#2f7a3a',
];

function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 's_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function emptyWeek() {
  const w = {};
  for (let d = 0; d < 7; d++) w[d] = Array(24).fill(null);
  return w;
}
function abbrev(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}
function showValid(s) {
  return s.name.trim().length >= 1 && s.name.trim().length <= NAME_MAX
    && !!s.personaId && !!s.mood && s.topic.trim().length <= TOPIC_MAX;
}

export default function ShowsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [brush, setBrush] = useState(null);   // showId | 'erase' | null
  const [now, setNow] = useState(() => new Date());

  // Live clock — the grid highlights the cell the station is in right now.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const nowDay = now.getDay();
  const nowHour = now.getHours();

  const load = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return null;
      const j = await r.json();
      setData(j); setErr(null);
      return j;
    } catch (e) { setErr(e.message); return null; }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    (async () => {
      const j = await load();
      if (j?.values) {
        const week = emptyWeek();
        const sched = j.values.schedule || {};
        for (let d = 0; d < 7; d++) {
          const day = sched[d];
          if (Array.isArray(day)) for (let h = 0; h < 24; h++) week[d][h] = day[h] ?? null;
        }
        setForm({
          shows: (j.values.shows || []).map(s => ({
            id: s.id, name: s.name ?? '', topic: s.topic ?? '',
            personaId: s.personaId ?? '', mood: s.mood ?? '',
          })),
          schedule: week,
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, needsAuth]);

  const personas = data?.values?.personas || [];
  const moods = data?.tts?.moods || [];
  const colorOf = (showId) => {
    const idx = form ? form.shows.findIndex(s => s.id === showId) : -1;
    return idx >= 0 ? SHOW_COLORS[idx % SHOW_COLORS.length] : 'transparent';
  };
  const showById = (id) => form?.shows.find(s => s.id === id) || null;
  const personaName = (id) => personas.find(p => p.id === id)?.name || '—';

  // ── show helpers ─────────────────────────────────────────────────────────
  const setShow = (i, patch) =>
    setForm(f => ({ ...f, shows: f.shows.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }));
  const addShow = () =>
    setForm(f => {
      if (f.shows.length >= SHOWS_MAX) return f;
      return {
        ...f,
        shows: [...f.shows, {
          id: clientMintId(), name: 'New show', topic: '',
          personaId: personas[0]?.id || '', mood: moods[0] || '',
        }],
      };
    });
  const removeShow = (i) =>
    setForm(f => {
      const target = f.shows[i];
      const week = JSON.parse(JSON.stringify(f.schedule));
      for (let d = 0; d < 7; d++)
        for (let h = 0; h < 24; h++)
          if (week[d][h] === target.id) week[d][h] = null;
      if (brush === target.id) setBrush(null);
      return { ...f, shows: f.shows.filter((_, idx) => idx !== i), schedule: week };
    });

  // ── grid helpers ─────────────────────────────────────────────────────────
  const paintCell = (day, hour) => {
    if (brush === null) return;
    setForm(f => {
      const week = JSON.parse(JSON.stringify(f.schedule));
      if (brush === 'erase') {
        week[day][hour] = null;
      } else {
        // toggle: clicking the same show again clears the cell
        week[day][hour] = week[day][hour] === brush ? null : brush;
      }
      return { ...f, schedule: week };
    });
  };
  const clearWeek = () => setForm(f => ({ ...f, schedule: emptyWeek() }));

  // ── validation ───────────────────────────────────────────────────────────
  const allShowsOk = form ? form.shows.every(showValid) : false;
  const canSave = !!form && allShowsOk;
  const scheduledHours = form
    ? Object.values(form.schedule).flat().filter(Boolean).length : 0;
  const countHours = (id) => form
    ? Object.values(form.schedule).flat().filter(c => c === id).length : 0;

  // ── now / up next / after that — derived from the live schedule ──────────
  const slotAhead = (offset) => {
    const total = nowDay * 24 + nowHour;
    let d = nowDay, h = nowHour, seen = 0, hopped = 0;
    while (seen < offset && hopped < 168) {
      const cur = form?.schedule?.[d]?.[h] ?? null;
      h++; if (h > 23) { h = 0; d = (d + 1) % 7; }
      hopped++;
      const nxt = form?.schedule?.[d]?.[h] ?? null;
      if (nxt !== cur) seen++;
    }
    void total;
    return { day: d, hour: h, showId: form?.schedule?.[d]?.[h] ?? null };
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setSaveMsg(null);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shows: form.shows.map(s => ({
            id: s.id, name: s.name.trim(), topic: s.topic.trim(),
            personaId: s.personaId, mood: s.mood,
          })),
          schedule: form.schedule,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setSaveMsg({ tone: 'ok', text: 'schedule saved — the current hour applies on the next pick' });
      await load();
    } catch (e) {
      setSaveMsg({ tone: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  // ── error / loading shells ───────────────────────────────────────────────
  if (err) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <Card title="Shows" sub="weekly grid">
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>controller error: {err}</div>
        </Card>
      </div>
    );
  }
  if (!form) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <Card title="Shows" sub="weekly grid">
          <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 13 }}>loading…</div>
        </Card>
      </div>
    );
  }

  const validBrushes = form.shows.filter(showValid);
  const nowShow = showById(form.schedule[nowDay][nowHour]);
  const upNext = slotAhead(1);
  const after = slotAhead(2);
  const upNextShow = upNext.showId ? showById(upNext.showId) : null;
  const afterShow = after.showId ? showById(after.showId) : null;

  const NowCard = ({ label, accent, slotHour, show, showId }) => {
    const c = showId ? colorOf(showId) : 'transparent';
    return (
      <div style={{ padding: 14, borderLeft: '1px solid var(--separator-strong)', display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Eyebrow color={accent ? 'var(--accent)' : 'var(--muted)'}>{label}</Eyebrow>
          <span className="caption" style={{ marginLeft: 'auto' }}>
            {String(slotHour).padStart(2, '0')}:00
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {show && <span style={{ width: 16, height: 16, background: c, display: 'inline-block', flexShrink: 0 }} />}
          <span style={{
            fontSize: 16, fontWeight: 800, letterSpacing: '-0.01em',
            color: show ? 'var(--ink)' : 'var(--muted)',
          }}>
            {show ? show.name : '(no show — autonomous)'}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {show
            ? <>persona · {personaName(show.personaId)} · mood · {show.mood}</>
            : 'station runs on its own picker'}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="card">
        <div style={{
          padding: 16, borderBottom: '1px solid var(--ink)',
          display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 16, alignItems: 'center',
        }}>
          <div>
            <Eyebrow color="var(--accent)">shows · weekly grid</Eyebrow>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 6 }}>
              Programme the week, one hour at a time.
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Empty hours run autonomously. Each show owns a persona and a mood.
              {' '}Changes apply live on save.
            </div>
          </div>
          <Metric n={String(scheduledHours)} l="hours scheduled" />
          <Btn lg tone="accent" onClick={addShow}
            disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}>
            + New show
          </Btn>
        </div>

        {/* Now / Up next / After that strip */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
          borderBottom: '1px solid var(--separator-strong)',
        }}>
          <NowCard label="On air" accent slotHour={nowHour} show={nowShow}
            showId={form.schedule[nowDay][nowHour]} />
          <NowCard label="Up next" slotHour={upNext.hour} show={upNextShow} showId={upNext.showId} />
          <NowCard label="After that" slotHour={after.hour} show={afterShow} showId={after.showId} />
        </div>
      </section>

      {personas.length === 0 && (
        <Card title="Personas required" sub="setup">
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>
            No personas defined — create one under Personas first.
          </div>
        </Card>
      )}

      {/* ── WEEKLY SCHEDULE GRID ─────────────────────────────────────────── */}
      <Card
        title="Weekly schedule"
        sub="Mon–Sun · 24h"
        right={<>
          <span className="caption">brush</span>
          <div className="seg accent">
            <button
              className={brush === 'erase' ? 'active' : ''}
              onClick={() => setBrush(brush === 'erase' ? null : 'erase')}
            >
              Erase
            </button>
            {validBrushes.map(s => (
              <button
                key={s.id}
                className={brush === s.id ? 'active' : ''}
                onClick={() => setBrush(brush === s.id ? null : s.id)}
              >
                {s.name.trim() || 'untitled'}
              </button>
            ))}
          </div>
          <Btn sm onClick={clearWeek}>Clear week</Btn>
        </>}
      >
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '40px repeat(24, minmax(28px, 1fr))', gap: 0, minWidth: 720 }}>
            <span />
            {HOURS.map(h => (
              <span key={h} className="mono-num" style={{
                fontSize: 9, textAlign: 'center', padding: '4px 0',
                color: h === nowHour ? 'var(--accent)' : 'var(--muted)',
                fontWeight: h === nowHour ? 700 : 400,
              }}>
                {String(h).padStart(2, '0')}
              </span>
            ))}
            {DAYS.map(({ key, label }) => (
              <DayRow key={key} dayKey={key} label={label} />
            ))}
          </div>
        </div>

        {/* legend */}
        <div style={{
          marginTop: 14, display: 'flex', gap: 16, flexWrap: 'wrap',
          fontSize: 10, color: 'var(--muted)', letterSpacing: '0.18em', textTransform: 'uppercase',
        }}>
          {form.shows.map((s, i) => (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 12, height: 12, background: SHOW_COLORS[i % SHOW_COLORS.length], display: 'inline-block' }} />
              {s.name.trim() || 'untitled'}
            </span>
          ))}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <span style={{ width: 12, height: 12, border: '1px solid var(--separator-strong)' }} />
            autonomous
          </span>
        </div>

        <p style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          Pick a brush above, then click cells to paint. Click an assigned cell with
          the same brush to clear it. The vermilion-ringed cell is the hour on air.
        </p>
      </Card>

      {/* ── SHOW DEFINITIONS ─────────────────────────────────────────────── */}
      <Card
        title="Show definitions"
        sub={`${form.shows.length}/${SHOWS_MAX} shows`}
        right={<Btn sm tone="accent" onClick={addShow}
          disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}>
          + Add show
        </Btn>}
      >
        {form.shows.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>No shows yet — add one to start.</p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
          {form.shows.map((s, i) => {
            const ok = showValid(s);
            const hrs = countHours(s.id);
            return (
              <div key={s.id} style={{
                border: `1px solid ${ok ? 'var(--ink)' : 'var(--danger)'}`,
                padding: 14, display: 'grid', gap: 10, position: 'relative',
              }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0, bottom: 0, width: 4,
                  background: SHOW_COLORS[i % SHOW_COLORS.length],
                }} />
                <div style={{ paddingLeft: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="text" value={s.name} maxLength={NAME_MAX}
                    onChange={e => setShow(i, { name: e.target.value })}
                    className="input" placeholder="Show name"
                    style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 800 }}
                  />
                  <Btn sm tone="danger" onClick={() => removeShow(i)} title="Remove this show">
                    ✕
                  </Btn>
                </div>

                <div style={{ paddingLeft: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <label className="field">
                    <span className="field-label">persona owner</span>
                    <select
                      value={s.personaId}
                      onChange={e => setShow(i, { personaId: e.target.value })}
                      className="select"
                    >
                      <option value="">— pick persona —</option>
                      {personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">music mood</span>
                    <select
                      value={s.mood}
                      onChange={e => setShow(i, { mood: e.target.value })}
                      className="select"
                    >
                      <option value="">— pick mood —</option>
                      {moods.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                </div>

                <label className="field" style={{ paddingLeft: 8 }}>
                  <span className="field-label">topic — fed to the DJ as the show theme</span>
                  <textarea
                    rows={2} value={s.topic} maxLength={TOPIC_MAX}
                    onChange={e => setShow(i, { topic: e.target.value })}
                    placeholder="e.g. slow ambient and modern classical — for the late shift"
                    className="textarea"
                  />
                  <span className="field-hint">{s.topic.trim().length}/{TOPIC_MAX}</span>
                </label>

                <div style={{ paddingLeft: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {hrs > 0
                    ? <Pill tone="ink">{hrs}h / week</Pill>
                    : <Pill>unscheduled</Pill>}
                  {!ok && <Pill tone="accent">needs name, persona &amp; mood</Pill>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── SAVE ─────────────────────────────────────────────────────────── */}
      <Card title="Apply" sub="POST /settings">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <Btn lg tone="accent" onClick={save} disabled={busy || !canSave}>
            {busy ? 'saving…' : 'Save schedule'}
          </Btn>
          {!canSave && !busy && (
            <span style={{ fontSize: 11, color: 'var(--danger)' }}>
              every show needs a name, persona, and mood
            </span>
          )}
          {saveMsg && (
            <span style={{
              fontSize: 12,
              color: saveMsg.tone === 'err' ? 'var(--danger)' : 'var(--accent)',
            }}>
              {saveMsg.text}
            </span>
          )}
        </div>
      </Card>
    </div>
  );

  // ── grid day row (closure over form/brush/now) ───────────────────────────
  function DayRow({ dayKey, label }) {
    return (
      <>
        <span style={{
          fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase',
          fontWeight: 700, padding: '0 8px', alignSelf: 'center', textAlign: 'right',
          color: dayKey === nowDay ? 'var(--accent)' : 'var(--ink)',
        }}>
          {label}
        </span>
        {HOURS.map(h => {
          const showId = form.schedule[dayKey][h];
          const show = showId ? showById(showId) : null;
          const isNow = dayKey === nowDay && h === nowHour;
          return (
            <button
              key={h}
              type="button"
              onClick={() => paintCell(dayKey, h)}
              title={
                (show ? `${show.name} (${show.mood})` : `${label} ${String(h).padStart(2, '0')}:00 — empty`)
                + (isNow ? ' · on air now' : '')
              }
              style={{
                height: 32, marginLeft: -1, marginTop: -1,
                border: '1px solid var(--separator-strong)',
                background: show ? colorOf(showId) : 'transparent',
                color: show ? '#fff' : 'var(--muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, letterSpacing: '0.15em', textTransform: 'uppercase',
                fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                position: 'relative', padding: 0,
              }}
            >
              {show ? abbrev(show.name) : ''}
              {isNow && (
                <span style={{
                  position: 'absolute', inset: -2,
                  border: '2px solid var(--accent)',
                  boxShadow: '0 0 0 1px var(--bg)',
                  pointerEvents: 'none', zIndex: 1,
                }} />
              )}
              {isNow && (
                <span style={{
                  position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)',
                  fontSize: 8, color: 'var(--accent)', letterSpacing: '0.22em', zIndex: 2,
                }}>
                  now
                </span>
              )}
            </button>
          );
        })}
      </>
    );
  }
}
