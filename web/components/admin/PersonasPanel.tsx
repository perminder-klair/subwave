'use client';

// Personas editor — /admin/personas. The station's roster of DJ identities.
// One persona is "active" at a time (a scheduled Show can override which
// persona is on air for its hour). Each persona owns its name, tagline, talk
// frequency, soul, and full voice (TTS engine + cloud provider + voice).
// The system prompt is one global template shared by every persona.
// Everything POSTs to /settings and applies live — no mixer restart.
//
// This file is the stateful container: it owns the form, validation, save, and
// avatar mutations, and composes the presentational pieces in ./personas/*.
import { useEffect, useRef, useState } from 'react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Card } from './ui';
import { V3AlertDialog } from '../ui/alert-dialog';
import type { Persona, PersonaTts, FormState, SettingsResponse } from './personas/types';
import { DIAL_NEUTRAL, PERSONA_MAX, PROMPT_MIN, PROMPT_MAX } from './personas/constants';
import {
  clientMintId, fetchDicebearAvatar, fileToAvatarDataUrl, personaValid, voiceForSave, cloudIssue,
} from './personas/helpers';
import { PersonaHero } from './personas/PersonaHero';
import { SystemPromptCard } from './personas/SystemPromptCard';
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
  // toggles the system-prompt editor card
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
      const j = await initial();
      if (j?.values?.personas) {
        const v = j.values;
        const defaultPrompt = j.defaults?.djPrompt || '';
        const stored = v.djPrompt || '';
        const custom = stored !== '' && stored !== defaultPrompt;
        // Catalog of every skill. A persona with no stored `skills` (legacy /
        // code default) is treated as running all of them.
        const allSkills = (j.skills?.catalog || []).map(s => s.name);
        setForm({
          personas: (v.personas || []).map(p => ({
            id: p.id ?? clientMintId(),
            name: p.name ?? '',
            tagline: p.tagline ?? '',
            frequency: p.frequency ?? 'moderate',
            scriptLength: p.scriptLength ?? 'concise',
            djMode: p.djMode === true,
            humour: typeof p.humour === 'number' ? p.humour : DIAL_NEUTRAL,
            localColour: typeof p.localColour === 'number' ? p.localColour : DIAL_NEUTRAL,
            warmth: typeof p.warmth === 'number' ? p.warmth : DIAL_NEUTRAL,
            soul: p.soul ?? '',
            language: typeof p.language === 'string' ? p.language : '',
            avatar: typeof p.avatar === 'string' ? p.avatar : '',
            tts: {
              engine: p.tts?.engine ?? 'piper',
              cloudProvider: p.tts?.cloudProvider ?? 'openai',
              voice: p.tts?.voice ?? 'bf_isabella',
              gainDb: typeof p.tts?.gainDb === 'number' ? p.tts.gainDb : 0,
              speed: typeof p.tts?.speed === 'number' ? p.tts.speed : 1,
            },
            skills: Array.isArray(p.skills) ? p.skills : allSkills,
          })),
          activePersonaId: v.activePersonaId ?? '',
          useCustomPrompt: custom,
          systemPrompt: custom ? stored : defaultPrompt,
        });
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

  // ── validation ───────────────────────────────────────────────────────────
  const promptText = form ? form.systemPrompt.trim() : '';
  const promptOk = !form?.useCustomPrompt
    || (promptText.length >= PROMPT_MIN && promptText.length <= PROMPT_MAX && promptText.includes('{name}'));
  const allPersonasOk = form ? form.personas.every(p => personaValid(p)) : false;
  const canSave = !!form && allPersonasOk && promptOk
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
          djPrompt: form.useCustomPrompt ? form.systemPrompt.trim() : '',
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

      {showPrompt && (
        <SystemPromptCard
          useCustomPrompt={form.useCustomPrompt}
          systemPrompt={form.systemPrompt}
          defaultPrompt={data?.defaults?.djPrompt || ''}
          promptOk={promptOk}
          promptText={promptText}
          busy={busy}
          onSetUseCustom={(custom) => setForm(f => f ? ({ ...f, useCustomPrompt: custom }) : f)}
          onChangePrompt={(text) => setForm(f => f ? ({ ...f, systemPrompt: text }) : f)}
          onRestore={() => setForm(f => f ? ({ ...f, systemPrompt: data?.defaults?.djPrompt || '' }) : f)}
        />
      )}

      <PersonaRoster
        personas={form.personas}
        activePersonaId={form.activePersonaId}
        onAirPersonaId={onAirPersonaId}
        avatarTick={avatarTick}
        showPrompt={showPrompt}
        onTogglePrompt={() => setShowPrompt(s => !s)}
        onAdd={addPersona}
        onSelect={(i) => { setCreatingId(null); setFocusIdx(i); setEditorOpen(true); }}
      />

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
        onClose={() => setEditorOpen(false)}
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
        promptOk={promptOk}
        busy={busy}
        onSave={async () => { if (await save()) setEditorOpen(false); }}
        onDiscard={() => { load(); setEditorOpen(false); }}
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
