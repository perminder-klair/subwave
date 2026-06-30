'use client';

// Skill Edit Card — the "segment sheet" editor, shown as a modal over
// /admin/skills. Implements the claude.ai/design "Skill Edit Card" redesign:
// a newspaper-styled sheet with a masthead (name, kind, status toggle), a body
// (cooldown presets + input, optional window, optional news feed, a context
// chip bank, the brief) and a transport bar (Save / Cancel / Run now / Close).
//
// One component serves three jobs:
//   • create a custom (prompt-only) skill  → POST /dj/skills
//   • edit an existing custom skill        → PUT  /dj/skills/:slug/file
//   • edit a built-in skill (incl. News)   → PUT  /dj/skills/:kind/file
// The controller is the validation gate; this form does light client checks.
//
// The on/off toggle and Run now are LIVE operator actions (toggle hits
// /dj/skill-toggle, run hits /dj/skill) — they don't participate in the
// Save/dirty flow, which only writes the SKILL.md file fields.
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { notify, errorMessage } from '../../../lib/notify';
import { useAdminAuth } from '../../../lib/adminAuth';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { CONTEXT_FIELD_LABELS, CONTEXT_FIELDS_FALLBACK, splitContext } from './contextFields';

// Minimal shape of a catalogue skill (from GET /dj/skills) — only what the
// modal needs. The full list type lives in SkillsPanel.
export interface SkillLike {
  name: string;
  kind?: string;
  label?: string;
  custom?: boolean;
  enabled?: boolean;
  cooldownMs?: number;
}

interface SkillEditModalProps {
  mode: 'create' | 'edit';
  skill?: SkillLike;                 // required in edit mode
  onClose: () => void;
  onSkillsChange: (skills: SkillLike[]) => void;  // refresh the panel list after any mutation
}

// The shipped defaults for a built-in (read from the image template), used to
// gate the "Reset to default" button. The reset itself is server-side.
interface SkillDefaults {
  label?: string;
  cooldown?: string;
  context?: string;
  feed?: string;
  feedMaxItems?: number;
  brief?: string;
}

// GET /dj/skills/:kind/file — covers built-in and custom responses.
interface SkillFileResponse {
  kind: string;
  custom?: boolean;
  isNews?: boolean;
  label?: string;
  cooldown?: string;
  context?: string;
  knownContextFields?: string[];
  window?: 'any' | 'commute';
  requiresKey?: string;
  hasTool?: boolean;
  feed?: string | null;
  feedMaxItems?: number | null;
  brief?: string;
  defaults?: SkillDefaults | null;
  error?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
const COOLDOWN_PRESETS = ['15m', '25m', '45m', '1h', '6h'];

// The mutable file fields — snapshotted so we can compute "dirty" and revert.
interface FileFields {
  label: string;
  cooldown: string;
  context: string[];
  window: 'any' | 'commute';
  feed: string;
  feedMaxItems: string;
  brief: string;
}

function emptyFields(): FileFields {
  return { label: '', cooldown: '', context: [], window: 'any', feed: '', feedMaxItems: '', brief: '' };
}

// Order-independent comparison key for the tracked fields.
function fieldsKey(f: FileFields): string {
  return JSON.stringify({ ...f, context: [...f.context].sort() });
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function SkillEditModal({ mode, skill, onClose, onSkillsChange }: SkillEditModalProps) {
  const { adminFetch } = useAdminAuth();

  const isEdit = mode === 'edit';
  // File id for GET/PUT — the kind (built-in) or slug (custom). For toggle/run/
  // delete the controller keys off the skill name.
  const fileId = skill ? (skill.kind || skill.name) : '';

  const [loaded, setLoaded] = useState(!isEdit);   // create starts ready
  const [name, setName] = useState('');            // slug — create only
  const [kind, setKind] = useState(skill?.kind || skill?.name || '');
  const [custom, setCustom] = useState(mode === 'create' ? true : !!skill?.custom);
  const [isNews, setIsNews] = useState(false);
  const [hasTool, setHasTool] = useState(false);
  const [requiresKey, setRequiresKey] = useState('');   // hidden passthrough
  const [knownContext, setKnownContext] = useState<string[]>(CONTEXT_FIELDS_FALLBACK);

  const [fields, setFields] = useState<FileFields>(emptyFields());
  const [snapshot, setSnapshot] = useState<string>(fieldsKey(emptyFields()));

  const [enabled, setEnabled] = useState(!!skill?.enabled);
  const [busy, setBusy] = useState(false);          // saving / creating
  const [acting, setActing] = useState(false);      // toggle / run in flight
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);  // delete confirm dialog
  const [defaults, setDefaults] = useState<SkillDefaults | null>(null); // built-in shipped defaults

  const patch = (p: Partial<FileFields>) => setFields(f => ({ ...f, ...p }));

  const flashFor = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(cur => (cur === msg ? null : cur)), 2000);
  };

  // ── Prefill (edit) ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isEdit || !fileId) return;
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const r = await adminFetch(`/dj/skills/${fileId}/file`);
        const j = (await r.json().catch(() => ({}))) as SkillFileResponse;
        if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
        if (cancelled) return;
        const next: FileFields = {
          label: j.label || '',
          cooldown: j.cooldown || '',
          context: splitContext(j.context),
          window: j.window === 'commute' ? 'commute' : 'any',
          feed: j.feed || '',
          feedMaxItems: j.feedMaxItems != null ? String(j.feedMaxItems) : '',
          brief: j.brief || '',
        };
        setFields(next);
        setSnapshot(fieldsKey(next));
        setKind(j.kind || fileId);
        setCustom(!!j.custom);
        setIsNews(!!j.isNews);
        setHasTool(!!j.hasTool);
        setRequiresKey(j.requiresKey || '');
        setDefaults(j.defaults || null);
        setKnownContext(
          Array.isArray(j.knownContextFields) && j.knownContextFields.length
            ? j.knownContextFields
            : CONTEXT_FIELDS_FALLBACK,
        );
        setLoaded(true);
      } catch (e) {
        if (cancelled) return;
        notify.err(`Couldn't load skill: ${errorMessage(e)}`);
        onClose();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, fileId, adminFetch]);

  // ── Escape to close ───────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = loaded && fieldsKey(fields) !== snapshot;
  const nameValid = !isEdit ? SLUG_RE.test(name) : true;
  const canSave = loaded && !!fields.brief.trim() && nameValid && !busy;

  // Display name in the masthead: the label, falling back to the slug/kind.
  const displayName = fields.label || (isEdit ? titleCase(kind) : (name ? titleCase(name) : 'New skill'));

  // ── Actions ───────────────────────────────────────────────────────────────
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        label: fields.label.trim() || undefined,
        cooldown: fields.cooldown.trim() || undefined,
        context: fields.context,                 // [] resets to the default profile
        brief: fields.brief,
      };
      if (custom) {
        body.window = fields.window;
        if (requiresKey) body.requiresKey = requiresKey;  // preserve disk-authored gate
      }
      if (isNews) {
        body.feed = fields.feed.trim() || undefined;
        if (fields.feedMaxItems.trim()) body.feedMaxItems = fields.feedMaxItems.trim();
      }

      let r: Response;
      if (mode === 'create') {
        body.name = name.trim().toLowerCase();
        r = await adminFetch('/dj/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        r = await adminFetch(`/dj/skills/${fileId}/file`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      const j = (await r.json().catch(() => ({}))) as { skills?: SkillLike[]; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      onSkillsChange(Array.isArray(j.skills) ? j.skills : []);

      if (mode === 'create') {
        notify.ok(`Created “${name}” — disabled until you enable it`);
        onClose();
      } else {
        setSnapshot(fieldsKey(fields));   // edits are now the saved baseline
        flashFor('SAVED TO BOOTH');
      }
    } catch (e) {
      notify.err(`${mode === 'create' ? 'Create' : 'Save'} failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (!isEdit || !skill) return;
    setActing(true);
    const next = !enabled;
    try {
      const r = await adminFetch('/dj/skill-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill.name, on: next }),
      });
      const j = (await r.json().catch(() => ({}))) as { skills?: SkillLike[]; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setEnabled(next);
      onSkillsChange(Array.isArray(j.skills) ? j.skills : []);
      flashFor(next ? 'ON AIR' : 'OFF AIR');
    } catch (e) {
      notify.err(`Toggle failed: ${errorMessage(e)}`);
    } finally { setActing(false); }
  };

  const run = async () => {
    if (!isEdit || !skill) return;
    setActing(true);
    try {
      const r = await adminFetch('/dj/skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill.name }),
      });
      const j = (await r.json().catch(() => ({}))) as { spoken?: string; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      flashFor('QUEUED TO BOOTH');
      if (j.spoken) notify.ok(`On air: “${j.spoken}”`);
    } catch (e) {
      notify.err(`Run failed: ${errorMessage(e)}`);
    } finally { setActing(false); }
  };

  // Delete a custom skill (its whole state/skills/<slug>/ folder), then close.
  // Confirmation is the V3AlertDialog below (driven by confirmDelete), not a
  // native window.confirm.
  const remove = async () => {
    if (!isEdit || !skill) return;
    setConfirmDelete(false);
    setActing(true);
    try {
      const r = await adminFetch(`/dj/skills/${skill.name}`, { method: 'DELETE' });
      const j = (await r.json().catch(() => ({}))) as { skills?: SkillLike[]; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      onSkillsChange(Array.isArray(j.skills) ? j.skills : []);
      notify.ok(`Deleted “${skill.name}”`);
      onClose();
    } catch (e) {
      notify.err(`Delete failed: ${errorMessage(e)}`);
      setActing(false);
    }
  };

  // Restore a built-in to its shipped default. Server-side and immediate: POST
  // overwrites BOTH the SKILL.md AND the tool.mjs in state/skills/<kind>/ from the
  // image template (an in-form repopulate couldn't restore the code). We then
  // refetch the now-restored SKILL.md so the form mirrors the shipped values, and
  // refresh the catalogue.
  const resetToDefault = async () => {
    if (custom || !isEdit || busy) return;
    setBusy(true);
    try {
      const r = await adminFetch(`/dj/skills/${fileId}/reset`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { skills?: SkillLike[]; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      onSkillsChange(Array.isArray(j.skills) ? j.skills : []);

      const fr = await adminFetch(`/dj/skills/${fileId}/file`);
      const fj = (await fr.json().catch(() => ({}))) as SkillFileResponse;
      if (fr.ok) {
        const next: FileFields = {
          label: fj.label || '',
          cooldown: fj.cooldown || '',
          context: splitContext(fj.context),
          window: fj.window === 'commute' ? 'commute' : 'any',
          feed: fj.feed || '',
          feedMaxItems: fj.feedMaxItems != null ? String(fj.feedMaxItems) : '',
          brief: fj.brief || '',
        };
        setFields(next);
        setSnapshot(fieldsKey(next));
        setHasTool(!!fj.hasTool);
      }
      flashFor('RESET TO SHIPPED DEFAULT');
      notify.ok(`Reset “${kind}” to default`);
    } catch (e) {
      notify.err(`Reset failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // ── Style helpers (mirror the design, using our theme vars) ─────────────────
  const I = 'var(--ink)';
  const sectionLabel: CSSProperties = {
    fontSize: 11, letterSpacing: '0.22em', textTransform: 'uppercase', fontWeight: 700, color: I,
  };
  const trans = 'all .12s cubic-bezier(.2,.7,.2,1)';

  const presetStyle = (active: boolean, i: number): CSSProperties => ({
    padding: '9px 16px', cursor: 'pointer', fontSize: 10, fontWeight: 700, letterSpacing: '0.18em',
    textTransform: 'uppercase', fontVariantNumeric: 'tabular-nums', transition: trans,
    border: '1px solid var(--ink)', marginLeft: i === 0 ? 0 : -1,
    background: active ? 'var(--ink)' : 'transparent', color: active ? 'var(--bg)' : 'var(--ink)',
  });
  const chipStyle = (on: boolean): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 10, padding: '9px 14px', cursor: 'pointer',
    userSelect: 'none', whiteSpace: 'nowrap', fontSize: 13, letterSpacing: '0.01em', transition: trans,
    border: `1px solid ${on ? 'var(--ink)' : 'color-mix(in oklab, var(--ink) 22%, transparent)'}`,
    background: on ? 'var(--ink)' : 'transparent', color: on ? 'var(--bg)' : 'var(--muted)',
    fontWeight: on ? 600 : 500,
  });
  const markStyle = (on: boolean): CSSProperties => ({
    width: 9, height: 9, flex: 'none', transition: trans,
    background: on ? 'var(--accent)' : 'transparent',
    border: `1px solid ${on ? 'var(--accent)' : 'color-mix(in oklab, var(--ink) 35%, transparent)'}`,
  });
  const inputBase: CSSProperties = {
    border: '1px solid var(--ink)', background: 'var(--field)', color: 'var(--ink)',
  };

  return (
    <div
      onClick={onClose}
      style={{
        // z-30: above admin chrome (≤ z-20), below the V3AlertDialog (overlay
        // z-40 / content z-50) so the delete confirm layers on top of this sheet.
        position: 'fixed', inset: 0, zIndex: 30, display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', padding: '40px 16px', overflowY: 'auto',
        background: 'color-mix(in oklab, var(--ink) 55%, transparent)',
        backdropFilter: 'blur(2px)',
      }}
    >
      {/* The pseudo-elements + keyframes this sheet relies on live in
          globals.css under the `.sw-seg` / `sw-*` names (kept out of JS to
          avoid dangerouslySetInnerHTML). */}
      <div
        className="sw-seg"
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(1000px,100%)', position: 'relative', border: '1px solid var(--ink)', background: 'var(--bg)' }}
      >
        {/* Masthead */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 28, padding: '16px 30px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
            <div style={{ minWidth: 0 }}>
              {/* Editable skill name (label) */}
              <input
                className="sw-title"
                value={fields.label}
                onChange={e => patch({ label: e.target.value })}
                placeholder={displayName}
                style={{
                  ...inputBase, background: 'transparent', border: 'none', borderBottom: '1px solid transparent',
                  fontSize: 24, lineHeight: 1.1, letterSpacing: '-0.01em', fontWeight: 800,
                  padding: '2px 0', width: '100%', minWidth: 0,
                }}
              />
              {mode === 'create' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>SLUG</span>
                    <input
                      value={name}
                      onChange={e => setName(e.target.value.toLowerCase())}
                      placeholder="moon-phase"
                      style={{
                        ...inputBase, padding: '6px 10px', fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', width: 180,
                        borderColor: name && !nameValid ? 'var(--accent)' : 'var(--ink)',
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* Segment tag + on-air toggle — one slim row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>
            <span style={{ fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
              {custom ? 'CUSTOM SEGMENT' : 'BUILT-IN SEGMENT'}
            </span>
            {isEdit && (
              <div
                onClick={() => { if (!acting) toggleEnabled(); }}
                title={enabled ? 'On air — click to take off air' : 'Off air — click to put on air'}
                style={{ position: 'relative', width: 62, height: 30, border: '1px solid var(--ink)', flex: 'none', cursor: acting ? 'wait' : 'pointer', transition: 'background .15s cubic-bezier(.2,.7,.2,1)', background: enabled ? 'var(--ink)' : 'transparent', opacity: acting ? 0.6 : 1 }}
              >
                <div style={{ position: 'absolute', top: 2, left: 2, width: 24, height: 24, transition: 'transform .18s cubic-bezier(.2,.7,.2,1)', background: enabled ? 'var(--bg)' : 'var(--ink)', transform: `translateX(${enabled ? 32 : 0}px)` }} />
              </div>
            )}
          </div>
        </div>

        {/* Double rule */}
        <div style={{ height: 5, borderTop: '1px solid var(--ink)', borderBottom: '1px solid var(--ink)' }} />

        {/* Body */}
        {!loaded ? (
          <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)', fontStyle: 'italic', fontSize: 13 }}>loading…</div>
        ) : (
          <div style={{ padding: 30, opacity: isEdit && !enabled ? 0.6 : 1, transition: 'opacity .2s ease' }}>

            {/* Cooldown */}
            <div style={{ marginBottom: 34 }}>
              <div style={sectionLabel}>COOLDOWN — MINIMUM GAP BETWEEN AIRINGS</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginTop: 16 }}>
                <div style={{ display: 'flex' }}>
                  {COOLDOWN_PRESETS.map((v, i) => (
                    <button key={v} type="button" onClick={() => patch({ cooldown: v })} style={presetStyle(fields.cooldown === v, i)}>{v}</button>
                  ))}
                </div>
                <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>OR TYPE</span>
                <input
                  value={fields.cooldown}
                  onChange={e => patch({ cooldown: e.target.value })}
                  placeholder="45m"
                  style={{ ...inputBase, width: 128, padding: '11px 15px', fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' }}
                />
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, letterSpacing: '0.01em' }}>e.g. 45m, 6h, 2d, or a bare number (minutes).</div>
            </div>

            {/* Window — custom skills only (built-in window isn't editable) */}
            {custom && (
              <div style={{ marginBottom: 34 }}>
                <div style={sectionLabel}>WHEN IT CAN AIR</div>
                <div style={{ display: 'flex', marginTop: 16 }}>
                  {([['any', 'ANY TIME'], ['commute', 'COMMUTE ONLY']] as const).map(([w, lbl], i) => (
                    <button key={w} type="button" onClick={() => patch({ window: w })} style={presetStyle(fields.window === w, i)}>{lbl}</button>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>Commute-only restricts this segment to the morning and evening commute hours.</div>
              </div>
            )}

            {/* News feed — news built-in only */}
            {isNews && (
              <div style={{ marginBottom: 34 }}>
                <div style={sectionLabel}>NEWS FEED — RSS 2.0</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 16 }}>
                  <input
                    type="url"
                    value={fields.feed}
                    onChange={e => patch({ feed: e.target.value })}
                    placeholder="https://…/rss.xml"
                    style={{ ...inputBase, flex: '1 1 320px', minWidth: 0, padding: '11px 15px', fontSize: 14 }}
                  />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>MAX ITEMS</span>
                    <input
                      type="number"
                      min={1}
                      value={fields.feedMaxItems}
                      onChange={e => patch({ feedMaxItems: e.target.value })}
                      placeholder="10"
                      style={{ ...inputBase, width: 90, padding: '11px 12px', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}
                    />
                  </label>
                </div>
              </div>
            )}

            {/* Context bank */}
            <div style={{ marginBottom: 34 }}>
              <div style={sectionLabel}>CONTEXT THE DJ MAY MENTION</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
                {knownContext.map(field => {
                  const on = fields.context.includes(field);
                  return (
                    <button
                      key={field}
                      type="button"
                      onClick={() => patch({ context: on ? fields.context.filter(f => f !== field) : [...fields.context, field] })}
                      style={chipStyle(on)}
                    >
                      <span style={markStyle(on)} />
                      <span>{CONTEXT_FIELD_LABELS[field] || field}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.6, maxWidth: '78ch' }}>
                Switch on only what&apos;s topical for this segment. A context left dark stays out of the prompt — so the DJ stops working it into every break.
              </div>
            </div>

            {/* Brief */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={sectionLabel}>THE BRIEF — WHAT THE DJ SAYS, AND WHEN TO STAY SILENT</div>
                {/* Built-ins revert to their shipped default — restores both the
                    brief (SKILL.md) and the data tool (tool.mjs) from the image. */}
                {!custom && defaults && (
                  <button
                    type="button"
                    onClick={resetToDefault}
                    disabled={busy}
                    className="sw-ghost"
                    title="Restore this built-in's shipped SKILL.md and tool.mjs from the image"
                    style={{ flex: 'none', padding: '6px 12px', background: 'transparent', color: 'var(--muted)', border: '1px solid color-mix(in oklab, var(--ink) 24%, transparent)', fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
                  >
                    ↺ Reset to default
                  </button>
                )}
              </div>
              <p className="sw-dropcap" style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--muted)', margin: '14px 0', maxWidth: '74ch' }}>
                Write it the way the DJ would read it on air. One or two lines, in character — and say plainly when the segment is better left unaired.
              </p>
              <textarea
                value={fields.brief}
                onChange={e => patch({ brief: e.target.value })}
                rows={7}
                placeholder="What should the DJ say — and when should it stay quiet?"
                style={{ ...inputBase, width: '100%', boxSizing: 'border-box', minHeight: 200, borderLeft: '3px solid var(--accent)', padding: '16px 18px', fontSize: 15, lineHeight: 1.7, resize: 'vertical' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                <span style={{ fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>DJ VOICE · IN CHARACTER</span>
                <span style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fields.brief.length} CHARS</span>
              </div>
              {hasTool && (
                <div style={{ marginTop: 14, border: '1px solid color-mix(in oklab, var(--ink) 24%, transparent)', borderLeft: '3px solid var(--accent)', padding: '12px 14px', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
                  A <code>tool.mjs</code> data fetcher is attached and runs each tick before the DJ speaks. Edit it on disk in <code>state/skills/{kind}/</code> + Rescan — it isn&apos;t editable here.{custom ? ' Deleting the skill removes it too.' : ' Use ↺ Reset to default to restore the shipped version.'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Transport / actions — Run now (left), Close + Save (right) */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '18px 30px', borderTop: '1px solid var(--ink)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isEdit && (
              <button
                type="button"
                onClick={run}
                disabled={acting}
                style={{ padding: '13px 26px', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', transition: 'transform .1s', border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: acting ? 'wait' : 'pointer', opacity: acting ? 0.7 : 1 }}
              >
                ▸ RUN NOW
              </button>
            )}
            {isEdit && custom && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={acting}
                className="sw-ghost"
                style={{ padding: '13px 22px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: acting ? 'wait' : 'pointer', opacity: acting ? 0.7 : 1 }}
              >
                DELETE
              </button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {dirty && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 700 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />UNSAVED EDITS
              </span>
            )}
            {flash && (
              <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 700, animation: 'sw-blink 1s steps(1) infinite' }}>✓ {flash}</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="sw-ghost"
              style={{ padding: '13px 22px', background: 'transparent', color: 'var(--muted)', border: '1px solid color-mix(in oklab, var(--ink) 24%, transparent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer' }}
            >
              CLOSE
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              style={{ padding: '13px 26px', background: canSave ? 'var(--ink)' : 'color-mix(in oklab, var(--ink) 20%, transparent)', color: 'var(--bg)', border: '1px solid var(--ink)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: canSave ? 'pointer' : 'not-allowed' }}
            >
              {busy ? (mode === 'create' ? 'CREATING…' : 'SAVING…') : (mode === 'create' ? 'CREATE' : 'SAVE')}
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirm — the shared V3AlertDialog (same as Dash's skip-track
          prompt). Portals above this sheet (sheet is z-30, dialog content z-50). */}
      <V3AlertDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete skill"
        description={`Delete the “${skill?.name ?? ''}” skill? This removes state/skills/${skill?.name ?? ''}/ from disk and can't be undone.`}
        confirmLabel="delete skill"
        danger
        onConfirm={remove}
      />
    </div>
  );
}
