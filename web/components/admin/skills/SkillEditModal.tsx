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
import { EditorDialog } from '../../ui/editor-dialog';
import { SkeletonForm } from '@/components/ui/skeleton';
import { Eyebrow } from '../ui';
import { CONTEXT_FIELD_LABELS, CONTEXT_FIELDS_FALLBACK, splitContext } from './contextFields';
import { skillSubmitUrl } from '../../../lib/repo';

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

// Slim persona shape from GET /settings — enough for the DJ assignment
// checklist. `skills: null` is the "all skills" sentinel (see controller
// settings.ts:validatePersonasStrict).
export interface PersonaLite {
  id: string;
  name: string;
  skills: string[] | null;
}

interface SkillEditModalProps {
  mode: 'create' | 'edit';
  skill?: SkillLike;                 // required in edit mode
  personas?: PersonaLite[];          // roster for the DJ assignment checklist
  tagSuggestions?: string[];         // tags already used elsewhere in the catalog
  onClose: () => void;
  onSkillsChange: (skills: SkillLike[]) => void;  // refresh the panel list after any mutation
  onRosterChange?: () => void;       // re-fetch personas after assignments change
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
  tags?: string[];
  brief?: string;
  defaults?: SkillDefaults | null;
  error?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
const COOLDOWN_PRESETS = ['15m', '25m', '45m', '1h', '6h'];
// Mirror the controller's tag rules (skills/loader.ts TAG_RE / limit) so a bad
// tag fails here instead of on save.
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const TAGS_MAX = 8;

// The mutable file fields — snapshotted so we can compute "dirty" and revert.
interface FileFields {
  label: string;
  cooldown: string;
  context: string[];
  window: 'any' | 'commute';
  feed: string;
  feedMaxItems: string;
  tags: string[];
  brief: string;
}

function emptyFields(): FileFields {
  return { label: '', cooldown: '', context: [], window: 'any', feed: '', feedMaxItems: '', tags: [], brief: '' };
}

// Order-independent comparison key for the tracked fields. Tags keep their
// order (they're an authored list, not a set) — only context is order-free.
function fieldsKey(f: FileFields): string {
  return JSON.stringify({ ...f, context: [...f.context].sort() });
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function SkillEditModal({ mode, skill, personas, tagSuggestions, onClose, onSkillsChange, onRosterChange }: SkillEditModalProps) {
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
  const [tagDraft, setTagDraft] = useState('');   // the tag input's in-progress text

  // DJ assignment — which personas run this skill. Seeded from the roster at
  // mount (a `skills: null` persona runs everything); saved via
  // PUT /dj/skills/:slug/personas alongside (after) the file save.
  const roster = personas || [];
  const initialAssigned = () => (skill
    ? roster.filter(p => p.skills === null || p.skills.includes(skill.name)).map(p => p.id)
    : []);
  const [assigned, setAssigned] = useState<string[]>(initialAssigned);
  const [assignSnapshot, setAssignSnapshot] = useState<string>(() => JSON.stringify([...initialAssigned()].sort()));

  const [enabled, setEnabled] = useState(!!skill?.enabled);
  const [busy, setBusy] = useState(false);          // saving / creating
  const [acting, setActing] = useState(false);      // toggle / run in flight
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);  // delete confirm dialog
  const [defaults, setDefaults] = useState<SkillDefaults | null>(null); // built-in shipped defaults

  const patch = (p: Partial<FileFields>) => setFields(f => ({ ...f, ...p }));

  // Commit the tag input's draft (Enter / comma / blur). Mirrors the
  // controller's rules so a bad tag fails here, loudly, before save.
  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    if (!TAG_RE.test(tag)) {
      notify.err(`"${tag}" isn't a valid tag — lowercase letters, digits, hyphens, max 24 chars`);
      return;
    }
    setFields(f => {
      if (f.tags.includes(tag)) return f;
      if (f.tags.length >= TAGS_MAX) {
        notify.err(`At most ${TAGS_MAX} tags per skill`);
        return f;
      }
      return { ...f, tags: [...f.tags, tag] };
    });
    setTagDraft('');
  };

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
          tags: Array.isArray(j.tags) ? j.tags : [],
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

  // Escape-to-close and body scroll-lock are handled by EditorDialog (Radix
  // Dialog) — no manual key listener, so the nested delete confirm gets escape
  // first and the page behind stays locked.

  const assignDirty = isEdit && JSON.stringify([...assigned].sort()) !== assignSnapshot;
  const dirty = loaded && (fieldsKey(fields) !== snapshot || assignDirty);
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
        tags: fields.tags,                       // [] clears the tags line
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
        // DJ assignments save as a separate resource (personas[].skills). The
        // file save above already stood — a failure here reports on its own.
        if (assignDirty && skill) {
          try {
            const ar = await adminFetch(`/dj/skills/${skill.name}/personas`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ personaIds: assigned }),
            });
            const aj = (await ar.json().catch(() => ({}))) as { error?: string };
            if (!ar.ok) throw new Error(aj.error || `failed (${ar.status})`);
            setAssignSnapshot(JSON.stringify([...assigned].sort()));
            onRosterChange?.();
          } catch (e) {
            notify.err(`Skill saved, but updating DJ assignments failed: ${errorMessage(e)}`);
          }
        }
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

  // Export this skill as a .zip (SKILL.md + tool.mjs if any). Auth-gated, so we
  // fetch the bytes via adminFetch and trigger the download from the blob — a
  // plain <a href> can't carry the Basic-auth header.
  const exportZip = async () => {
    try {
      const r = await adminFetch(`/dj/skills/${fileId}/export`);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `failed (${r.status})`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileId}-skill.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify.err(`Export failed: ${errorMessage(e)}`);
    }
  };

  // Share a custom, prompt-only skill to the community: open the prefilled
  // add-skill Issue Form on GitHub in a new tab. A maintainer reviews the
  // generated PR; once merged it ships to everyone as an installable community
  // skill. Only offered for tool-less custom skills — built-ins already ship,
  // and executable tool.mjs skills aren't accepted through this (v1) path.
  const shareToCommunity = () => {
    const url = skillSubmitUrl({
      'skill-name': kind,
      label: fields.label,
      brief: fields.brief,
      cooldown: fields.cooldown,
      context: fields.context.join(', '),
      window: fields.window === 'commute' ? 'commute' : '',
    });
    window.open(url, '_blank', 'noopener,noreferrer');
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
          tags: Array.isArray(fj.tags) ? fj.tags : [],
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

  // ── Header / footer slots for the full-screen EditorDialog ──────────────────
  // Uniform header: a static label + the segment type (the editable name/slug
  // live in the body's first section, matching the other editors).
  const headerTitle = (
    <Eyebrow className="text-vermilion">{isEdit ? 'Edit skill' : 'New skill'}</Eyebrow>
  );
  const headerSub = (
    <span className="caption truncate">{custom ? 'custom segment' : 'built-in segment'}</span>
  );
  // On-air toggle (edit only) — lives in the footer with the other actions so
  // the header stays uniform across all three editors.
  const airToggle = isEdit ? (
    <div
      onClick={() => { if (!acting) toggleEnabled(); }}
      title={enabled ? 'On air — click to take off air' : 'Off air — click to put on air'}
      style={{ position: 'relative', width: 62, height: 30, border: '1px solid var(--ink)', flex: 'none', cursor: acting ? 'wait' : 'pointer', transition: 'background .15s cubic-bezier(.2,.7,.2,1)', background: enabled ? 'var(--ink)' : 'transparent', opacity: acting ? 0.6 : 1 }}
    >
      <div style={{ position: 'absolute', top: 2, left: 2, width: 24, height: 24, transition: 'transform .18s cubic-bezier(.2,.7,.2,1)', background: enabled ? 'var(--bg)' : 'var(--ink)', transform: `translateX(${enabled ? 32 : 0}px)` }} />
    </div>
  ) : null;

  // Transport bar — on-air toggle / Run / Delete on the left, unsaved / flash /
  // Close / Save on the right. Border + padding supplied by EditorDialog's footer.
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {airToggle}
        {isEdit && (
          <button type="button" onClick={run} disabled={acting} style={{ padding: '13px 26px', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', transition: 'transform .1s', border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: acting ? 'wait' : 'pointer', opacity: acting ? 0.7 : 1 }}>
            ▸ RUN NOW
          </button>
        )}
        {isEdit && (
          <button type="button" onClick={exportZip} className="sw-ghost" title="Download this skill as a .zip (SKILL.md + tool.mjs)" style={{ padding: '13px 22px', background: 'transparent', color: 'var(--muted)', border: '1px solid color-mix(in oklab, var(--ink) 24%, transparent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer' }}>
            ↓ EXPORT
          </button>
        )}
        {isEdit && custom && (
          <button type="button" onClick={() => setConfirmDelete(true)} disabled={acting} className="sw-ghost" style={{ padding: '13px 22px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: acting ? 'wait' : 'pointer', opacity: acting ? 0.7 : 1 }}>
            DELETE
          </button>
        )}
        {isEdit && custom && !hasTool && (
          <button type="button" onClick={shareToCommunity} className="sw-ghost" title="Open a prefilled GitHub issue to share this skill with the community" style={{ padding: '13px 22px', background: 'transparent', color: 'var(--muted)', border: '1px solid color-mix(in oklab, var(--ink) 24%, transparent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer' }}>
            ↗ SHARE TO COMMUNITY
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
          <span className="v3-blink" style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 700 }}>✓ {flash}</span>
        )}
        <button type="button" onClick={onClose} className="sw-ghost" style={{ padding: '13px 22px', background: 'transparent', color: 'var(--muted)', border: '1px solid color-mix(in oklab, var(--ink) 24%, transparent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer' }}>
          CLOSE
        </button>
        <button type="button" onClick={save} disabled={!canSave} style={{ padding: '13px 26px', background: canSave ? 'var(--ink)' : 'color-mix(in oklab, var(--ink) 20%, transparent)', color: 'var(--bg)', border: '1px solid var(--ink)', fontSize: 11, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: canSave ? 'pointer' : 'not-allowed' }}>
          {busy ? (mode === 'create' ? 'CREATING…' : 'SAVING…') : (mode === 'create' ? 'CREATE' : 'SAVE')}
        </button>
      </div>
    </div>
  );

  return (
    <EditorDialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={headerTitle}
      sub={headerSub}
      footer={footer}
      className="sw-seg"
    >
      {!loaded ? (
        <SkeletonForm fields={4} />
      ) : (
        <div style={{ opacity: isEdit && !enabled ? 0.6 : 1, transition: 'opacity .2s ease' }}>

            {/* Skill name + slug */}
            <div className="sw-section">
              <div style={sectionLabel}>SKILL NAME</div>
              <input
                value={fields.label}
                onChange={e => patch({ label: e.target.value })}
                placeholder={displayName}
                aria-label="Skill name"
                style={{ ...inputBase, marginTop: 16, padding: '12px 16px', fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em', width: '100%', boxSizing: 'border-box' }}
              />
              {mode === 'create' && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                  <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>SLUG</span>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value.toLowerCase())}
                    placeholder="moon-phase"
                    style={{ ...inputBase, padding: '8px 12px', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', width: 200, borderColor: name && !nameValid ? 'var(--accent)' : 'var(--ink)' }}
                  />
                </label>
              )}
            </div>

            {/* Cooldown */}
            <div className="sw-section">
              <div style={sectionLabel}>COOLDOWN · MINIMUM GAP BETWEEN AIRINGS</div>
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
              <div className="sw-section">
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
              <div className="sw-section">
                <div style={sectionLabel}>NEWS FEED · RSS 2.0</div>
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
            <div className="sw-section">
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
                Switch on only what&apos;s topical for this segment. A context left dark stays out of the prompt, so the DJ stops working it into every break.
              </div>
            </div>

            {/* Tags — freeform organisation labels for the skill list */}
            <div className="sw-section">
              <div style={sectionLabel}>TAGS · ORGANISE THE SKILL LIST</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 16 }}>
                {fields.tags.map(t => (
                  <button
                    key={t}
                    type="button"
                    title={`Remove tag "${t}"`}
                    onClick={() => patch({ tags: fields.tags.filter(x => x !== t) })}
                    style={chipStyle(true)}
                  >
                    <span>#{t}</span>
                    <span aria-hidden>×</span>
                  </button>
                ))}
                <input
                  value={tagDraft}
                  onChange={e => setTagDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addTag(tagDraft);
                    }
                  }}
                  onBlur={() => addTag(tagDraft)}
                  placeholder={fields.tags.length ? 'add tag…' : 'late-night, factual…'}
                  aria-label="Add tag"
                  style={{ ...inputBase, width: 160, padding: '9px 12px', fontSize: 13 }}
                />
              </div>
              {(tagSuggestions || []).filter(t => !fields.tags.includes(t)).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}>
                  <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>IN USE</span>
                  {(tagSuggestions || []).filter(t => !fields.tags.includes(t)).map(t => (
                    <button key={t} type="button" onClick={() => addTag(t)} style={chipStyle(false)}>
                      #{t}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
                Freeform: tag by show, mood, type, whatever helps you filter. Tags travel with the skill when exported or shared.
              </div>
            </div>

            {/* DJ assignment — which personas run this skill (edit only) */}
            {isEdit && roster.length > 0 && (
              <div className="sw-section">
                <div style={sectionLabel}>WHICH DJS RUN IT</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
                  {roster.map(p => {
                    const on = assigned.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setAssigned(cur => (on ? cur.filter(id => id !== p.id) : [...cur, p.id]))}
                        style={chipStyle(on)}
                      >
                        <span style={markStyle(on)} />
                        <span>{p.name}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.6, maxWidth: '78ch' }}>
                  The same assignments as each persona&apos;s Skills card, edited from the skill&apos;s side.
                  A skill fires only for the ticked DJs, and must be enabled station-wide (the on-air toggle below).
                </div>
              </div>
            )}

            {/* Brief */}
            <div className="sw-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={sectionLabel}>THE BRIEF · WHAT THE DJ SAYS, AND WHEN TO STAY SILENT</div>
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
                Write it the way the DJ would read it on air: one or two lines, in character. Say plainly when the segment is better left unaired.
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
                  A <code>tool.mjs</code> data fetcher is attached and runs each tick before the DJ speaks. It isn&apos;t editable here; edit it on disk in <code>state/skills/{kind}/</code>, then Rescan.{custom ? ' Deleting the skill removes it too.' : ' Use ↺ Reset to default to restore the shipped version.'}
                </div>
              )}
            </div>
          </div>
        )}

      {/* Delete confirm — the shared V3AlertDialog. Layers above the
          full-screen EditorDialog (both Radix) and now receives Escape first. */}
      <V3AlertDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete skill"
        description={`Delete the “${skill?.name ?? ''}” skill? This removes state/skills/${skill?.name ?? ''}/ from disk and can't be undone.`}
        confirmLabel="delete skill"
        danger
        onConfirm={remove}
      />
    </EditorDialog>
  );
}
