'use client';

// Personas editor — /admin/personas. The station's roster of DJ identities.
// One persona is "active" at a time (a scheduled Show can override which
// persona is on air for its hour). Each persona owns its name, tagline, talk
// frequency, soul, and full voice (TTS engine + cloud provider + voice).
// The system prompt is a library of global templates shared by every persona,
// one active at a time ('' = the built-in default).
// Everything POSTs to /settings and applies live — no mixer restart.
//
// This file is the stateful container: it owns the form, validation, save, and
// avatar mutations, and composes the presentational pieces in ./personas/*.
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card, Btn, Pill } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Modal } from '../ui/modal';
import type { Persona, PersonaTts, DjPromptPreset, FormState, SettingsResponse, CommunityPersona } from './personas/types';
import { DIAL_NEUTRAL, PERSONA_MAX } from './personas/constants';
import {
  clientMintId, fetchDicebearAvatar, fileToAvatarDataUrl, personaValid, promptPresetValid,
  voiceForSave, cloudIssue, formFromSettings, personaFromSettings, personasEqual,
  promptLibraryFromSettings,
} from './personas/helpers';
import { PersonaHero } from './personas/PersonaHero';
import { SystemPromptModal } from './personas/SystemPromptModal';
import { PersonaRoster } from './personas/PersonaRoster';
import { PersonaEditor } from './personas/PersonaEditor';

export default function PersonasPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // index of the persona being edited
  const [focusIdx, setFocusIdx] = useState(0);
  // whether the full-screen persona editor is open (the roster is the browse
  // view; selecting a card or adding a persona opens this).
  const [editorOpen, setEditorOpen] = useState(false);
  // id of a freshly-added persona — the AI-draft field shows only while creating.
  const [creatingId, setCreatingId] = useState<string | null>(null);
  // whether the system-prompt library modal is open
  const [showPrompt, setShowPrompt] = useState(false);
  // Bumped on every avatar mutation. Appended as ?v=… so the admin <img>
  // refetches even though the public endpoint caches for an hour — the cache
  // is right for listeners, wrong for the operator who just uploaded.
  const [avatarTick, setAvatarTick] = useState(0);
  // Per-persona "uploading" flag — drives the spinner / disables the buttons
  // while the request is in flight.
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  // Index of the persona pending a delete-confirm (null = no dialog open).
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  // True while the "you have unsaved changes" dialog is up — raised when the
  // editor is closed by ×/Escape with the focused persona still dirty.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The shipped community persona catalog (best-effort; null = still loading).
  const [community, setCommunity] = useState<CommunityPersona[] | null>(null);
  const [communityOpen, setCommunityOpen] = useState(false); // catalog modal open?
  const [installing, setInstalling] = useState<string | null>(null); // community slug installing, or null
  // The editor block. After adding a persona we scroll it into view so the
  // operator actually sees the new persona open for editing — it stacks below
  // the roster and would otherwise be off-screen.
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Set true by addPersona so the focus-change effect knows to scroll. A plain
  // roster click changes focus too, but shouldn't yank the page around.
  const scrollToEditorRef = useRef(false);

  const load = async () => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return null;
      const j = (await r.json()) as SettingsResponse;
      setData(j); setErr(null);
      return j;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    const initial = async () => {
      try {
        const r = await adminFetch('/settings');
        if (!r.ok) return null;
        const j = (await r.json()) as SettingsResponse;
        setData(j); setErr(null);
        return j;
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return null;
      }
    };
    (async () => {
      const next = formFromSettings(await initial());
      if (next) setForm(next);
    })();
    // The community catalog is best-effort — a failure here shouldn't blank the
    // roster, so it fetches independently and just leaves the modal empty.
    (async () => {
      try {
        const r = await adminFetch('/personas/community');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as { community?: CommunityPersona[] };
        setCommunity(Array.isArray(j.community) ? j.community : []);
      } catch {
        setCommunity([]);
      }
    })();
  }, [hydrated, needsAuth, adminFetch]);

  // After an add bumps focus to the new persona, bring the editor into view.
  // Guarded by scrollToEditorRef so ordinary roster clicks don't scroll.
  useEffect(() => {
    if (!scrollToEditorRef.current) return;
    scrollToEditorRef.current = false;
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusIdx]);

  // ── persona helpers ──────────────────────────────────────────────────────
  const setPersona = (i: number, patch: Partial<Persona>) =>
    setForm(f => f ? { ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) } : f);
  const setPersonaTts = (i: number, patch: Partial<PersonaTts>) =>
    setForm(f => f ? { ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, tts: { ...p.tts, ...patch } } : p)) } : f);
  const setPersonaSkills = (i: number, skills: string[]) =>
    setForm(f => f ? { ...f, personas: f.personas.map((p, idx) => (idx === i ? { ...p, skills } : p)) } : f);
  const addPersona = () => {
    if (!form || form.personas.length >= PERSONA_MAX) return;
    // The new persona lands at the end of the roster — its index is the
    // current length. Capture it before the append so we can focus it.
    const newIdx = form.personas.length;
    const newId = clientMintId();
    setForm(f => {
      if (!f) return f;
      if (f.personas.length >= PERSONA_MAX) return f;
      return {
        ...f,
        personas: [...f.personas, {
          id: newId, name: 'New persona', tagline: '',
          frequency: 'moderate', scriptLength: 'concise', djMode: false,
          humour: DIAL_NEUTRAL, localColour: DIAL_NEUTRAL, warmth: DIAL_NEUTRAL, soul: '',
          language: '',
          avatar: '',
          tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella', gainDb: 0, speed: 1 },
          skills: (data?.skills?.catalog || []).map(s => s.name),
        }],
      };
    });
    // Open the new persona in the editor (+ scroll it into view) and confirm
    // with a toast — otherwise the add is silent and the operator never notices
    // the entry tucked at the end of the roster.
    scrollToEditorRef.current = true;
    setCreatingId(newId);
    setFocusIdx(newIdx);
    setEditorOpen(true);
    notify.ok('New persona added. Fill in its details, then Save persona.');
  };
  // Install a community persona: the controller appends it to the persisted
  // roster (off-air, default voice) and returns the stored persona. We append
  // that to the local form too — mapped through the same defaulting as the
  // initial load — so any unsaved edits to other personas survive.
  const installCommunity = async (slug: string) => {
    setInstalling(slug);
    try {
      const r = await adminFetch(`/personas/community/${encodeURIComponent(slug)}/install`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; persona?: Partial<Persona> | null };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const p = j.persona;
      if (p && typeof p.id === 'string') {
        const allSkills = (data?.skills?.catalog || []).map(s => s.name);
        // Community personas arrive with no avatar and (usually) no voice —
        // the shared mapper's `bf_isabella` default would be wrong here, so
        // both are pinned to the "unset" values after defaulting.
        const mapped = personaFromSettings(p, allSkills);
        const installed: Persona = {
          ...mapped,
          avatar: '',
          tts: { ...mapped.tts, voice: p.tts?.voice ?? '' },
        };
        setForm(f => f ? { ...f, personas: [...f.personas, installed] } : f);
      }
      notify.ok(`Installed “${p?.name || slug}” — off air until you put them on the desk`);
    } catch (e) {
      notify.err(`Install failed: ${errorMessage(e)}`);
    } finally { setInstalling(null); }
  };

  const removePersona = (i: number) =>
    setForm(f => {
      if (!f) return f;
      if (f.personas.length <= 1) return f;
      const target = f.personas[i];
      if (!target) return f;
      const personas = f.personas.filter((_, idx) => idx !== i);
      const fallback = personas[0]?.id ?? f.activePersonaId;
      const activePersonaId = target.id === f.activePersonaId ? fallback : f.activePersonaId;
      return { ...f, personas, activePersonaId };
    });

  // Avatar mutations talk to the dedicated upload endpoints, then update the
  // local form so the basename round-trips through any subsequent save. Each
  // mutation bumps avatarTick so the <img> cache-buster query string flips.
  const uploadAvatar = async (personaId: string, file: File) => {
    setUploadingId(personaId);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      const r = await adminFetch(`/personas/${encodeURIComponent(personaId)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; avatar?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const filename = j.avatar || '';
      setForm(f =>
        f ? { ...f, personas: f.personas.map(p => (p.id === personaId ? { ...p, avatar: filename } : p)) } : f,
      );
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
      const r = await adminFetch(`/personas/${encodeURIComponent(personaId)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; avatar?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const filename = j.avatar || '';
      setForm(f =>
        f ? { ...f, personas: f.personas.map(p => (p.id === personaId ? { ...p, avatar: filename } : p)) } : f,
      );
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
      const r = await adminFetch(`/personas/${encodeURIComponent(personaId)}/avatar`, {
        method: 'DELETE',
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      setForm(f =>
        f ? { ...f, personas: f.personas.map(p => (p.id === personaId ? { ...p, avatar: '' } : p)) } : f,
      );
      setAvatarTick(t => t + 1);
      notify.ok('avatar removed');
    } catch (e) {
      notify.err(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  // ── prompt-library helpers ─────────────────────────────────────────────────
  const addPromptPreset = (preset: DjPromptPreset) =>
    setForm(f => f ? { ...f, djPrompts: [...f.djPrompts, preset] } : f);
  const patchPromptPreset = (id: string, patch: Partial<Pick<DjPromptPreset, 'name' | 'text'>>) =>
    setForm(f => f ? { ...f, djPrompts: f.djPrompts.map(p => (p.id === id ? { ...p, ...patch } : p)) } : f);
  const removePromptPreset = (id: string) =>
    setForm(f => f
      ? {
          ...f,
          djPrompts: f.djPrompts.filter(p => p.id !== id),
          // Deleting the in-use template falls back to the built-in default.
          activeDjPromptId: f.activeDjPromptId === id ? '' : f.activeDjPromptId,
        }
      : f);

  // ── validation ───────────────────────────────────────────────────────────
  const promptsOk = form
    ? form.djPrompts.every(promptPresetValid)
      && (form.activeDjPromptId === '' || form.djPrompts.some(p => p.id === form.activeDjPromptId))
    : false;
  const allPersonasOk = form ? form.personas.every(p => personaValid(p)) : false;
  const canSave = !!form && allPersonasOk && promptsOk
    && form.personas.some(p => p.id === form.activePersonaId);

  const save = async (): Promise<boolean> => {
    if (!canSave || !form) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personas: form.personas.map(p => ({
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
              // Sanitize voice for the target engine. The `voice` field is
              // shared across engines, so a leftover value from a previous
              // engine (e.g. a Kokoro id "bm_george" still in state after
              // switching to Chatterbox) would fail the server's validator.
              voice: voiceForSave(p.tts.engine, p.tts.voice.trim()),
              // Per-persona voice-level trim (dB). Server clamps to ±12.
              gainDb: p.tts.gainDb ?? 0,
              // Per-persona speech-rate multiplier. Server clamps to 0.5–2.0×.
              speed: p.tts.speed ?? 1,
            },
            skills: p.skills,
          })),
          activePersonaId: form.activePersonaId,
          djPrompts: form.djPrompts.map(p => ({ id: p.id, name: p.name.trim(), text: p.text.trim() })),
          activeDjPromptId: form.activeDjPromptId,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok('personas saved, applies on the next spoken line');
      await load();
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  // ── discard ──────────────────────────────────────────────────────────────
  // Discard has to actually revert. `form` is the only copy of the roster the
  // UI reads, and save() POSTs the WHOLE array — so simply closing the editor
  // left the abandoned edits live: the roster kept showing them, a half-filled
  // new persona blocked Save for every OTHER persona ("another persona in the
  // roster is incomplete"), and the next save of any persona shipped them to
  // the server. Issue #1106.
  //
  // The revert is scoped to the persona being edited, not the whole form:
  // Discard sits inside a single persona's editor, so it must not silently drop
  // edits made to a different persona in the same session.
  const discardPersona = async (): Promise<void> => {
    // Close the editor FIRST, before the settings round-trip. The click already
    // means "stop editing", and an editor left open across the fetch re-raises
    // the unsaved-changes confirm: clicking inside the confirm counts as an
    // interaction outside the editor, so its dismissable layer fires onClose
    // while the form is still dirty.
    setConfirmDiscard(false);
    setEditorOpen(false);
    setBusy(true);
    try {
      // Fresh server truth, falling back to the last snapshot we loaded. Never
      // revert against nothing: `stored` missing is what marks a persona as
      // never-saved, so an empty response would turn Discard into Delete.
      const server = formFromSettings(await load()) ?? formFromSettings(data);
      if (!server) {
        notify.err('could not reach the controller — your changes were kept');
        return;
      }
      setForm(f => {
        if (!f) return f;
        // Clamp here rather than closing over the render's `safeIdx` — the
        // roster can shift between render and click (an install lands, say).
        const idx = Math.min(focusIdx, f.personas.length - 1);
        const target = f.personas[idx];
        if (!target) return f;
        const stored = server.personas.find(p => p.id === target.id);
        // Never saved (added in this session) → it leaves the roster entirely.
        const personas = stored
          ? f.personas.map((p, i) => (i === idx ? stored : p))
          : f.personas.filter((_, i) => i !== idx);
        if (!personas.length) return f; // paranoia: keep at least one persona
        // "Set as default" is a form edit too. Undo it when it pointed at the
        // persona we just reverted, then make sure the id still resolves.
        let activePersonaId = f.activePersonaId === target.id
          ? server.activePersonaId
          : f.activePersonaId;
        if (!personas.some(p => p.id === activePersonaId)) {
          activePersonaId = personas[0]!.id;
        }
        return { ...f, personas, activePersonaId };
      });
      // focusIdx needs no adjustment — the render clamps it to the roster
      // length (`safeIdx`), so a removal just lands focus on the neighbour.
      setCreatingId(null);
      notify.ok('changes discarded');
    } finally { setBusy(false); }
  };

  // Same contract for the prompt library: revert the templates from the server
  // and leave the personas alone.
  const discardPrompts = async (): Promise<void> => {
    setShowPrompt(false);
    setBusy(true);
    try {
      const j = await load();
      if (!j) {
        notify.err('could not reach the controller — your changes were kept');
        return;
      }
      const { djPrompts, activeDjPromptId } = promptLibraryFromSettings(j);
      setForm(f => f ? { ...f, djPrompts, activeDjPromptId } : f);
      notify.ok('changes discarded');
    } finally { setBusy(false); }
  };

  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <div className="text-[13px] text-[var(--danger)]">controller error: {err}</div>
        </Card>
      </div>
    );
  }
  if (!form) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <div className="text-[13px] text-muted italic">loading…</div>
        </Card>
      </div>
    );
  }

  // clamp focus to a valid index after add/remove
  const safeIdx = Math.min(focusIdx, form.personas.length - 1);
  const focused = form.personas[safeIdx];
  if (!focused) {
    return (
      <div className="grid gap-4">
        <Card title="Personas">
          <div className="text-[13px] text-muted italic">no personas configured</div>
        </Card>
      </div>
    );
  }

  const activePersona = form.personas.find(p => p.id === form.activePersonaId);
  // Who's actually on air now: the controller's effective persona (a scheduled
  // show can override the default). Fall back to the default selection when the
  // controller predates the onAir field.
  const onAirPersonaId = data?.onAir?.personaId || form.activePersonaId;
  const onAirPersona = form.personas.find(p => p.id === onAirPersonaId) || activePersona;
  const onAirShow = data?.onAir?.show || null;
  const focusedOk = personaValid(focused);
  // Does the focused persona differ from what the controller has stored? Drives
  // the confirm on ×/Escape — closing the editor keeps edits pending (they are
  // still in `form`), so leaving silently is how unsaved state used to ride
  // along on the next save.
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
        presets={form.djPrompts}
        activeId={form.activeDjPromptId}
        defaultPrompt={data?.defaults?.djPrompt || ''}
        busy={busy}
        canSave={canSave}
        allPersonasOk={allPersonasOk}
        promptsOk={promptsOk}
        onSetActive={(id) => setForm(f => f ? ({ ...f, activeDjPromptId: id }) : f)}
        onAddPreset={addPromptPreset}
        onPatchPreset={patchPromptPreset}
        onRemovePreset={removePromptPreset}
        onSave={async () => { if (await save()) setShowPrompt(false); }}
        onDiscard={() => { void discardPrompts(); }}
      />

      <PersonaRoster
        personas={form.personas}
        activePersonaId={form.activePersonaId}
        onAirPersonaId={onAirPersonaId}
        avatarTick={avatarTick}
        onOpenPrompt={() => setShowPrompt(true)}
        onAdd={addPersona}
        onSelect={(i) => { setCreatingId(null); setFocusIdx(i); setEditorOpen(true); }}
        communityCount={community?.length ?? null}
        onCommunity={() => setCommunityOpen(true)}
      />

      {/* ── COMMUNITY CATALOG MODAL ──────────────────────────────────────── */}
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
              const inRoster = form.personas.some(
                p => p.name.trim().toLowerCase() === c.displayName.trim().toLowerCase(),
              );
              return (
                <div key={c.slug} className="grid grid-cols-[1fr_auto] items-center gap-4 border border-ink p-3">
                  <div>
                    <div className="flex items-center gap-2">
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
                        tone="accent"
                        onClick={() => installCommunity(c.slug)}
                        disabled={installing === c.slug || form.personas.length >= PERSONA_MAX}
                        title={form.personas.length >= PERSONA_MAX ? 'The roster is full' : undefined}
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
        personaCount={form.personas.length}
        activePersonaId={form.activePersonaId}
        onAirPersonaId={onAirPersonaId}
        data={data}
        adminFetch={adminFetch}
        avatarTick={avatarTick}
        uploadingId={uploadingId}
        defaultEngine={defaultEngine}
        cloudIssueText={focusedCloudIssue}
        skillCatalog={skillCatalog}
        editorRef={editorRef}
        open={editorOpen}
        isNew={focused.id === creatingId}
        // ×/Escape with unsaved edits asks first — closing used to keep them
        // pending in `form`, which is the other half of issue #1106.
        onClose={() => { if (focusedDirty) setConfirmDiscard(true); else setEditorOpen(false); }}
        setPersona={setPersona}
        setPersonaTts={setPersonaTts}
        setPersonaSkills={setPersonaSkills}
        onUploadAvatar={uploadAvatar}
        onGenerateAvatar={generateAvatar}
        onClearAvatar={clearAvatar}
        onSetActive={() => setForm(f => f ? ({ ...f, activePersonaId: focused.id }) : f)}
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
            <b>{confirmDeleteIdx !== null ? (form.personas[confirmDeleteIdx]?.name.trim() || 'this persona') : 'this persona'}</b>
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
