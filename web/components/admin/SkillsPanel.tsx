'use client';

// Skills editor — /admin/skills. The autonomous DJ segments (weather, news,
// traffic, random facts) the station can fire between tracks.
//
// Each skill is toggled on/off station-wide here. A skill only fires
// autonomously when it is enabled here AND assigned to the persona on air
// (see /admin/personas). "Run now" is an operator override — it fires the
// segment immediately, bypassing the enable toggle, the persona assignment,
// the frequency gate, and the cooldown.
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { notify, errorMessage } from '../../lib/notify';
import { useAdminAuth } from '../../lib/adminAuth';
import { Card, Btn, Pill, Eyebrow, Toggle } from './ui';
import { V3Alert } from '../ui/alert';

interface Skill {
  name: string;
  label?: string;
  kind?: string;
  description?: string;
  enabled?: boolean;
  ready?: boolean;
  requiresKey?: string;
  keyUrl?: string;
  cooldownMs?: number;
  custom?: boolean;
  feed?: string | null;
  feedMaxItems?: number | null;
}

interface SkillsResponse {
  skills?: Skill[];
}

interface SkillToggleResponse {
  skills?: Skill[];
  error?: string;
}

interface SkillRunResponse {
  spoken?: string;
  error?: string;
}

// Response of GET /dj/skills/:kind/file — the editable contents of a built-in
// skill's SKILL.md (or live defaults when it hasn't been scaffolded yet).
interface SkillFileResponse {
  kind: string;
  exists?: boolean;
  isNews?: boolean;
  label?: string;
  cooldown?: string;
  context?: string;                 // comma-separated "right now" fields (#471)
  knownContextFields?: string[];    // the full vocabulary, for the tick-boxes
  feed?: string | null;
  feedMaxItems?: number | null;
  brief?: string;
  error?: string;
}

// The in-form editing state for one built-in skill.
interface EditForm {
  kind: string;
  isNews: boolean;
  label: string;
  cooldown: string;
  context: string[];          // selected "right now" fields the segment may mention
  knownContext: string[];     // the full vocabulary to render tick-boxes from
  feed: string;
  feedMaxItems: string;
  brief: string;
}

// Friendly labels for the context fields (#471). Keys are the controller's
// CONTEXT_FIELDS vocabulary; anything not listed falls back to the raw key.
const CONTEXT_FIELD_LABELS: Record<string, string> = {
  date: 'Date & season',
  clock: 'Clock time',
  time: 'Daypart',
  weather: 'Weather',
  festival: 'Festival',
  show: 'Current show',
  listeners: 'Listener count',
};
// Fallback vocabulary if the controller doesn't send knownContextFields.
const CONTEXT_FIELDS_FALLBACK = ['date', 'clock', 'time', 'weather', 'festival', 'show', 'listeners'];

function splitContext(s?: string): string[] {
  return typeof s === 'string' ? s.split(',').map(t => t.trim()).filter(Boolean) : [];
}

function cooldownLabel(ms?: number): string {
  if (!ms) return 'no cooldown';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min cooldown`;
  const h = Math.round(min / 6) / 10;
  return `${h} h cooldown`;
}

interface SkillDescriptionProps {
  text?: string;
  keyUrl?: string;
}

// Renders a skill description, turning the "<Provider> API key" phrase into a
// link to where that key is issued (skill.keyUrl). Plain text when no keyUrl.
function SkillDescription({ text, keyUrl }: SkillDescriptionProps): ReactNode {
  const desc = text || 'No description.';
  const m = keyUrl ? desc.match(/[A-Z][\w-]* API key/) : null;
  if (!m || m.index == null) return desc;
  return (
    <>
      {desc.slice(0, m.index)}
      <a
        href={keyUrl}
        target="_blank"
        rel="noreferrer"
        className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
      >
        {m[0]}
      </a>
      {desc.slice(m.index + m[0].length)}
    </>
  );
}

export default function SkillsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // skill name currently mutating, or null
  const [rescanning, setRescanning] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // kind whose edit form is open
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editBusy, setEditBusy] = useState(false);             // loading or saving the edit form

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/dj/skills');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as SkillsResponse;
        if (cancelled) return;
        setSkills(Array.isArray(j.skills) ? j.skills : []);
        setErr(null);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth, adminFetch]);

  const toggle = async (name: string, on: boolean) => {
    setBusy(name);
    try {
      const r = await adminFetch('/dj/skill-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, on }),
      });
      const j = (await r.json().catch(() => ({}))) as SkillToggleResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (Array.isArray(j.skills)) setSkills(j.skills);
    } catch (e) {
      notify.err(`Toggle failed: ${errorMessage(e)}`);
    } finally { setBusy(null); }
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      const r = await adminFetch('/dj/skills/rescan', { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as SkillToggleResponse & { custom?: number };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (Array.isArray(j.skills)) setSkills(j.skills);
      notify.ok(`Rescanned, ${j.custom ?? 0} custom skill${j.custom === 1 ? '' : 's'} loaded`);
    } catch (e) {
      notify.err(`Rescan failed: ${errorMessage(e)}`);
    } finally { setRescanning(false); }
  };

  // Open (or toggle closed) the inline edit form for a built-in skill. Fetches
  // the current SKILL.md contents so the form prefills with what's on disk.
  const openEdit = async (kind: string) => {
    if (editing === kind) { setEditing(null); setEditForm(null); return; }
    setEditing(kind);
    setEditForm(null);
    setEditBusy(true);
    try {
      const r = await adminFetch(`/dj/skills/${kind}/file`);
      const j = (await r.json().catch(() => ({}))) as SkillFileResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setEditForm({
        kind,
        isNews: !!j.isNews,
        label: j.label || '',
        cooldown: j.cooldown || '',
        context: splitContext(j.context),
        knownContext: Array.isArray(j.knownContextFields) && j.knownContextFields.length
          ? j.knownContextFields
          : CONTEXT_FIELDS_FALLBACK,
        feed: j.feed || '',
        feedMaxItems: j.feedMaxItems != null ? String(j.feedMaxItems) : '',
        brief: j.brief || '',
      });
    } catch (e) {
      notify.err(`Couldn't load skill: ${errorMessage(e)}`);
      setEditing(null);
    } finally { setEditBusy(false); }
  };

  const saveEdit = async () => {
    if (!editForm) return;
    setEditBusy(true);
    try {
      const body: Record<string, unknown> = {
        brief: editForm.brief,
        cooldown: editForm.cooldown,
        label: editForm.label,
        // Sent as an array; an empty list resets the skill to the default
        // profile (everything except weather). See issue #471.
        context: editForm.context,
      };
      if (editForm.isNews) {
        body.feed = editForm.feed;
        if (editForm.feedMaxItems) body.feedMaxItems = editForm.feedMaxItems;
      }
      const r = await adminFetch(`/dj/skills/${editForm.kind}/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as SkillToggleResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      if (Array.isArray(j.skills)) setSkills(j.skills);
      notify.ok(`Saved ${editForm.kind}`);
      setEditing(null);
      setEditForm(null);
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally { setEditBusy(false); }
  };

  const runNow = async (name: string) => {
    setBusy(name);
    try {
      const r = await adminFetch('/dj/skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = (await r.json().catch(() => ({}))) as SkillRunResponse;
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(j.spoken ? `On air: “${j.spoken}”` : `${name} fired`);
    } catch (e) {
      notify.err(`Run failed: ${errorMessage(e)}`);
    } finally { setBusy(null); }
  };

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Skills">
          <div className="text-[13px] text-[var(--danger)]">controller error: {err}</div>
        </Card>
      </div>
    );
  }
  if (!skills) {
    return (
      <div className="grid gap-4">
        <Card title="Skills">
          <div className="text-[13px] text-muted italic">loading…</div>
        </Card>
      </div>
    );
  }

  const enabledCount = skills.filter(s => s.enabled).length;

  return (
    <div className="grid gap-4">
      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="border-b border-ink p-4">
          <Eyebrow className="text-vermilion">skills</Eyebrow>
          <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
            What the DJ does between tracks.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Each skill is an autonomous segment. A skill fires only when it is enabled here
            <strong> and</strong> assigned to the persona on air. Set per-persona assignments
            on the Personas page. “Run now” is an operator override and ignores both.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            The built-in skills are editable too. Hit <strong>Edit</strong> to change a skill&apos;s
            brief, cooldown, or which real-world context (time, weather…) it may mention
            (and, for News, its feed URL). Edits are saved to
            <code> state/skills/&lt;kind&gt;/SKILL.md</code>.
          </div>
          <div className="mt-1 text-[11px] leading-[1.6] text-muted">
            Drop your own skills into <code>state/skills/&lt;name&gt;/SKILL.md</code> and hit
            <strong> Rescan</strong>. Custom skills arrive <strong>disabled</strong>, so review
            them, then enable them before they can air.
          </div>
          <a
            href="/manual/skills"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-[11px] font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
          >
            Read this in the manual ↗
          </a>
        </div>
        <div className="flex items-center gap-4 bg-[var(--ink-softer)] p-3.5">
          <span className="caption">{skills.length} skill{skills.length === 1 ? '' : 's'}</span>
          <span className="caption text-vermilion">{enabledCount} enabled</span>
          <div className="ml-auto">
            <Btn onClick={rescan} disabled={rescanning}>
              {rescanning ? 'Rescanning…' : 'Rescan state/skills'}
            </Btn>
          </div>
        </div>
      </section>

      {/* ── SKILL LIST ───────────────────────────────────────────────────── */}
      {skills.map(s => (
        <Card
          key={s.name}
          title={s.label || s.name}
          sub={s.kind}
          right={
            <>
              {s.custom && <Pill>custom</Pill>}
              <Pill tone={s.enabled ? 'accent' : 'default'} dot={s.enabled}>
                {s.enabled ? 'enabled' : 'disabled'}
              </Pill>
              <Toggle
                on={s.enabled}
                disabled={busy === s.name}
                onClick={() => toggle(s.name, !s.enabled)}
              />
            </>
          }
        >
          {s.ready === false && (
            <div className="mb-3">
              <V3Alert tone="error" title="API key not set">
                This skill needs the <code>{s.requiresKey || 'required API key'}</code> environment
                variable set in <code>.env</code>. Until then it stays inert and never
                fires autonomously, even when enabled.
                {s.keyUrl && (
                  <>
                    {' '}
                    <a
                      href={s.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                    >
                      Get a key here
                    </a>.
                  </>
                )}
              </V3Alert>
            </div>
          )}
          <div className="grid grid-cols-[1fr_auto] items-center gap-4">
            <div>
              <div className="text-[12px] leading-[1.6] text-muted">
                <SkillDescription text={s.description} keyUrl={s.keyUrl} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Pill className="text-[8px]">{cooldownLabel(s.cooldownMs)}</Pill>
                <Pill className="text-[8px]">kind · {s.kind}</Pill>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Btn
                tone="accent"
                onClick={() => runNow(s.name)}
                disabled={busy === s.name}
              >
                {busy === s.name ? 'Working…' : 'Run now'}
              </Btn>
              {/* Built-in skills are editable in place; custom skills are edited
                  on disk + Rescan, so no Edit button for them. */}
              {!s.custom && (
                <Btn
                  onClick={() => openEdit(s.kind || s.name)}
                  disabled={editBusy && editing === (s.kind || s.name)}
                >
                  {editing === (s.kind || s.name) ? 'Close' : 'Edit'}
                </Btn>
              )}
            </div>
          </div>

          {/* ── INLINE EDIT FORM ──────────────────────────────────────────── */}
          {editing === (s.kind || s.name) && (
            <div className="mt-3 border-t border-ink pt-3">
              {!editForm ? (
                <div className="text-[12px] text-muted italic">loading…</div>
              ) : (
                <div className="grid gap-3">
                  {editForm.isNews && (
                    <>
                      <label className="grid gap-1">
                        <span className="caption">Feed URL (RSS 2.0)</span>
                        <input
                          type="url"
                          value={editForm.feed}
                          onChange={e => setEditForm({ ...editForm, feed: e.target.value })}
                          placeholder="https://…/rss.xml"
                          className="border border-ink bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-vermilion"
                        />
                      </label>
                      <label className="grid gap-1">
                        <span className="caption">Max items to scan</span>
                        <input
                          type="number"
                          min={1}
                          value={editForm.feedMaxItems}
                          onChange={e => setEditForm({ ...editForm, feedMaxItems: e.target.value })}
                          placeholder="10"
                          className="w-28 border border-ink bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-vermilion"
                        />
                      </label>
                    </>
                  )}
                  <label className="grid gap-1">
                    <span className="caption">Cooldown</span>
                    <input
                      type="text"
                      value={editForm.cooldown}
                      onChange={e => setEditForm({ ...editForm, cooldown: e.target.value })}
                      placeholder="45m"
                      className="w-28 border border-ink bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-vermilion"
                    />
                    <span className="text-[10px] text-muted">e.g. <code>45m</code>, <code>6h</code>, <code>2d</code>, or a bare number (minutes)</span>
                  </label>
                  <div className="grid gap-1">
                    <span className="caption">Context this segment may mention</span>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {editForm.knownContext.map(field => {
                        const checked = editForm.context.includes(field);
                        return (
                          <label key={field} className="flex items-center gap-1.5 text-[12px]">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setEditForm({
                                ...editForm,
                                context: checked
                                  ? editForm.context.filter(f => f !== field)
                                  : [...editForm.context, field],
                              })}
                              className="accent-vermilion"
                            />
                            {CONTEXT_FIELD_LABELS[field] || field}
                          </label>
                        );
                      })}
                    </div>
                    <span className="text-[10px] text-muted">
                      Tick only what&apos;s topical for this segment. Leaving <strong>Weather</strong> off keeps it
                      out of the prompt, so the DJ stops mentioning it on every break.
                    </span>
                  </div>
                  <label className="grid gap-1">
                    <span className="caption">Brief (what the DJ says, and when to stay silent)</span>
                    <textarea
                      rows={4}
                      value={editForm.brief}
                      onChange={e => setEditForm({ ...editForm, brief: e.target.value })}
                      className="border border-ink bg-transparent px-2 py-1.5 text-[12px] leading-[1.5] outline-none focus:border-vermilion"
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    <Btn tone="accent" onClick={saveEdit} disabled={editBusy || !editForm.brief.trim()}>
                      {editBusy ? 'Saving…' : 'Save'}
                    </Btn>
                    <Btn onClick={() => { setEditing(null); setEditForm(null); }} disabled={editBusy}>
                      Cancel
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
