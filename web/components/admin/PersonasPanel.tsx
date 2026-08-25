'use client';

// Personas editor. One persona is active at a time (a scheduled Show can
// override who is on air for its hour); the system prompt is a library of
// global templates, '' = the built-in default. Everything POSTs to /settings
// and applies live — no mixer restart.
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import {
  useFieldArray,
  type Control,
  type UseFormGetValues,
  type UseFormReset,
  type UseFormSetValue,
  type UseFormWatch,
} from 'react-hook-form';
import { useAdminAuth } from '../../lib/adminAuth';
import { AdminResponseError, adminJson, useAdminMutation } from '../../lib/admin-query';
import { notify, errorMessage } from '../../lib/notify';
import { useZodForm, applyServerFieldErrors } from '@/lib/form';
import { personaSchema, djPromptSchema } from '@/lib/schemas.generated';
import { Card, Btn, Pill } from './ui';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/error-state';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Modal } from '../ui/modal';
import type {
  Persona, SettingsResponse, CommunityPersona, PersonasFormValues,
} from './personas/types';
import { DIAL_NEUTRAL, HOUSE_RULES_MAX, PERSONA_MAX } from './personas/constants';
import {
  clientMintId, fetchDicebearAvatar, fileToAvatarDataUrl,
  voiceForSave, cloudIssue, formFromSettings, personaFromSettings, personasEqual,
  promptLibraryFromSettings,
} from './personas/helpers';
import { PersonaHero } from './personas/PersonaHero';
import { SystemPromptModal } from './personas/SystemPromptModal';
import { PersonaRoster } from './personas/PersonaRoster';
import {
  PERSONA_SORTS,
  orderPersonaRoster,
  personaFilterActive,
  personaTagVocabulary,
  type PersonaSort,
} from './personas/roster-order';
import { useRosterSort } from '../../lib/adminView';
import { PersonaEditor } from './personas/PersonaEditor';
import { useCommunityPersonas } from './personas/queries';
import {
  settingsKeys,
  useSettingsMutation,
  useSettingsQuery,
} from './settings/queries';

// The RHF resolver is the two shared schemas the controller validates against,
// so this editor and the controller cannot disagree about what's saveable.
// `activePersonaId` / `activeDjPromptId` / `djHouseRules` stay out: they aren't
// array rows, and the patch registry validates each as its own settings key.
const formSchema = z.object({
  personas: z.array(personaSchema),
  djPrompts: z.array(djPromptSchema),
});

export default function PersonasPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const queryClient = useQueryClient();
  const settingsQuery = useSettingsQuery<SettingsResponse>({
    adminFetch,
    enabled: hydrated && !needsAuth,
  });
  const communityQuery = useCommunityPersonas(adminFetch, hydrated && !needsAuth);
  const data = settingsQuery.data ?? null;
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  // The AI-draft field shows only while creating.
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  // Bumped on every avatar mutation and appended as ?v=… so the admin <img>
  // refetches past the public endpoint's hour-long cache.
  const [avatarTick, setAvatarTick] = useState(0);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  // Raised when the editor is closed by ×/Escape with the focused persona dirty.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Best-effort; null = still loading.
  const community: CommunityPersona[] | null = communityQuery.isPending
    ? null
    : (communityQuery.data ?? []);
  const [communityOpen, setCommunityOpen] = useState(false); // catalog modal open?
  const [installing, setInstalling] = useState<string | null>(null); // community slug installing, or null
  // Not array rows — plain state, not RHF (see the schema comment above).
  // Sort is remembered per browser; the filters deliberately are not — see
  // useRosterSort's note on why a filter that survives a reload is worse than
  // one you have to set again.
  const [sort, setSort] = useRosterSort<PersonaSort>('personas', PERSONA_SORTS, 'az');
  const [query, setQuery] = useState('');
  const [tagSel, setTagSel] = useState<string[]>([]);

  const [activePersonaId, setActivePersonaId] = useState('');
  const [activeDjPromptId, setActiveDjPromptId] = useState('');
  const [djHouseRules, setDjHouseRules] = useState('');
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Set by addPersona so the focus-change effect scrolls; a plain roster click
  // changes focus too but shouldn't yank the page around.
  const scrollToEditorRef = useRef(false);
  const baselineRef = useRef<ReturnType<typeof formFromSettings>>(null);
  const appliedRevisionRef = useRef(0);
  const pendingSettingsRef = useRef<{ revision: number; data: SettingsResponse } | null>(null);

  const form = useZodForm(formSchema, { personas: [], djPrompts: [] });
  // Every field in these schemas is a z.unknown().transform() (they double as
  // the server's load-repair target), so z.input<> types every leaf `unknown`
  // and no nested path would type-check as a FieldPath. Type-only cast.
  const control = form.control as unknown as Control<PersonasFormValues>;
  const setValue = form.setValue as unknown as UseFormSetValue<PersonasFormValues>;
  const getValues = form.getValues as unknown as UseFormGetValues<PersonasFormValues>;
  const watch = form.watch as unknown as UseFormWatch<PersonasFormValues>;
  const resetForm = form.reset as unknown as UseFormReset<PersonasFormValues>;

  // `keyName: '_rhfKey'` is load-bearing — personas and prompt presets carry
  // their own `id`, which RHF's default keyName ('id') would clobber. `fields`
  // goes unused: consumers key off the persona's own id, and this component
  // reads live values via `watch('personas')`.
  const { append: appendPersonaField, remove: removePersonaField, replace: replacePersonaFields } =
    useFieldArray({ control, name: 'personas', keyName: '_rhfKey' });
  const {
    fields: promptFields, append: appendPromptField, remove: removePromptFieldAt,
    replace: replacePromptFields,
  } = useFieldArray({ control, name: 'djPrompts', keyName: '_rhfKey' });

  const saveMutation = useSettingsMutation<SettingsResponse>({ adminFetch });

  const personaMutation = useAdminMutation<Record<string, unknown>, {
    path: string;
    init: RequestInit;
  }>({
    adminFetch,
    request: (vars, fetcher) => adminJson<Record<string, unknown>>(fetcher, vars.path, vars.init),
    toastOnError: false,
  });

  const load = async () => {
    const result = await settingsQuery.refetch();
    if (result.error) {
      setErr(errorMessage(result.error));
      return null;
    }
    setErr(null);
    return result.data ?? null;
  };

  useEffect(() => {
    if (settingsQuery.error) {
      // A failed background refresh must not replace a loaded, dirty editor
      // with the page-level error state. The save path reports that failure;
      // keep the last safe envelope and operator edits visible for retry.
      if (!loaded) {
        setErr(errorMessage(settingsQuery.error));
        setLoaded(true);
      }
      return;
    }
    const revision = settingsQuery.dataUpdatedAt;
    if (settingsQuery.data && revision && appliedRevisionRef.current !== revision) {
      pendingSettingsRef.current = { revision, data: settingsQuery.data };
    }
    const pending = pendingSettingsRef.current;
    if (!pending) return;
    const next = formFromSettings(pending.data);
    if (!next) return;
    const baseline = baselineRef.current;
    const currentPlainIsDirty = !!baseline && (
      activePersonaId !== baseline.activePersonaId
      || activeDjPromptId !== baseline.activeDjPromptId
      || djHouseRules !== baseline.djHouseRules
    );
    if (loaded && (form.formState.isDirty || currentPlainIsDirty)) return;
    resetForm({ personas: next.personas, djPrompts: next.djPrompts });
    setActivePersonaId(next.activePersonaId);
    setActiveDjPromptId(next.activeDjPromptId);
    setDjHouseRules(next.djHouseRules);
    baselineRef.current = next;
    appliedRevisionRef.current = pending.revision;
    pendingSettingsRef.current = null;
    setErr(null);
    setLoaded(true);
  }, [
    settingsQuery.data, settingsQuery.dataUpdatedAt, settingsQuery.error, loaded, form.formState.isDirty,
    activePersonaId, activeDjPromptId, djHouseRules, resetForm,
  ]);

  // Guarded by scrollToEditorRef so ordinary roster clicks don't scroll.
  useEffect(() => {
    if (!scrollToEditorRef.current) return;
    scrollToEditorRef.current = false;
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusIdx]);

  // Only used by the AI-draft "apply", which hands back several fields at once;
  // every keystroke field binds straight to `control` instead.
  const applyPersonaPatch = (i: number, patch: Partial<Persona>) => {
    const current = getValues(`personas.${i}`);
    if (!current) return;
    setValue(`personas.${i}`, { ...current, ...patch }, { shouldDirty: true, shouldValidate: true });
  };

  const addPersona = () => {
    const currentPersonas = getValues('personas');
    if (currentPersonas.length >= PERSONA_MAX) return;
    // Captured before the append so the new entry can be focused.
    const newIdx = currentPersonas.length;
    const newId = clientMintId();
    appendPersonaField({
      id: newId, name: 'New persona', tagline: '',
      frequency: 'moderate', scriptLength: 'concise', djMode: false,
      humour: DIAL_NEUTRAL, localColour: DIAL_NEUTRAL, warmth: DIAL_NEUTRAL, soul: '',
      language: '',
      avatar: '',
      tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella', gainDb: 0, speed: 1 },
      skills: (data?.skills?.catalog || []).map(s => s.name),
      tags: [],
    });
    // errors populate only once a field is touched, so without this the new
    // row's "incomplete" badge and the editor's status line stay silent about
    // why Save is disabled.
    void form.trigger();
    // Without the open + toast the add is silent, tucked at the end of the roster.
    scrollToEditorRef.current = true;
    setCreatingId(newId);
    setFocusIdx(newIdx);
    setEditorOpen(true);
    notify.ok('New persona added. Fill in its details, then Save persona.');
  };

  // The controller persists the install; the returned persona is appended to the
  // local form as well so unsaved edits to other personas survive.
  const installCommunity = async (slug: string) => {
    setInstalling(slug);
    try {
      const j = await personaMutation.mutateAsync({
        path: `/personas/community/${encodeURIComponent(slug)}/install`,
        init: { method: 'POST' },
      }) as { persona?: Partial<Persona> | null };
      const p = j.persona;
      if (p && typeof p.id === 'string') {
        const allSkills = (data?.skills?.catalog || []).map(s => s.name);
        // Community personas arrive with no avatar and usually no voice, so both
        // are pinned back to unset — the mapper's `bf_isabella` default is wrong here.
        const mapped = personaFromSettings(p, allSkills);
        const installed: Persona = {
          ...mapped,
          avatar: '',
          tts: { ...mapped.tts, voice: p.tts?.voice ?? '' },
        };
        appendPersonaField(installed);
        void form.trigger(); // see the comment on addPersona's own trigger() call
      }
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      notify.ok(`Installed “${p?.name || slug}” — off air until you put them on the desk`);
    } catch (e) {
      notify.err(`Install failed: ${errorMessage(e)}`);
    } finally { setInstalling(null); }
  };

  const removePersona = (i: number) => {
    const currentPersonas = getValues('personas');
    if (currentPersonas.length <= 1) return;
    const target = currentPersonas[i];
    if (!target) return;
    // Replace with the complete remaining value array. `remove(i)` unregisters
    // the open editor's inputs before RHF commits its field-array update; a
    // save opened immediately afterwards can otherwise retain a shell of the
    // deleted row with its registered `id` missing.
    replacePersonaFields(currentPersonas.filter((_, idx) => idx !== i));
    setActivePersonaId(cur => {
      if (target.id !== cur) return cur;
      const remaining = currentPersonas.filter((_, idx) => idx !== i);
      return remaining[0]?.id ?? cur;
    });
  };

  // Avatar mutations update the local form too, so the basename round-trips
  // through any subsequent save.
  const uploadAvatar = async (personaId: string, file: File) => {
    setUploadingId(personaId);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      const j = await personaMutation.mutateAsync({
        path: `/personas/${encodeURIComponent(personaId)}/avatar`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        },
      }) as { avatar?: string };
      const filename = j.avatar || '';
      const idx = getValues('personas').findIndex(p => p.id === personaId);
      if (idx !== -1) setValue(`personas.${idx}.avatar`, filename, { shouldDirty: true, shouldValidate: true });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      setAvatarTick(t => t + 1);
      notify.ok('avatar uploaded');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  const generateAvatar = async (personaId: string) => {
    setUploadingId(personaId);
    try {
      const dataUrl = await fetchDicebearAvatar();
      const j = await personaMutation.mutateAsync({
        path: `/personas/${encodeURIComponent(personaId)}/avatar`,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        },
      }) as { avatar?: string };
      const filename = j.avatar || '';
      const idx = getValues('personas').findIndex(p => p.id === personaId);
      if (idx !== -1) setValue(`personas.${idx}.avatar`, filename, { shouldDirty: true, shouldValidate: true });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      setAvatarTick(t => t + 1);
      notify.ok('avatar generated');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  const clearAvatar = async (personaId: string) => {
    setUploadingId(personaId);
    try {
      await personaMutation.mutateAsync({
        path: `/personas/${encodeURIComponent(personaId)}/avatar`,
        init: { method: 'DELETE' },
      });
      const idx = getValues('personas').findIndex(p => p.id === personaId);
      if (idx !== -1) setValue(`personas.${idx}.avatar`, '', { shouldDirty: true, shouldValidate: true });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.all });
      setAvatarTick(t => t + 1);
      notify.ok('avatar removed');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  const removePromptPreset = (idx: number, id: string) => {
    removePromptFieldAt(idx);
    // Deleting the in-use template falls back to the built-in default.
    setActiveDjPromptId(cur => (cur === id ? '' : cur));
  };

  const personas = watch('personas');
  const djPrompts = watch('djPrompts');

  // A scheduled show can override the default; fall back to the default
  // selection on controllers predating the onAir field.
  const onAirPersonaId = data?.onAir?.personaId || activePersonaId;
  // Display order for the roster AND the editor's counter, so both name the
  // same slot. The memo is load-bearing, not an optimisation: removing a
  // persona hands `watch` one frame where the dropped index is still counted
  // but holds only the editor's registered fields — no `skills`, no `id`.
  // Recomputing on that frame renders a card for it and throws on
  // `p.skills.length`; the memo re-uses the last good order until the array
  // settles. Sits above the loading guards so the hook order never varies.
  const roster = useMemo(
    () => orderPersonaRoster(personas, onAirPersonaId, { sort, filter: { query, tags: tagSel } }),
    [personas, onAirPersonaId, sort, query, tagSel],
  );
  // Vocabulary and suggestions come from the WHOLE roster, not the filtered
  // view: the point of offering a tag is to converge on one word for a thing,
  // and a filtered list hides exactly the tags worth reusing.
  const allTags = useMemo(() => personaTagVocabulary(personas), [personas]);

  // The textarea's maxLength already enforces the house-rules cap; this guards
  // a pasted-over-limit edge.
  const promptsOk = !form.formState.errors.djPrompts
    && (activeDjPromptId === '' || djPrompts.some(p => p.id === activeDjPromptId))
    && djHouseRules.trim().length <= HOUSE_RULES_MAX;
  const allPersonasOk = !form.formState.errors.personas;
  const canSave = form.formState.isValid && promptsOk
    && personas.some(p => p.id === activePersonaId);
  const isPersonaInvalid = (idx: number) => !!form.formState.errors.personas?.[idx];

  const save = async (): Promise<boolean> => {
    if (!canSave) return false;
    setBusy(true);
    try {
      const values = getValues();
      const patch = {
          personas: values.personas.map(p => ({
            id: p.id,
            name: p.name.trim(),
            tagline: p.tagline.trim(),
            frequency: p.frequency,
            scriptLength: p.scriptLength,
            djMode: p.djMode,
            humour: p.humour,
            localColour: p.localColour,
            warmth: p.warmth,
            soul: p.soul.trim(),
            language: p.language.trim(),
            avatar: p.avatar || '',
            tts: {
              engine: p.tts.engine,
              cloudProvider: p.tts.cloudProvider,
              // `voice` is shared across engines, so a leftover id from the
              // previous engine would fail the server's validator.
              voice: voiceForSave(p.tts.engine, p.tts.voice.trim()),
              // Per-persona voice-level trim (dB). Server clamps to ±12.
              gainDb: p.tts.gainDb ?? 0,
              // Per-persona speech-rate multiplier. Server clamps to 0.5–2.0×.
              speed: p.tts.speed ?? 1,
            },
            skills: p.skills,
            tags: p.tags || [],
          })),
          activePersonaId,
          djPrompts: values.djPrompts.map(p => ({ id: p.id, name: p.name.trim(), text: p.text.trim() })),
          activeDjPromptId,
          djHouseRules: djHouseRules.trim(),
        };
      const receipt = await saveMutation.mutateAsync(patch);
      const authoritative = receipt.refreshError
        ? {
            personas: patch.personas,
            activePersonaId: patch.activePersonaId,
            djPrompts: patch.djPrompts,
            activeDjPromptId: patch.activeDjPromptId,
            djHouseRules: patch.djHouseRules,
          }
        : formFromSettings(
            queryClient.getQueryData<SettingsResponse>(settingsKeys.detail()) ?? null,
          );
      if (authoritative) {
        resetForm({ personas: authoritative.personas, djPrompts: authoritative.djPrompts });
        setActivePersonaId(authoritative.activePersonaId);
        setActiveDjPromptId(authoritative.activeDjPromptId);
        setDjHouseRules(authoritative.djHouseRules);
        baselineRef.current = authoritative;
      }
      if (receipt.refreshError) {
        notify.err(`personas saved, but refresh failed: ${receipt.refreshError}`);
      } else {
        notify.ok('personas saved, applies on the next spoken line');
      }
      return true;
    } catch (e) {
      if (e instanceof AdminResponseError) {
        applyServerFieldErrors(form, (e.body as { fieldErrors?: Record<string, string> }).fieldErrors);
      }
      notify.err(errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  // Discard must actually revert: the form holds the only copy of the roster
  // and save() POSTs the WHOLE array, so abandoned edits would block Save for
  // every other persona and ride along on the next save (issue #1106). Scoped
  // to the persona being edited so edits to others survive.
  const discardPersona = async (): Promise<void> => {
    // Close the editor BEFORE the settings round-trip — an editor left open
    // across the fetch re-raises the unsaved-changes confirm, because a click
    // inside the confirm counts as an interaction outside the editor.
    setConfirmDiscard(false);
    setEditorOpen(false);
    setBusy(true);
    try {
      // Never revert against nothing: a missing `stored` is what marks a persona
      // never-saved, so an empty response would turn Discard into Delete.
      const server = formFromSettings(await load()) ?? formFromSettings(data);
      if (!server) {
        notify.err('could not reach the controller — your changes were kept');
        return;
      }
      // Clamp here rather than closing over the render's `safeIdx` — the
      // roster can shift between render and click.
      const currentPersonas = getValues('personas');
      const idx = Math.min(focusIdx, currentPersonas.length - 1);
      const target = currentPersonas[idx];
      if (!target) return;
      const stored = server.personas.find(p => p.id === target.id);
      // Never saved (added in this session) → it leaves the roster entirely.
      const nextPersonas = stored
        ? currentPersonas.map((p, i) => (i === idx ? stored : p))
        : currentPersonas.filter((_, i) => i !== idx);
      if (!nextPersonas.length) return; // paranoia: keep at least one persona
      if (stored) {
        setValue(`personas.${idx}`, stored, { shouldDirty: true, shouldValidate: true });
      } else {
        removePersonaField(idx);
      }
      // "Set as default" is a form edit too: undo it when it pointed at the
      // reverted persona, then make sure the id still resolves.
      setActivePersonaId(cur => {
        const next = cur === target.id ? server.activePersonaId : cur;
        return nextPersonas.some(p => p.id === next) ? next : (nextPersonas[0]?.id ?? next);
      });
      // focusIdx needs no adjustment — the render clamps it (`safeIdx`), so a
      // removal just lands focus on the neighbour.
      setCreatingId(null);
      notify.ok('changes discarded');
    } finally { setBusy(false); }
  };

  // Same contract for the prompt library, leaving the personas alone.
  const discardPrompts = async (): Promise<void> => {
    setShowPrompt(false);
    setBusy(true);
    try {
      const j = await load();
      if (!j) {
        notify.err('could not reach the controller — your changes were kept');
        return;
      }
      const { djPrompts: nextPrompts, activeDjPromptId: nextActiveId, djHouseRules: nextHouseRules } =
        promptLibraryFromSettings(j);
      replacePromptFields(nextPrompts);
      setActiveDjPromptId(nextActiveId);
      setDjHouseRules(nextHouseRules);
      notify.ok('changes discarded');
    } finally { setBusy(false); }
  };

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <ErrorState error={err} onRetry={load} />
        </Card>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  const safeIdx = Math.min(focusIdx, personas.length - 1);
  const focused = personas[safeIdx];
  if (!focused) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <div className="text-[13px] text-muted italic">no personas configured</div>
        </Card>
      </div>
    );
  }

  const activePersona = personas.find(p => p.id === activePersonaId);
  const onAirPersona = personas.find(p => p.id === onAirPersonaId) || activePersona;
  const onAirShow = data?.onAir?.show || null;
  const focusedPosition = roster.find(e => e.index === safeIdx)?.position ?? safeIdx + 1;
  const focusedOk = !isPersonaInvalid(safeIdx);
  // Drives the confirm on ×/Escape: closing the editor keeps edits pending in
  // `personas`, which is how unsaved state used to ride along on the next save.
  const storedFocused = data?.values?.personas?.find(p => p.id === focused.id);
  const focusedDirty = !storedFocused
    || !personasEqual(focused, personaFromSettings(storedFocused, (data?.skills?.catalog || []).map(s => s.name)));
  const focusedCloudIssue = cloudIssue(focused, data);
  const onAirCloudIssue = onAirPersona ? cloudIssue(onAirPersona, data) : null;
  const defaultEngine = data?.values?.tts?.defaultEngine || 'piper';
  const skillCatalog = data?.skills?.catalog || [];

  return (
    <div className="grid gap-4">
      <PersonaHero
        onAirPersona={onAirPersona}
        defaultPersona={activePersona}
        onAirShow={onAirShow}
        defaultEngine={defaultEngine}
        onAirCloudIssue={onAirCloudIssue}
      />

      <SystemPromptModal
        open={showPrompt}
        onOpenChange={setShowPrompt}
        control={control}
        promptFields={promptFields}
        setValue={setValue}
        activeId={activeDjPromptId}
        houseRules={djHouseRules}
        onHouseRulesChange={setDjHouseRules}
        defaultPrompt={data?.defaults?.djPrompt || ''}
        busy={busy}
        canSave={canSave}
        allPersonasOk={allPersonasOk}
        promptsOk={promptsOk}
        onSetActive={setActiveDjPromptId}
        onAppendPreset={appendPromptField}
        onRemovePreset={removePromptPreset}
        onSave={async () => { if (await save()) setShowPrompt(false); }}
        onDiscard={() => { void discardPrompts(); }}
      />

      <PersonaRoster
        roster={roster}
        total={personas.length}
        sort={sort}
        onSortChange={setSort}
        query={query}
        onQueryChange={setQuery}
        tags={allTags}
        selectedTags={tagSel}
        onTagsChange={setTagSel}
        filtered={personaFilterActive({ query, tags: tagSel })}
        onClearFilters={() => { setQuery(''); setTagSel([]); }}
        activePersonaId={activePersonaId}
        onAirPersonaId={onAirPersonaId}
        avatarTick={avatarTick}
        isPersonaInvalid={isPersonaInvalid}
        onOpenPrompt={() => setShowPrompt(true)}
        onAdd={addPersona}
        onSelect={(i) => { setCreatingId(null); setFocusIdx(i); setEditorOpen(true); }}
        communityCount={community?.length ?? null}
        onCommunity={() => setCommunityOpen(true)}
      />

      <Modal
        open={communityOpen}
        onOpenChange={setCommunityOpen}
        title="community"
        sub="personas shared by other stations"
        width={640}
      >
        <div className="text-[12px] leading-[1.65] text-muted">
          These personas ship with SUB/WAVE and update when you do.
          <strong> Install</strong> adds one to your roster as your own editable persona — it
          arrives <strong>off air</strong> with your station&rsquo;s default voice, so give it a
          voice and an avatar, then put it on the desk. Made one worth sharing? Hit{' '}
          <strong>Edit → Share to community</strong> on any persona.
        </div>
        <div className="mt-4 grid gap-3">
          {community && community.length > 0 ? (
            community.map(c => {
              const inRoster = personas.some(
                p => p.name.trim().toLowerCase() === c.displayName.trim().toLowerCase(),
              );
              return (
                <div key={c.slug} className="grid grid-cols-1 gap-3 border border-ink p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-extrabold">{c.displayName}</span>
                      <Pill className="text-[8px]">{c.frequency}</Pill>
                      {c.scriptLength !== 'concise' && <Pill className="text-[8px]">{c.scriptLength}</Pill>}
                      {c.djMode && <Pill className="text-[8px]">dj mode</Pill>}
                      {c.language && <Pill className="max-w-[120px] truncate text-[8px]">{c.language}</Pill>}
                    </div>
                    {c.tagline && (
                      <div className="mt-0.5 text-[11px] font-bold text-muted">{c.tagline}</div>
                    )}
                    <div className="mt-1 line-clamp-3 text-[12px] leading-[1.6] text-muted">{c.soul}</div>
                    {(c.submittedBy || c.dateAdded) && (
                      <div className="mt-1.5 text-[10px] leading-[1.5] text-muted">
                        {c.submittedBy && (
                          <>
                            by{' '}
                            <a
                              href={`https://github.com/${c.submittedBy}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                            >
                              @{c.submittedBy}
                            </a>
                          </>
                        )}
                        {c.submittedBy && c.dateAdded && ' · '}
                        {c.dateAdded && <>added {c.dateAdded}</>}
                        {c.dateAdded && c.dateModified && c.dateModified !== c.dateAdded && (
                          <> · updated {c.dateModified}</>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {inRoster ? (
                      <Pill tone="accent" dot>in roster</Pill>
                    ) : (
                      <Btn
                        className="min-h-9 sm:min-h-0"
                        tone="accent"
                        onClick={() => installCommunity(c.slug)}
                        disabled={installing === c.slug || personas.length >= PERSONA_MAX}
                        title={personas.length >= PERSONA_MAX ? 'The roster is full' : undefined}
                      >
                        {installing === c.slug ? 'Installing…' : 'Install'}
                      </Btn>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-6 text-center text-[13px] text-muted italic">
              No community personas yet.
            </div>
          )}
        </div>
      </Modal>

      <PersonaEditor
        persona={focused}
        index={safeIdx}
        position={focusedPosition}
        control={control}
        personaCount={personas.length}
        activePersonaId={activePersonaId}
        onAirPersonaId={onAirPersonaId}
        data={data}
        adminFetch={adminFetch}
        avatarTick={avatarTick}
        uploadingId={uploadingId}
        defaultEngine={defaultEngine}
        cloudIssueText={focusedCloudIssue}
        skillCatalog={skillCatalog}
        tagSuggestions={allTags}
        editorRef={editorRef}
        open={editorOpen}
        isNew={focused.id === creatingId}
        // ×/Escape with unsaved edits asks first — closing used to keep them
        // pending in `form`, which is the other half of issue #1106.
        onClose={() => { if (focusedDirty) setConfirmDiscard(true); else setEditorOpen(false); }}
        onUpdate={applyPersonaPatch}
        onUploadAvatar={uploadAvatar}
        onGenerateAvatar={generateAvatar}
        onClearAvatar={clearAvatar}
        onSetActive={() => setActivePersonaId(focused.id)}
        onRemove={() => setConfirmDeleteIdx(safeIdx)}
        canSave={canSave}
        focusedOk={focusedOk}
        allPersonasOk={allPersonasOk}
        promptOk={promptsOk}
        busy={busy}
        onSave={async () => { if (await save()) setEditorOpen(false); }}
        onDiscard={() => { void discardPersona(); }}
      />

      <V3AlertDialog
        open={confirmDiscard}
        onOpenChange={(o) => { if (!o) setConfirmDiscard(false); }}
        title="Discard changes"
        description={
          <>
            <b>{focused.name.trim() || 'This persona'}</b> has unsaved changes. Closing without
            saving throws them away — nothing reaches the station until you Save persona.
          </>
        }
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onConfirm={() => { setConfirmDiscard(false); void discardPersona(); }}
      />

      <V3AlertDialog
        open={confirmDeleteIdx !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteIdx(null); }}
        title="Delete persona"
        description={
          <>
            Remove{' '}
            <b>{confirmDeleteIdx !== null ? (personas[confirmDeleteIdx]?.name.trim() || 'this persona') : 'this persona'}</b>
            {' '}from the roster? Nothing is permanent until you Save persona.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (confirmDeleteIdx !== null) {
            removePersona(confirmDeleteIdx);
            setFocusIdx(i => Math.max(0, i - 1));
          }
          setConfirmDeleteIdx(null);
          setEditorOpen(false);
        }}
      />
    </div>
  );
}
