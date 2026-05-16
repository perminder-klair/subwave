'use client';

// Shows scheduler — /admin/shows. A show is a reusable definition (name,
// topic, owner persona, music mood). The weekly grid assigns a show to any
// 1-hour cell, Mon–Sun. When the current hour has a show, its persona goes on
// air, its mood overrides the autonomous mood, and its topic feeds the DJ.
// An empty hour = the station runs autonomously, as it does today.
// Everything POSTs to /settings and applies live.
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';

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

const inputStyle = {
  boxSizing: 'border-box', border: '1px solid var(--ink)',
  background: 'transparent', padding: '8px 12px', fontSize: 14,
  fontFamily: 'inherit', color: 'var(--ink)', outline: 'none',
};
const textareaStyle = {
  boxSizing: 'border-box', width: '100%',
  border: '1px solid var(--ink)', background: 'transparent',
  padding: 10, fontSize: 13, fontFamily: 'inherit', color: 'var(--ink)',
  resize: 'vertical', lineHeight: 1.5,
};

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
  if (words.length >= 2) return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
  return name.trim().slice(0, 3).toUpperCase();
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

  return (
    <div className="space-y-4">
      <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
        Programme the week. Define shows below, then paint them onto the grid —
        each cell is one hour. An empty hour leaves the station running
        autonomously. Changes apply live.
      </p>

      <div
        style={{
          borderLeft: '2px solid var(--accent)', paddingLeft: 12,
          color: 'var(--muted)', fontSize: 13, lineHeight: 1.6,
        }}
      >
        Now:{' '}
        <strong style={{ color: 'var(--ink)' }}>
          {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </strong>
        {' · '}
        <span className="v3-tab-num" style={{ color: 'var(--ink)' }}>
          {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        {' — the highlighted cell is the hour on air.'}
      </div>

      {err && <Alert tone="err">controller error: {err}</Alert>}
      {!form && !err && <div style={{ color: 'var(--muted)' }} className="italic">loading…</div>}

      {form && (
        <>
          {personas.length === 0 && (
            <Alert tone="err">No personas defined — create one under Personas first.</Alert>
          )}

          {/* ── SHOW DEFINITIONS ─────────────────────────────────────── */}
          <Section
            title="Shows"
            extra={<span className="v3-caption" style={{ color: 'var(--muted)' }}>{form.shows.length}/{SHOWS_MAX}</span>}
          >
            {form.shows.length === 0 && (
              <p style={{ color: 'var(--muted)', fontSize: 12 }}>No shows yet — add one to start.</p>
            )}
            <div className="space-y-4">
              {form.shows.map((s, i) => {
                const ok = showValid(s);
                return (
                  <div key={s.id} style={{ border: `1px solid ${ok ? 'var(--ink)' : '#c5302a'}`, padding: 14 }}>
                    <div className="flex items-center gap-2 mb-3">
                      <span style={{ width: 14, height: 14, background: SHOW_COLORS[i % SHOW_COLORS.length], display: 'inline-block', flexShrink: 0 }} />
                      <input
                        type="text" value={s.name} maxLength={NAME_MAX}
                        onChange={e => setShow(i, { name: e.target.value })}
                        className="v3-focus" placeholder="Show name"
                        style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                      />
                      <button
                        type="button" onClick={() => removeShow(i)}
                        className="v3-focus cursor-pointer shrink-0"
                        style={{ border: '1px solid var(--ink)', background: 'transparent', color: 'var(--ink)', padding: '6px 10px', fontSize: 12, lineHeight: 1 }}
                        title="Remove this show"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-4 mb-3">
                      <label className="space-y-1">
                        <span className="v3-caption" style={{ color: 'var(--muted)', display: 'block' }}>persona owner</span>
                        <select
                          value={s.personaId}
                          onChange={e => setShow(i, { personaId: e.target.value })}
                          className="v3-focus" style={{ ...inputStyle, width: 200 }}
                        >
                          <option value="">— pick persona —</option>
                          {personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="v3-caption" style={{ color: 'var(--muted)', display: 'block' }}>music mood</span>
                        <select
                          value={s.mood}
                          onChange={e => setShow(i, { mood: e.target.value })}
                          className="v3-focus" style={{ ...inputStyle, width: 200 }}
                        >
                          <option value="">— pick mood —</option>
                          {moods.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      </label>
                    </div>
                    <div>
                      <span className="v3-caption" style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
                        topic / what it&apos;s about — fed to the DJ as the show theme
                      </span>
                      <textarea
                        rows={2} value={s.topic} maxLength={TOPIC_MAX}
                        onChange={e => setShow(i, { topic: e.target.value })}
                        placeholder="e.g. slow ambient and modern classical — for the late shift"
                        className="v3-focus" style={textareaStyle}
                      />
                      <div className="v3-caption" style={{ color: 'var(--muted)', marginTop: 2 }}>
                        {s.topic.trim().length}/{TOPIC_MAX}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3">
              <OutlineButton onClick={addShow} disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}>
                + add show
              </OutlineButton>
            </div>
          </Section>

          {/* ── WEEKLY GRID ──────────────────────────────────────────── */}
          <Section
            title="Weekly schedule"
            extra={<span className="v3-caption" style={{ color: 'var(--muted)' }}>{scheduledHours} hr scheduled</span>}
          >
            <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 8 }}>
              Pick a show below, then click grid cells to assign it. Click an
              assigned cell again to clear it.
            </p>

            {/* brush palette */}
            <div className="flex flex-wrap gap-2 mb-4">
              {form.shows.filter(showValid).map((s) => {
                const sel = brush === s.id;
                return (
                  <button
                    key={s.id} type="button"
                    onClick={() => setBrush(sel ? null : s.id)}
                    className="v3-focus cursor-pointer"
                    style={{
                      border: `1px solid ${sel ? 'var(--accent)' : 'var(--ink)'}`,
                      background: sel ? colorOf(s.id) : 'transparent',
                      color: sel ? '#fff' : 'var(--ink)',
                      padding: '5px 10px', fontSize: 12,
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    <span style={{ width: 10, height: 10, background: colorOf(s.id), display: 'inline-block' }} />
                    {s.name.trim() || 'untitled'}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setBrush(brush === 'erase' ? null : 'erase')}
                className="v3-focus cursor-pointer"
                style={{
                  border: `1px solid ${brush === 'erase' ? 'var(--accent)' : 'var(--ink)'}`,
                  background: brush === 'erase' ? 'var(--ink)' : 'transparent',
                  color: brush === 'erase' ? 'var(--bg)' : 'var(--ink)',
                  padding: '5px 10px', fontSize: 12,
                }}
              >
                erase
              </button>
              <OutlineButton onClick={clearWeek}>clear week</OutlineButton>
            </div>

            {/* grid */}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 10 }}>
                <thead>
                  <tr>
                    <th style={{ width: 38 }} />
                    {HOURS.map(h => (
                      <th
                        key={h}
                        style={{
                          width: 26, paddingBottom: 3, textAlign: 'center',
                          color: h === nowHour ? 'var(--accent)' : 'var(--muted)',
                          fontWeight: h === nowHour ? 700 : 400,
                        }}
                      >
                        {String(h).padStart(2, '0')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DAYS.map(({ key, label }) => (
                    <tr key={key}>
                      <td
                        style={{
                          fontWeight: key === nowDay ? 700 : 600, fontSize: 11,
                          paddingRight: 6, textAlign: 'right',
                          color: key === nowDay ? 'var(--accent)' : 'var(--ink)',
                        }}
                      >
                        {label}
                      </td>
                      {HOURS.map(h => {
                        const showId = form.schedule[key][h];
                        const show = showId ? showById(showId) : null;
                        const isNow = key === nowDay && h === nowHour;
                        return (
                          <td key={h} style={{ padding: 0 }}>
                            <button
                              type="button"
                              onClick={() => paintCell(key, h)}
                              title={
                                (show ? `${show.name} (${show.mood})` : `${label} ${String(h).padStart(2, '0')}:00 — empty`)
                                + (isNow ? ' · on air now' : '')
                              }
                              className="v3-focus cursor-pointer"
                              style={{
                                width: 26, height: 26,
                                border: '1px solid var(--separator-strong)',
                                background: show ? colorOf(showId) : 'transparent',
                                color: '#fff', fontSize: 8, lineHeight: 1, padding: 0,
                                display: 'block',
                                position: 'relative',
                                outline: isNow ? '2px solid var(--accent)' : 'none',
                                outlineOffset: '-2px',
                                zIndex: isNow ? 1 : 'auto',
                              }}
                            >
                              {show ? abbrev(show.name) : ''}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* ── SAVE ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3" style={{ paddingTop: 4 }}>
            <SolidButton onClick={save} disabled={busy || !canSave}>
              {busy ? 'saving…' : 'save schedule'}
            </SolidButton>
            {!canSave && !busy && (
              <span className="v3-caption" style={{ color: '#c5302a' }}>
                every show needs a name, persona, and mood
              </span>
            )}
            {saveMsg && (
              <span style={{ fontSize: 12, color: saveMsg.tone === 'err' ? '#c5302a' : 'var(--accent)' }}>
                {saveMsg.text}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, extra, children }) {
  return (
    <section style={{ border: '1px solid var(--ink)' }}>
      <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: '1px solid var(--ink)' }}>
        <span className="v3-eyebrow" style={{ fontSize: 11 }}>{title}</span>
        {extra}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
function SolidButton({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick} disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '8px 16px', fontSize: 10 }}
    >
      {children}
    </button>
  );
}
function OutlineButton({ onClick, disabled, children }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      className="v3-eyebrow v3-focus cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
      style={{ background: 'transparent', color: 'var(--ink)', border: '1px solid var(--ink)', padding: '5px 11px', fontSize: 10 }}
    >
      {children}
    </button>
  );
}
function Alert({ tone, children }) {
  return (
    <div style={{ border: `1px solid ${tone === 'err' ? '#c5302a' : 'var(--ink)'}`, color: tone === 'err' ? '#c5302a' : 'var(--ink)', padding: '8px 12px', fontSize: 13 }}>
      {children}
    </div>
  );
}
