'use client';

// Skill Edit Card — the segment-sheet editor, shown as a modal over /admin/skills.
//
// One component serves three jobs:
//   • create a custom (prompt-only) skill  → POST /dj/skills
//   • edit an existing custom skill        → PUT  /dj/skills/:slug/file
//   • edit a built-in skill (incl. News)   → PUT  /dj/skills/:kind/file
// The controller is the validation gate; this form does light client checks.
//
// The on/off toggle and Run now are LIVE operator actions (/dj/skill-toggle,
// /dj/skill) — they don't participate in the Save/dirty flow, which only writes
// the SKILL.md file fields.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Controller, useWatch,
  type Control, type DefaultValues, type FieldValues,
} from 'react-hook-form';
import type { z } from 'zod';
import { notify, errorMessage } from '../../../lib/notify';
import { useAdminAuth } from '../../../lib/adminAuth';
import {
  AdminResponseError,
  adminJson,
  adminResponse,
  useAdminMutation,
} from '../../../lib/admin-query';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { EditorDialog, EditorFooter } from '../../ui/editor-dialog';
import { SkeletonForm } from '@/components/ui/skeleton';
import { Eyebrow } from '../ui';
import { CONTEXT_FIELD_LABELS, CONTEXT_FIELDS_FALLBACK, splitContext } from './contextFields';
import type { ContextField } from '@/lib/schemas.generated';
import {
  SKILL_TAG_RE,
  TAGS_PER_SKILL_LIMIT,
  skillCreateSchema,
  skillFileSchema,
} from '@/lib/schemas.generated';
import { skillSubmitUrl } from '../../../lib/repo';
import { useZodForm, applyServerFieldErrors, fieldAria } from '@/lib/form';
import { TextField, TextareaField } from '@/lib/form-fields';
import { Switch } from '@/components/ui/switch';
import {
  skillKeys,
  useSkillFileQuery,
  writeInstalledSkills,
  type SkillConfigField,
  type SkillDefaults,
  type SkillFileResponse,
  type SkillLike,
  type SkillsResponse,
} from './queries';

// Only what this modal needs from GET /dj/skills; the full list type lives in
// SkillsPanel.
export type { SkillLike } from './queries';

// `skills: null` is the "all skills" sentinel (controller
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
}

const COOLDOWN_PRESETS = ['15m', '25m', '45m', '1h', '6h'];

// The RHF-bound shape of the SKILL.md fields. `name` is create-only and rides
// along unused in edit mode. `config` (the skill's own declared knobs) stays
// out: it's runtime data from the skill's tool.mjs, validated separately by
// the controller's skills/config-fields.ts, so it keeps its own useState.
interface SkillFormValues {
  name?: string;
  label: string;
  cooldown: string;
  cron: string;
  cronOnly: boolean;
  cohosts: boolean;
  context: string[];
  tags: string[];
  brief: string;
  window: 'any' | 'commute';
  requiresKey: string;
}

// The skill's current knob values as form strings (the controller sends numbers
// as numbers).
function configValues(j: SkillFileResponse): Record<string, string> {
  return Object.fromEntries(
    Object.entries(j.config || {}).map(([k, v]) => [k, v == null ? '' : String(v)]),
  );
}

// Comparison key for `config` alone — the one file field that stays outside
// the RHF form (see SkillFormValues above) and therefore needs its own
// dirty tracking. A knob the controller reports as unset is ABSENT, so
// typing into an empty field and clearing it again must not read as an
// unsaved change.
function configKey(config: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(config)
        .map(([k, v]) => [k, (v || '').trim()] as const)
        .filter(([, v]) => v)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

// GET /dj/skills/:kind/file → the RHF defaultValues shape. Shared by the load
// effect and Reset to default so the two can't map the response differently.
function fileToFormValues(j: SkillFileResponse) {
  return {
    label: j.label || '',
    cooldown: j.cooldown || '',
    cron: j.cron || '',
    cronOnly: !!j.cronOnly,
    cohosts: !!j.cohosts,
    context: splitContext(j.context),
    window: (j.window === 'commute' ? 'commute' : 'any') as 'any' | 'commute',
    tags: Array.isArray(j.tags) ? j.tags : [],
    brief: j.brief || '',
    requiresKey: j.requiresKey || '',
  };
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function SkillEditModal({ mode, skill, personas, tagSuggestions, onClose }: SkillEditModalProps) {
  const { adminFetch } = useAdminAuth();

  const isEdit = mode === 'edit';
  // File id for GET/PUT — the kind (built-in) or slug (custom). For toggle/run/
  // delete the controller keys off the skill name.
  const fileId = skill ? (skill.kind || skill.name) : '';
  const fileQuery = useSkillFileQuery(adminFetch, fileId, isEdit);

  const [loaded, setLoaded] = useState(!isEdit);   // create starts ready
  const [kind, setKind] = useState(skill?.kind || skill?.name || '');
  const [custom, setCustom] = useState(mode === 'create' ? true : !!skill?.custom);
  const [configFields, setConfigFields] = useState<SkillConfigField[]>([]);
  const [hasTool, setHasTool] = useState(false);
  const [cronInvalid, setCronInvalid] = useState(false);
  const [knownContext, setKnownContext] = useState<string[]>(CONTEXT_FIELDS_FALLBACK);

  // The skill's own declared knobs (news' feed/feedMaxItems, …) — runtime data
  // read off tool.mjs, not part of the shared schema, so it keeps its own
  // state + dirty snapshot outside the RHF form (see SkillFormValues above).
  const [config, setConfig] = useState<Record<string, string>>({});
  const [configSnapshot, setConfigSnapshot] = useState<string>(() => configKey({}));
  const [tagDraft, setTagDraft] = useState('');   // the tag input's in-progress text

  // Seeded from the roster at mount (a `skills: null` persona runs everything);
  // saved via PUT /dj/skills/:slug/personas after the file save.
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

  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  // The same schema the controller runs, so a bad cooldown is caught at the
  // input rather than coming back as a 400. Declared as the widened ZodType
  // rather than the create/edit union: several fields are z.preprocess-wrapped,
  // whose z.input is `unknown`, so the union's input type collapses — handled
  // with one cast on `control` below instead of at every call site.
  const schema: z.ZodType<FieldValues, FieldValues> =
    mode === 'create' ? skillCreateSchema : skillFileSchema(custom);

  const form = useZodForm(
    schema,
    (mode === 'create'
      ? { name: '', label: '', cooldown: '', cron: '', cronOnly: false, cohosts: false, context: [], tags: [], brief: '', window: 'any', requiresKey: '' }
      : { label: '', cooldown: '', cron: '', cronOnly: false, cohosts: false, context: [], tags: [], brief: '', window: 'any', requiresKey: '' }
    ) as DefaultValues<z.input<typeof schema>>,
  );
  const control = form.control as unknown as Control<SkillFormValues>;
  const uid = useId();
  const fileHydratedRef = useRef(false);
  const fileErrorRef = useRef<unknown>(null);

  const applyFile = useCallback((j: SkillFileResponse) => {
    form.reset(fileToFormValues(j) as DefaultValues<z.input<typeof schema>>);
    const cfg = configValues(j);
    setConfig(cfg);
    setConfigSnapshot(configKey(cfg));
    setKind(j.kind || fileId);
    setCustom(!!j.custom);
    setConfigFields(Array.isArray(j.configFields) ? j.configFields : []);
    setHasTool(!!j.hasTool);
    setCronInvalid(!!j.cronInvalid);
    setDefaults(j.defaults || null);
    setKnownContext(
      Array.isArray(j.knownContextFields) && j.knownContextFields.length
        ? j.knownContextFields
        : CONTEXT_FIELDS_FALLBACK,
    );
    setLoaded(true);
  }, [fileId, form]);

  useEffect(() => {
    if (!isEdit || !fileQuery.data || fileHydratedRef.current) return;
    fileHydratedRef.current = true;
    applyFile(fileQuery.data);
  }, [applyFile, fileQuery.data, isEdit]);

  useEffect(() => {
    if (!isEdit || !fileQuery.error || fileErrorRef.current === fileQuery.error) return;
    fileErrorRef.current = fileQuery.error;
    notify.err(`Couldn't load skill: ${errorMessage(fileQuery.error)}`);
    requestClose();
  }, [fileQuery.error, isEdit, requestClose]);

  // `custom` can flip after mount (the file GET below corrects the list row's
  // guess), swapping `schema`. RHF picks up the new resolver on the next render
  // but won't re-run it against already-computed error state — same as
  // MoodsPanel's schedule/weather schema.
  useEffect(() => {
    void form.trigger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const addTag = (raw: string, tags: string[], onChange: (next: string[]) => void) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    if (!SKILL_TAG_RE.test(tag)) {
      notify.err(`"${tag}" isn't a valid tag — lowercase letters, digits, hyphens, max 24 chars`);
      return;
    }
    if (tags.includes(tag)) { setTagDraft(''); return; }
    if (tags.length >= TAGS_PER_SKILL_LIMIT) {
      notify.err(`At most ${TAGS_PER_SKILL_LIMIT} tags per skill`);
      return;
    }
    onChange([...tags, tag]);
    setTagDraft('');
  };

  const flashFor = (msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(cur => (cur === msg ? null : cur)), 2000);
  };

  // Escape-to-close and scroll-lock come from EditorDialog (Radix). No manual key
  // listener: that is what lets the nested delete confirm get Escape first.

  const assignDirty = isEdit && JSON.stringify([...assigned].sort()) !== assignSnapshot;
  const configDirty = configKey(config) !== configSnapshot;
  const dirty = loaded && (form.formState.isDirty || configDirty || assignDirty);

  const canSave = loaded && form.formState.isValid && !busy;
  // Every field has its own inline error slot, so listing them here too would
  // render each message twice. `requiresKey` is the exception: it's a hidden
  // passthrough with no rendered control, so a disk-authored value that isn't
  // UPPER_SNAKE_CASE has nowhere else to surface, and a gated Save would
  // otherwise never say why.
  const FIELDS_WITH_INLINE_ERRORS = ['name', 'label', 'cooldown', 'cron', 'cronOnly', 'cohosts', 'context', 'tags', 'window', 'brief'];
  const blockingIssue = (() => {
    const entry = Object.entries(form.formState.errors).find(
      ([key, err]) => err && !FIELDS_WITH_INLINE_ERRORS.includes(key),
    );
    if (!entry) return null;
    const [field, err] = entry;
    return err?.message ? `${field}: ${err.message}` : null;
  })();

  const labelValue = (useWatch({ control, name: 'label' }) as string | undefined) || '';
  const nameValue = (useWatch({ control, name: 'name' }) as string | undefined) || '';
  const briefValue = (useWatch({ control, name: 'brief' }) as string | undefined) || '';
  const cooldownValue = (useWatch({ control, name: 'cooldown' }) as string | undefined) || '';
  const contextValue = (useWatch({ control, name: 'context' }) as string[] | undefined) || [];
  const windowValue = (useWatch({ control, name: 'window' }) as 'any' | 'commute' | undefined) || 'any';
  const cohostsValue = !!useWatch({ control, name: 'cohosts' });
  const displayName = labelValue || (isEdit ? titleCase(kind) : (nameValue ? titleCase(nameValue) : 'New skill'));

  const saveMutation = useAdminMutation<SkillsResponse, {
    path: string;
    method: 'POST' | 'PUT';
    body: Record<string, unknown>;
    fileId: string | null;
  }>({
    adminFetch,
    request: ({ path, method, body }, fetcher) => adminJson(fetcher, path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    onDone: async (response, vars, client) => {
      writeInstalledSkills(client, response);
      if (vars.fileId) {
        await client.invalidateQueries({
          queryKey: skillKeys.file(vars.fileId), exact: true, refetchType: 'active',
        });
        // The modal hydrates the file exactly once. If the authoritative read
        // failed, do not leave its older successful payload for a quick reopen
        // to consume before the next background attempt settles.
        if (client.getQueryState(skillKeys.file(vars.fileId))?.status === 'error') {
          client.removeQueries({ queryKey: skillKeys.file(vars.fileId), exact: true });
        }
      }
    },
    toastOnError: false,
  });
  const rosterMutation = useAdminMutation<unknown, { slug: string; personaIds: string[] }>({
    adminFetch,
    request: ({ slug, personaIds }, fetcher) => adminJson(
      fetcher,
      `/dj/skills/${encodeURIComponent(slug)}/personas`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaIds }),
      },
    ),
    // The assignment endpoint returns only a roster receipt. Never put that
    // partial response (or a raw /settings POST) in the redacted settings cache.
    onDone: async (_response, _vars, client) => {
      await client.invalidateQueries({ queryKey: skillKeys.roster(), exact: true });
    },
    toastOnError: false,
  });
  const toggleMutation = useAdminMutation<SkillsResponse, { name: string; on: boolean }>({
    adminFetch,
    request: (vars, fetcher) => adminJson(fetcher, '/dj/skill-toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vars),
    }),
    onDone: (response, _vars, client) => writeInstalledSkills(client, response),
    toastOnError: false,
  });
  const removeMutation = useAdminMutation<SkillsResponse, { name: string }>({
    adminFetch,
    request: ({ name }, fetcher) => adminJson(
      fetcher, `/dj/skills/${encodeURIComponent(name)}`, { method: 'DELETE' },
    ),
    onDone: (response, vars, client) => {
      writeInstalledSkills(client, response);
      client.removeQueries({ queryKey: skillKeys.file(vars.name), exact: true });
    },
    toastOnError: false,
  });
  const resetMutation = useAdminMutation<SkillsResponse, { fileId: string }>({
    adminFetch,
    request: ({ fileId: id }, fetcher) => adminJson(
      fetcher, `/dj/skills/${encodeURIComponent(id)}/reset`, { method: 'POST' },
    ),
    onDone: async (response, vars, client) => {
      writeInstalledSkills(client, response);
      await client.invalidateQueries({
        queryKey: skillKeys.file(vars.fileId), exact: true, refetchType: 'none',
      });
    },
    toastOnError: false,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setBusy(true);
    try {
      // `requiresKey` (and, for a custom skill, `window`) ride along in `values`
      // only when the schema in force declares them — a built-in edit's schema
      // doesn't, so zod has already stripped them from the parsed output.
      const body: Record<string, unknown> = { ...values };
      // Always sent when the skill declares knobs, so clearing a field clears
      // the frontmatter line; omitted for a skill with none, which the
      // controller reads as "leave whatever is on disk". Read off the raw body
      // server-side, so it travels outside `values` here too.
      if (configFields.length) {
        body.config = Object.fromEntries(
          configFields.map(f => [f.key, (config[f.key] || '').trim()]),
        );
      }

      await saveMutation.mutateAsync({
        path: mode === 'create' ? '/dj/skills' : `/dj/skills/${encodeURIComponent(fileId)}/file`,
        method: mode === 'create' ? 'POST' : 'PUT',
        body,
        fileId: mode === 'create' ? null : fileId,
      });

      if (mode === 'create') {
        notify.ok(`Created "${values.name}" — disabled until you enable it`);
        onClose();
      } else {
        form.reset(values as DefaultValues<z.input<typeof schema>>);   // edits are now the saved baseline
        setConfigSnapshot(configKey(config));
        // A separate resource (personas[].skills): the file save above already
        // stood, so a failure here reports on its own.
        if (assignDirty && skill) {
          try {
            await rosterMutation.mutateAsync({ slug: skill.name, personaIds: assigned });
            setAssignSnapshot(JSON.stringify([...assigned].sort()));
          } catch (e) {
            notify.err(`Skill saved, but updating DJ assignments failed: ${errorMessage(e)}`);
          }
        }
        flashFor('SAVED TO BOOTH');
      }
    } catch (e) {
      if (e instanceof AdminResponseError) applyServerFieldErrors(form, e.body.fieldErrors);
      notify.err(`${mode === 'create' ? 'Create' : 'Save'} failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  });

  const toggleEnabled = async () => {
    if (!isEdit || !skill) return;
    setActing(true);
    const next = !enabled;
    try {
      await toggleMutation.mutateAsync({ name: skill.name, on: next });
      setEnabled(next);
      flashFor(next ? 'ON AIR' : 'OFF AIR');
    } catch (e) {
      notify.err(`Toggle failed: ${errorMessage(e)}`);
    } finally { setActing(false); }
  };

  const run = async () => {
    if (!isEdit || !skill) return;
    setActing(true);
    try {
      const r = await adminResponse(adminFetch, '/dj/skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill.name }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        spoken?: string | null; aired?: boolean; reason?: string | null; error?: string;
      };
      // The skill can run and decide it has nothing usable to speak from — a
      // 200 with `aired: false` (issue #1412). Flashing "QUEUED TO BOOTH" at
      // that would tell the operator something aired when nothing did.
      if (j.aired === false) {
        flashFor('STOOD DOWN');
        notify.info(`${skill.name} stayed silent — ${j.reason || 'nothing usable to speak from'}`);
      } else {
        flashFor('QUEUED TO BOOTH');
        if (j.spoken) notify.ok(`On air: “${j.spoken}”`);
      }
    } catch (e) {
      notify.err(`Run failed: ${errorMessage(e)}`);
    } finally { setActing(false); }
  };

  // Deletes the whole state/skills/<slug>/ folder.
  const remove = async () => {
    if (!isEdit || !skill) return;
    setConfirmDelete(false);
    setActing(true);
    try {
      await removeMutation.mutateAsync({ name: skill.name });
      notify.ok(`Deleted “${skill.name}”`);
      onClose();
    } catch (e) {
      notify.err(`Delete failed: ${errorMessage(e)}`);
      setActing(false);
    }
  };

  // The download goes through adminFetch + a blob because a plain <a href> can't
  // carry the Basic-auth header.
  const exportZip = async () => {
    try {
      // admin-query-imperative: skill-export
      const r = await adminResponse(adminFetch, `/dj/skills/${encodeURIComponent(fileId)}/export`);
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

  // Opens the prefilled add-skill Issue Form on GitHub. Only offered for tool-less
  // custom skills — built-ins already ship, and executable tool.mjs skills aren't
  // accepted through this path.
  const shareToCommunity = () => {
    const url = skillSubmitUrl({
      'skill-name': kind,
      label: labelValue,
      brief: briefValue,
      cooldown: cooldownValue,
      context: contextValue.join(', '),
      window: windowValue === 'commute' ? 'commute' : '',
      cohosts: cohostsValue ? 'true' : '',
    });
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Server-side and immediate: the POST overwrites BOTH the SKILL.md AND the
  // tool.mjs in state/skills/<kind>/ from the image template, which an in-form
  // repopulate could not do. The refetch afterwards mirrors the shipped values back.
  const resetToDefault = async () => {
    if (custom || !isEdit || busy) return;
    setBusy(true);
    try {
      await resetMutation.mutateAsync({ fileId });
      const refreshed = await fileQuery.refetch();
      if (refreshed.data) applyFile(refreshed.data);
      flashFor('RESET TO SHIPPED DEFAULT');
      notify.ok(`Reset “${kind}” to default`);
    } catch (e) {
      notify.err(`Reset failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

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

  const headerTitle = (
    <Eyebrow className="text-vermilion">{isEdit ? 'Edit skill' : 'New skill'}</Eyebrow>
  );
  const headerSub = (
    <span className="caption truncate">{custom ? 'custom segment' : 'built-in segment'}</span>
  );
  // Sized down on a phone (52x26): the footer is fixed furniture, and this is the
  // one control that can't collapse into the overflow menu.
  const airToggle = isEdit ? (
    <div
      onClick={() => { if (!acting) toggleEnabled(); }}
      title={enabled ? 'On air — click to take off air' : 'Off air — click to put on air'}
      role="switch"
      aria-checked={enabled}
      aria-label="On air"
      className="relative h-[26px] w-[52px] flex-none border border-ink transition-colors sm:h-[30px] sm:w-[62px]"
      style={{ cursor: acting ? 'wait' : 'pointer', background: enabled ? 'var(--ink)' : 'transparent', opacity: acting ? 0.6 : 1 }}
    >
      <div
        className={`absolute top-[2px] left-[2px] size-[20px] transition-transform duration-200 sm:size-[24px] ${
          enabled ? 'translate-x-[26px] sm:translate-x-[32px]' : 'translate-x-0'
        }`}
        style={{ background: enabled ? 'var(--bg)' : 'var(--ink)' }}
      />
    </div>
  ) : null;

  const footer = (
    <EditorFooter
      status={(dirty || flash || blockingIssue) ? (
        <>
          {blockingIssue && (
            <span role="alert" style={{ fontSize: 11, color: 'var(--accent)', letterSpacing: '0.02em', fontWeight: 600 }}>
              {blockingIssue}
            </span>
          )}
          {dirty && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 700 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />UNSAVED EDITS
            </span>
          )}
          {flash && (
            <span className="v3-blink" style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 700 }}>✓ {flash}</span>
          )}
        </>
      ) : null}
      extra={airToggle}
      actions={[
        {
          id: 'run',
          label: '▸ Run now',
          tone: 'accent',
          onClick: run,
          disabled: acting,
          hidden: !isEdit,
        },
        {
          id: 'export',
          label: '↓ Export',
          onClick: exportZip,
          title: 'Download this skill as a .zip (SKILL.md + tool.mjs)',
          hidden: !isEdit,
        },
        {
          id: 'delete',
          label: 'Delete',
          tone: 'danger',
          onClick: () => setConfirmDelete(true),
          disabled: acting,
          hidden: !(isEdit && custom),
        },
        {
          id: 'share',
          label: '↗ Share to community',
          onClick: shareToCommunity,
          title: 'Open a prefilled GitHub issue to share this skill with the community',
          hidden: !(isEdit && custom && !hasTool),
        },
      ]}
      primary={[
        { id: 'close', label: 'Close', onClick: requestClose, disabled: busy },
        {
          id: 'save',
          label: busy
            ? (mode === 'create' ? 'Creating…' : 'Saving…')
            : (mode === 'create' ? 'Create' : 'Save'),
          tone: 'solid',
          onClick: () => { void onSubmit(); },
          disabled: !canSave,
        },
      ]}
    />
  );

  return (
    <EditorDialog
      open
      onOpenChange={(o) => { if (!o) requestClose(); }}
      busy={busy}
      title={headerTitle}
      sub={headerSub}
      footer={footer}
      className="sw-seg"
    >
      {!loaded ? (
        <SkeletonForm fields={4} />
      ) : (
        <div style={{ opacity: isEdit && !enabled ? 0.6 : 1, transition: 'opacity .2s ease' }}>

            <div className="sw-section">
              <TextField
                control={control}
                name="label"
                label="Skill name"
                placeholder={displayName}
              />
              {mode === 'create' && (
                <Controller
                  control={control}
                  name="name"
                  render={({ field, fieldState }) => {
                    const baseId = `${uid}-name`;
                    const aria = fieldAria(baseId, fieldState.error);
                    return (
                      <>
                        <label
                          {...aria.labelProps}
                          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 14 }}
                        >
                          <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 700 }}>SLUG</span>
                          <input
                            {...aria.controlProps}
                            value={field.value || ''}
                            onChange={e => field.onChange(e.target.value.toLowerCase())}
                            onBlur={field.onBlur}
                            ref={field.ref}
                            placeholder="moon-phase"
                            style={{ ...inputBase, padding: '8px 12px', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', width: 200, maxWidth: '100%', borderColor: fieldState.error ? 'var(--accent)' : 'var(--ink)' }}
                          />
                        </label>
                        {fieldState.error && (
                          <div {...aria.errorProps} role="alert" style={{ fontSize: 12, color: 'var(--accent)', marginTop: 8, letterSpacing: '0.01em' }}>
                            {fieldState.error.message}
                          </div>
                        )}
                      </>
                    );
                  }}
                />
              )}
            </div>

            <div className="sw-section">
              <div style={sectionLabel}>COOLDOWN · MINIMUM GAP BETWEEN AIRINGS</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginTop: 16 }}>
                <Controller
                  control={control}
                  name="cooldown"
                  render={({ field }) => (
                    <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                      {COOLDOWN_PRESETS.map((v, i) => (
                        <button key={v} type="button" onClick={() => field.onChange(v)} style={presetStyle(field.value === v, i)}>{v}</button>
                      ))}
                    </div>
                  )}
                />
                <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>OR TYPE</span>
                <TextField
                  control={control}
                  name="cooldown"
                  label="Cooldown"
                  placeholder="45m"
                  description="e.g. 45m, 6h, 2d, or a bare number (minutes)."
                  className="w-32"
                />
              </div>
            </div>

            {/* Cron timer — optional dedicated schedule that fires the skill immediately */}
            <div className="sw-section">
              <div style={sectionLabel}>CRON TIMER — FIRE ON A FIXED SCHEDULE</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 16 }}>
                <TextField
                  control={control}
                  name="cron"
                  label="Cron expression"
                  placeholder="0 * * * *"
                  className="w-50"
                />
              </div>
              {cronInvalid && (
                <div style={{ fontSize: 12, color: 'var(--danger, #e5484d)', marginTop: 12, lineHeight: 1.6, maxWidth: '72ch' }}>
                  This skill&apos;s SKILL.md carries a cron expression the scheduler can&apos;t run, so no timer is registered for it. Fix or clear the field to save.
                </div>
              )}
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6, maxWidth: '72ch' }}>
                Standard 5-field cron expression (e.g. <code>0 * * * *</code> = top of every hour, <code>*/30 * * * *</code> = every 30 min); a leading seconds field is accepted too. Leave blank to rely on the cooldown / normal frequency gating. When a cron timer fires it runs the skill immediately, bypassing the frequency floor and cooldown — but unlike Run Now it still stands down when the station voice is off, a programme is on air, nobody is listening, the daily token budget is spent, or the skill is disabled / not assigned to the on-air DJ. Uses the station timezone set in Settings.
              </div>
              <Controller
                control={control}
                name="cronOnly"
                render={({ field }) => {
                  const baseId = `${uid}-cron-only`;
                  const aria = fieldAria(baseId);
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
                      <Switch
                        {...aria.controlProps}
                        checked={!!field.value}
                        onCheckedChange={field.onChange}
                        onBlur={field.onBlur}
                        ref={field.ref}
                      />
                      <label {...aria.labelProps} style={{ ...sectionLabel, cursor: 'pointer' }}>
                        ONLY FIRE ON THE CRON TIMER
                      </label>
                    </div>
                  );
                }}
              />
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6, maxWidth: '72ch' }}>
                Off by default: the skill stays eligible for the DJ&apos;s normal between-track random picks in addition to firing on the schedule above. Turn this on for a skill written around a specific moment (a running joke tied to a particular time) so it never airs at any other time.
              </div>
            </div>

            <div className="sw-section">
              <Controller
                control={control}
                name="cohosts"
                render={({ field }) => {
                  const baseId = `${uid}-cohosts`;
                  const aria = fieldAria(baseId);
                  return (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Switch
                          {...aria.controlProps}
                          checked={!!field.value}
                          onCheckedChange={field.onChange}
                          onBlur={field.onBlur}
                          ref={field.ref}
                        />
                        <label {...aria.labelProps} style={{ ...sectionLabel, cursor: 'pointer' }}>
                          CO-HOSTED DISCUSSION
                        </label>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6, maxWidth: '72ch' }}>
                        Uses the current show&apos;s host plus every guest co-host, with each contribution spoken in that persona&apos;s own voice. It runs only while a co-hosted show is active; the show roster, not this skill, chooses the participants.
                      </div>
                    </>
                  );
                }}
              />
            </div>

            {/* Window — custom skills only (built-in window isn't editable) */}
            {custom && (
              <div className="sw-section">
                <Controller
                  control={control}
                  name="window"
                  render={({ field, fieldState }) => {
                    const baseId = `${uid}-window`;
                    const aria = fieldAria(baseId, fieldState.error);
                    return (
                      <>
                        <div {...aria.labelledByProps} style={sectionLabel}>WHEN IT CAN AIR</div>
                        <div {...aria.groupProps} style={{ display: 'flex', flexWrap: 'wrap', marginTop: 16 }}>
                          {([['any', 'ANY TIME'], ['commute', 'COMMUTE ONLY']] as const).map(([w, lbl], i) => (
                            <button key={w} type="button" onClick={() => field.onChange(w)} style={presetStyle(field.value === w, i)}>{lbl}</button>
                          ))}
                        </div>
                        {fieldState.error && (
                          <div {...aria.errorProps} role="alert" style={{ fontSize: 12, color: 'var(--accent)', marginTop: 12 }}>
                            {fieldState.error.message}
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>Commute-only restricts this segment to the morning and evening commute hours.</div>
                      </>
                    );
                  }}
                />
              </div>
            )}

            {configFields.length > 0 && (
              <div className="sw-section">
                <div style={sectionLabel}>SKILL SETTINGS</div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap', marginTop: 16 }}>
                  {configFields.map(f => (
                    <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: f.type === 'number' ? '0 0 auto' : '1 1 320px', minWidth: 0 }}>
                      <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>{f.label}</span>
                      <input
                        type={f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text'}
                        min={f.type === 'number' ? f.min : undefined}
                        max={f.type === 'number' ? f.max : undefined}
                        step={f.type === 'number' ? (f.integer ? 1 : 'any') : undefined}
                        value={config[f.key] || ''}
                        onChange={e => setConfig(c => ({ ...c, [f.key]: e.target.value }))}
                        placeholder={f.placeholder || ''}
                        style={{
                          ...inputBase,
                          ...(f.type === 'number'
                            ? { width: 110, padding: '11px 12px', fontVariantNumeric: 'tabular-nums' }
                            : { width: '100%', minWidth: 0, padding: '11px 15px' }),
                          boxSizing: 'border-box',
                          fontSize: 14,
                        }}
                      />
                      {f.hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{f.hint}</span>}
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6, maxWidth: '78ch' }}>
                  Declared by this skill&apos;s <code>tool.mjs</code> and stored in its own <code>SKILL.md</code>, so a copy of the skill keeps its settings.
                </div>
              </div>
            )}

            <div className="sw-section">
              <Controller
                control={control}
                name="context"
                render={({ field, fieldState }) => {
                  const baseId = `${uid}-context`;
                  const aria = fieldAria(baseId, fieldState.error);
                  return (
                    <>
                      <div {...aria.labelledByProps} style={sectionLabel}>CONTEXT THE DJ MAY MENTION</div>
                      <div {...aria.groupProps} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
                        {knownContext.map(cf => {
                          const on = field.value.includes(cf);
                          return (
                            <button
                              key={cf}
                              type="button"
                              onClick={() => field.onChange(on ? field.value.filter(x => x !== cf) : [...field.value, cf])}
                              style={chipStyle(on)}
                            >
                              <span style={markStyle(on)} />
                              <span>{CONTEXT_FIELD_LABELS[cf as ContextField] || cf}</span>
                            </button>
                          );
                        })}
                      </div>
                      {fieldState.error && (
                        <div {...aria.errorProps} role="alert" style={{ fontSize: 12, color: 'var(--accent)', marginTop: 14 }}>
                          {fieldState.error.message}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14, lineHeight: 1.6, maxWidth: '78ch' }}>
                        Switch on only what&apos;s topical for this segment. A context left dark stays out of the prompt, so the DJ stops working it into every break.
                      </div>
                    </>
                  );
                }}
              />
            </div>

            <div className="sw-section">
              <Controller
                control={control}
                name="tags"
                render={({ field, fieldState }) => {
                  const baseId = `${uid}-tags`;
                  const aria = fieldAria(baseId, fieldState.error);
                  const suggestions = (tagSuggestions || []).filter(t => !field.value.includes(t));
                  return (
                    <>
                      <div {...aria.labelledByProps} style={sectionLabel}>TAGS · ORGANISE THE SKILL LIST</div>
                      <div {...aria.groupProps} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 16 }}>
                        {field.value.map(t => (
                          <button
                            key={t}
                            type="button"
                            title={`Remove tag "${t}"`}
                            onClick={() => field.onChange(field.value.filter(x => x !== t))}
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
                              addTag(tagDraft, field.value, field.onChange);
                            }
                          }}
                          onBlur={() => addTag(tagDraft, field.value, field.onChange)}
                          placeholder={field.value.length ? 'add tag…' : 'late-night, factual…'}
                          aria-label="Add tag"
                          style={{ ...inputBase, width: 160, padding: '9px 12px', fontSize: 13 }}
                        />
                      </div>
                      {fieldState.error && (
                        <div {...aria.errorProps} role="alert" style={{ fontSize: 12, color: 'var(--accent)', marginTop: 12 }}>
                          {fieldState.error.message}
                        </div>
                      )}
                      {suggestions.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}>
                          <span style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>IN USE</span>
                          {suggestions.map(t => (
                            <button key={t} type="button" onClick={() => addTag(t, field.value, field.onChange)} style={chipStyle(false)}>
                              #{t}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
                        Freeform: tag by show, mood, type, whatever helps you filter. Tags travel with the skill when exported or shared.
                      </div>
                    </>
                  );
                }}
              />
            </div>

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

            <div className="sw-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={sectionLabel}>THE BRIEF · WHAT THE DJ SAYS, AND WHEN TO STAY SILENT</div>
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
              <TextareaField
                control={control}
                name="brief"
                label="The brief"
                rows={7}
                placeholder="What should the DJ say — and when should it stay quiet?"
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                <span style={{ fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>DJ VOICE · IN CHARACTER</span>
                <span style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{briefValue.length} CHARS</span>
              </div>
              {hasTool && (
                <div style={{ marginTop: 14, border: '1px solid color-mix(in oklab, var(--ink) 24%, transparent)', borderLeft: '3px solid var(--accent)', padding: '12px 14px', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
                  A <code>tool.mjs</code> data fetcher is attached and runs each tick before the DJ speaks. It isn&apos;t editable here; edit it on disk in <code>state/skills/{kind}/</code>, then Rescan.{custom ? ' Deleting the skill removes it too.' : ' Use ↺ Reset to default to restore the shipped version.'}
                </div>
              )}
            </div>
          </div>
        )}

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
