'use client';

// Shows scheduler — /admin/shows. A show is a reusable definition (name,
// topic, owner persona, music mood). The weekly grid assigns a show to any
// 1-hour cell, Mon–Sun. When the current hour has a show, its persona goes on
// air, its mood overrides the autonomous mood, and its topic feeds the DJ.
// An empty hour = the station runs autonomously, as it does today.
// Everything POSTs to /settings and applies live.
//
// Shows are created/edited through a centered modal (components/ui/modal).
// The weekly grid is drag-paintable: pick a brush, then click-drag across
// cells; click a day label or hour header to fill a whole row/column.
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Field } from '../ui/field';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../ui/select';
import { Card, Btn, Pill, Eyebrow, Metric } from './ui';
import { Modal } from '../ui/modal';

const NAME_MAX = 60;
const TOPIC_MAX = 1000;
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

  // Modal state: `editIndex` is null (closed), -1 (new show), or a show index.
  const [editIndex, setEditIndex] = useState(null);
  const [draft, setDraft] = useState(null);

  // Drag-paint stroke: { active, value } — value is the showId/null painted
  // for the whole stroke, decided on mousedown so a drag doesn't flicker.
  const strokeRef = useRef({ active: false, value: undefined });

  // Live clock — the grid highlights the cell the station is in right now.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const nowDay = now.getDay();
  const nowHour = now.getHours();

  // End any drag-paint stroke when the pointer is released anywhere.
  useEffect(() => {
    const end = () => { strokeRef.current.active = false; };
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
    return () => {
      window.removeEventListener('mouseup', end);
      window.removeEventListener('touchend', end);
    };
  }, []);

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
        const shows = (j.values.shows || []).map(s => ({
          id: s.id, name: s.name ?? '', topic: s.topic ?? '',
          personaId: s.personaId ?? '', mood: s.mood ?? '',
        }));
        setForm({ shows, schedule: week });
        // Arm the first valid show as the brush so the grid is paintable at once.
        const firstValid = shows.find(showValid);
        if (firstValid) setBrush(b => b ?? firstValid.id);
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

  // ── show modal ───────────────────────────────────────────────────────────
  const openNew = () => {
    if (!form || form.shows.length >= SHOWS_MAX || personas.length === 0) return;
    setEditIndex(-1);
    setDraft({
      name: '', topic: '',
      personaId: personas[0]?.id || '', mood: moods[0] || '',
    });
  };
  const openEdit = (i) => {
    if (!form) return;
    const s = form.shows[i];
    setEditIndex(i);
    setDraft({ name: s.name, topic: s.topic, personaId: s.personaId, mood: s.mood });
  };
  const closeModal = () => { setEditIndex(null); setDraft(null); };
  const setDraftField = (patch) => setDraft(d => ({ ...d, ...patch }));
  const commitDraft = () => {
    if (!draft || !showValid(draft)) return;
    const clean = {
      name: draft.name.trim(), topic: draft.topic.trim(),
      personaId: draft.personaId, mood: draft.mood,
    };
    if (editIndex === -1) {
      const id = clientMintId();
      setForm(f => (f.shows.length >= SHOWS_MAX
        ? f
        : { ...f, shows: [...f.shows, { id, ...clean }] }));
      // arm the new show as the brush if nothing is armed yet
      setBrush(b => b ?? id);
    } else {
      setForm(f => ({
        ...f,
        shows: f.shows.map((s, idx) => (idx === editIndex ? { ...s, ...clean } : s)),
      }));
    }
    closeModal();
  };

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
  const setCell = (day, hour, value) =>
    setForm(f => {
      if (f.schedule[day][hour] === value) return f;
      const week = { ...f.schedule, [day]: f.schedule[day].slice() };
      week[day][hour] = value;
      return { ...f, schedule: week };
    });

  // The value a stroke paints: erase brush → null; clicking a cell that already
  // holds the brush → null (toggle off); otherwise the brushed show id.
  const strokeValueFor = (day, hour) => {
    if (brush === 'erase' || brush == null) return null;
    return form.schedule[day][hour] === brush ? null : brush;
  };
  const beginStroke = (day, hour) => {
    if (brush == null) return;
    const v = strokeValueFor(day, hour);
    strokeRef.current = { active: true, value: v };
    setCell(day, hour, v);
  };
  const extendStroke = (day, hour) => {
    if (!strokeRef.current.active) return;
    setCell(day, hour, strokeRef.current.value);
  };

  // Fill a whole day (row) or hour (column). Toggles: if every target cell
  // already holds the brush, clear them instead.
  const fillDay = (day) => {
    if (brush == null) return;
    setForm(f => {
      const cells = f.schedule[day];
      const allSet = brush !== 'erase' && cells.every(c => c === brush);
      const v = brush === 'erase' || allSet ? null : brush;
      return { ...f, schedule: { ...f.schedule, [day]: Array(24).fill(v) } };
    });
  };
  const fillHour = (hour) => {
    if (brush == null) return;
    setForm(f => {
      const allSet = brush !== 'erase'
        && DAYS.every(({ key }) => f.schedule[key][hour] === brush);
      const v = brush === 'erase' || allSet ? null : brush;
      const week = {};
      for (let d = 0; d < 7; d++) {
        week[d] = f.schedule[d].slice();
        week[d][hour] = v;
      }
      return { ...f, schedule: week };
    });
  };
  const clearWeek = () => setForm(f => ({ ...f, schedule: emptyWeek() }));

  // Touch drag — translate the moving touch point into a grid cell.
  const onGridTouchMove = (e) => {
    if (!strokeRef.current.active) return;
    const t = e.touches[0];
    if (!t) return;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const cell = el?.closest?.('[data-cell]');
    if (cell) {
      e.preventDefault();
      extendStroke(Number(cell.dataset.day), Number(cell.dataset.hour));
    }
  };

  // ── validation ───────────────────────────────────────────────────────────
  const allShowsOk = form ? form.shows.every(showValid) : false;
  const canSave = !!form && allShowsOk;
  const scheduledHours = form
    ? Object.values(form.schedule).flat().filter(Boolean).length : 0;
  const countHours = (id) => form
    ? Object.values(form.schedule).flat().filter(c => c === id).length : 0;

  // ── now / up next / after that — derived from the live schedule ──────────
  const slotAhead = (offset) => {
    let d = nowDay, h = nowHour, seen = 0, hopped = 0;
    while (seen < offset && hopped < 168) {
      const cur = form?.schedule?.[d]?.[h] ?? null;
      h++; if (h > 23) { h = 0; d = (d + 1) % 7; }
      hopped++;
      const nxt = form?.schedule?.[d]?.[h] ?? null;
      if (nxt !== cur) seen++;
    }
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
  const draftValid = draft ? showValid(draft) : false;

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
        <div className="stack-mobile" style={{
          padding: 16, borderBottom: '1px solid var(--ink)',
          display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 16, alignItems: 'center',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <Eyebrow color="var(--accent)">shows · weekly grid</Eyebrow>
              <span className="mono-num" style={{
                fontSize: 12, fontWeight: 700, color: 'var(--ink)', letterSpacing: '0.04em',
              }}>
                {now.toLocaleDateString('en-GB', {
                  weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
                })}
                {' · '}
                {now.toLocaleTimeString('en-GB', { hour12: false })}
              </span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 6 }}>
              Programme the week, one hour at a time.
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Empty hours run autonomously. Each show owns a persona and a mood.
              {' '}Changes apply live on save.
            </div>
          </div>
          <Metric n={String(scheduledHours)} l="hours scheduled" />
          <Btn lg tone="accent" onClick={openNew}
            disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}>
            + New show
          </Btn>
        </div>

        {/* Now / Up next / After that strip */}
        <div className="stack-mobile" style={{
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
        right={<Btn sm onClick={clearWeek}>Clear week</Btn>}
      >
        {/* brush picker — colour-swatched, click to arm */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12,
        }}>
          <span className="caption" style={{ marginRight: 2 }}>brush</span>
          {validBrushes.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
              add a show to start painting
            </span>
          )}
          {validBrushes.map((s) => {
            const active = brush === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setBrush(active ? null : s.id)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.02em',
                  border: `1px solid ${active ? 'var(--ink)' : 'var(--separator-strong)'}`,
                  background: active ? 'var(--ink)' : 'transparent',
                  color: active ? 'var(--bg)' : 'var(--ink)',
                }}
              >
                <span style={{
                  width: 12, height: 12, flexShrink: 0,
                  background: colorOf(s.id),
                  outline: active ? '1px solid var(--bg)' : 'none',
                }} />
                {s.name.trim() || 'untitled'}
              </button>
            );
          })}
          {validBrushes.length > 0 && (
            <button
              type="button"
              onClick={() => setBrush(brush === 'erase' ? null : 'erase')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 11, fontWeight: 700, letterSpacing: '0.02em',
                border: `1px solid ${brush === 'erase' ? 'var(--ink)' : 'var(--separator-strong)'}`,
                background: brush === 'erase' ? 'var(--ink)' : 'transparent',
                color: brush === 'erase' ? 'var(--bg)' : 'var(--muted)',
              }}
            >
              <span style={{
                width: 12, height: 12, flexShrink: 0,
                border: '1px solid currentColor',
                background: 'repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 4px)',
              }} />
              Erase
            </button>
          )}
        </div>

        <div
          style={{ overflowX: 'auto' }}
          onTouchMove={onGridTouchMove}
        >
          <div style={{
            display: 'grid', gridTemplateColumns: '44px repeat(24, minmax(28px, 1fr))',
            gap: 0, minWidth: 760, userSelect: 'none', touchAction: 'pan-x',
          }}>
            <span />
            {HOURS.map(h => (
              <button
                key={h}
                type="button"
                onClick={() => fillHour(h)}
                title={brush == null
                  ? `${String(h).padStart(2, '0')}:00`
                  : `Fill ${String(h).padStart(2, '0')}:00 across all days`}
                className="mono-num"
                style={{
                  fontSize: 9, textAlign: 'center', padding: '5px 0',
                  color: h === nowHour ? 'var(--accent)' : 'var(--muted)',
                  fontWeight: h === nowHour ? 700 : 400,
                  background: 'transparent', border: 'none', fontFamily: 'inherit',
                  cursor: brush == null ? 'default' : 'pointer',
                }}
              >
                {String(h).padStart(2, '0')}
              </button>
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
          Pick a brush, then <b>click or drag</b> across cells to paint. Click a
          {' '}<b>day name</b> to fill that day, or an <b>hour</b> to fill that hour
          {' '}across the week. Painting over a matching cell clears it. The
          {' '}vermilion-ringed cell is the hour on air.
        </p>
      </Card>

      {/* ── SHOW DEFINITIONS ─────────────────────────────────────────────── */}
      <Card
        title="Show definitions"
        sub={`${form.shows.length}/${SHOWS_MAX} shows`}
        right={<Btn sm tone="accent" onClick={openNew}
          disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}>
          + Add show
        </Btn>}
      >
        {form.shows.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>
            No shows yet — add one to start programming the week.
          </p>
        )}
        <div style={{ display: 'grid', gap: 8 }}>
          {form.shows.map((s, i) => {
            const ok = showValid(s);
            const hrs = countHours(s.id);
            return (
              <div key={s.id} style={{
                border: `1px solid ${ok ? 'var(--separator-strong)' : 'var(--danger)'}`,
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 12px 10px 0',
              }}>
                <div style={{
                  width: 4, alignSelf: 'stretch',
                  background: SHOW_COLORS[i % SHOW_COLORS.length],
                }} />
                <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {s.name.trim() || 'untitled'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    persona · {personaName(s.personaId)} · mood · {s.mood || '—'}
                  </div>
                  {s.topic.trim() && (
                    <div style={{
                      fontSize: 11, color: 'var(--muted)', fontStyle: 'italic',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {s.topic.trim()}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {!ok && <Pill tone="accent">incomplete</Pill>}
                  {hrs > 0
                    ? <Pill tone="ink">{hrs}h / week</Pill>
                    : <Pill>unscheduled</Pill>}
                  <Btn sm onClick={() => openEdit(i)}>Edit</Btn>
                  <Btn sm tone="danger" onClick={() => removeShow(i)} title="Remove this show">
                    ✕
                  </Btn>
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

      {/* ── ADD / EDIT SHOW MODAL ────────────────────────────────────────── */}
      <Modal
        open={editIndex !== null}
        onOpenChange={(o) => { if (!o) closeModal(); }}
        title={editIndex === -1 ? 'New show' : 'Edit show'}
        sub={editIndex === -1 ? 'define a show' : (draft?.name?.trim() || '')}
        footer={draft && (
          <>
            <Btn onClick={closeModal}>Cancel</Btn>
            <Btn tone="accent" onClick={commitDraft} disabled={!draftValid}>
              {editIndex === -1 ? 'Add show' : 'Save changes'}
            </Btn>
          </>
        )}
      >
        {draft && (
          <div style={{ display: 'grid', gap: 14 }}>
            <Field>
              <Label htmlFor="show-name">show name</Label>
              <Input
                id="show-name"
                type="text" value={draft.name} maxLength={NAME_MAX}
                onChange={e => setDraftField({ name: e.target.value })}
                placeholder="e.g. The Late Shift"
                style={{ fontSize: 15, fontWeight: 700 }}
                autoFocus
              />
              <span className="field-hint">{draft.name.trim().length}/{NAME_MAX}</span>
            </Field>

            <div className="stack-mobile" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field>
                <Label>persona owner</Label>
                <Select
                  value={draft.personaId || undefined}
                  onValueChange={val => setDraftField({ personaId: val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="— pick persona —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {personas.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label>music mood</Label>
                <Select
                  value={draft.mood || undefined}
                  onValueChange={val => setDraftField({ mood: val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="— pick mood —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {moods.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <Label htmlFor="show-topic">topic — fed to the DJ as the show theme</Label>
              <span className="field-hint">
                This is the brief the AI DJ works from. The more you describe,
                the better it picks music and writes links — name genres, eras,
                moods, artists to lean into or avoid, the time of day, the kind
                of listener, and how the host should sound. Write it like
                you're briefing a real DJ before their slot.
              </span>
              <Textarea
                id="show-topic"
                rows={7} value={draft.topic} maxLength={TOPIC_MAX}
                onChange={e => setDraftField({ topic: e.target.value })}
                placeholder="e.g. Slow ambient, modern classical and downtempo for the late shift. Think Nils Frahm, Hammock, Bonobo's quieter side — nothing with a hard beat. Keep the host calm and unhurried, like a friend talking you down at 1am."
              />
              <span className="field-hint">{draft.topic.trim().length}/{TOPIC_MAX}</span>
            </Field>

            {!draftValid && (
              <div style={{ fontSize: 11, color: 'var(--danger)' }}>
                A show needs a name, a persona, and a mood.
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );

  // ── grid day row (closure over form/brush/now) ───────────────────────────
  function DayRow({ dayKey, label }) {
    return (
      <>
        <button
          type="button"
          onClick={() => fillDay(dayKey)}
          title={brush == null ? label : `Fill ${label} with the current brush`}
          style={{
            fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase',
            fontWeight: 700, padding: '0 8px', alignSelf: 'stretch', textAlign: 'right',
            color: dayKey === nowDay ? 'var(--accent)' : 'var(--ink)',
            background: 'transparent', border: 'none', fontFamily: 'inherit',
            cursor: brush == null ? 'default' : 'pointer',
          }}
        >
          {label}
        </button>
        {HOURS.map(h => {
          const showId = form.schedule[dayKey][h];
          const show = showId ? showById(showId) : null;
          const isNow = dayKey === nowDay && h === nowHour;
          return (
            <button
              key={h}
              type="button"
              data-cell=""
              data-day={dayKey}
              data-hour={h}
              onMouseDown={() => beginStroke(dayKey, h)}
              onMouseEnter={() => extendStroke(dayKey, h)}
              onTouchStart={() => beginStroke(dayKey, h)}
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
                fontWeight: 700, fontFamily: 'inherit',
                cursor: brush == null ? 'default' : 'pointer',
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
