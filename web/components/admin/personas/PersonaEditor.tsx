'use client';
// Full-screen editor for the focused persona: identity, behaviour, voice and
// skills cards plus the save bar. Binds the index-taking mutators down to the
// focused persona so the cards stay index-agnostic. Rendered inside the shared
// EditorDialog (edge-to-edge, centered column) — the roster is the browse view,
// this is the edit surface.
import type { RefObject } from 'react';
import type { Persona, PersonaTts, SettingsResponse, SkillCatalogEntry } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { Btn, Eyebrow, Pill } from '../ui';
import { cn } from '../../../lib/cn';
import { EditorDialog } from '../../ui/editor-dialog';
import { PersonaIdentityCard } from './PersonaIdentityCard';
import { PersonaBehaviorCard } from './PersonaBehaviorCard';
import { PersonaVoiceCard } from './PersonaVoiceCard';
import { PersonaSkillsCard } from './PersonaSkillsCard';

interface PersonaEditorProps {
  persona: Persona;
  index: number;
  personaCount: number;
  activePersonaId: string;
  onAirPersonaId: string;
  data: SettingsResponse | null;
  adminFetch: AdminAuth['adminFetch'];
  avatarTick: number;
  uploadingId: string | null;
  defaultEngine: string;
  cloudIssueText: string | null;
  skillCatalog: SkillCatalogEntry[];
  editorRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  isNew: boolean;
  onClose: () => void;
  setPersona: (i: number, patch: Partial<Persona>) => void;
  setPersonaTts: (i: number, patch: Partial<PersonaTts>) => void;
  setPersonaSkills: (i: number, skills: string[]) => void;
  onUploadAvatar: (id: string, file: File) => void;
  onGenerateAvatar: (id: string) => void;
  onClearAvatar: (id: string) => void;
  onSetActive: () => void;
  onRemove: () => void;
  canSave: boolean;
  focusedOk: boolean;
  allPersonasOk: boolean;
  promptOk: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

export function PersonaEditor({
  persona, index, personaCount, activePersonaId, onAirPersonaId, data, adminFetch, avatarTick, uploadingId,
  defaultEngine, cloudIssueText, skillCatalog, editorRef, open, isNew, onClose,
  setPersona, setPersonaTts, setPersonaSkills,
  onUploadAvatar, onGenerateAvatar, onClearAvatar, onSetActive, onRemove,
  canSave, focusedOk, allPersonasOk, promptOk, busy, onSave, onDiscard,
}: PersonaEditorProps) {
  const update = (patch: Partial<Persona>) => setPersona(index, patch);
  const updateTts = (patch: Partial<PersonaTts>) => setPersonaTts(index, patch);
  const setSkills = (skills: string[]) => setPersonaSkills(index, skills);

  return (
    <EditorDialog
      open={open}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<Eyebrow className="text-vermilion">{isNew ? 'New persona' : 'Edit persona'}</Eyebrow>}
      sub={<span className="caption truncate">{persona.name.trim() || `Persona ${index + 1}`} · {index + 1} of {personaCount}</span>}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          {/* left — persona-scoped actions */}
          <span className="flex items-center gap-2">
            {persona.id === onAirPersonaId && <Pill tone="accent" className="text-[8px]">on air</Pill>}
            {persona.id === activePersonaId
              ? <Pill className="text-[8px]">default</Pill>
              : <Btn lg onClick={onSetActive}>Set as default</Btn>}
            <Btn
              lg
              tone="danger"
              onClick={onRemove}
              disabled={personaCount <= 1}
              title={personaCount > 1 ? 'Remove this persona' : 'At least one persona is required'}
            >
              Remove
            </Btn>
          </span>
          {/* right — status + discard/save */}
          <span className="ml-auto flex items-center gap-3">
            <span
              className={cn(
                'size-1.5 flex-none rounded-full',
                canSave ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
              )}
            />
            <span className="text-[11px] text-muted">
              {!canSave && !focusedOk
                ? <span className="text-[var(--danger)]">this persona has a missing or invalid field</span>
                : !canSave && !allPersonasOk
                  ? <span className="text-[var(--danger)]">another persona in the roster is incomplete</span>
                  : !canSave && !promptOk
                    ? <span className="text-[var(--danger)]">fix the custom system prompt</span>
                    : 'changes apply on the next spoken line · no mixer restart'}
            </span>
            <Btn lg onClick={onDiscard} disabled={busy}>Discard</Btn>
            <Btn lg tone="accent" onClick={onSave} disabled={busy || !canSave}>
              {busy ? 'Saving…' : 'Save persona'}
            </Btn>
          </span>
        </div>
      }
    >
      <div ref={editorRef} className="grid">
        <PersonaIdentityCard
          persona={persona}
          isNew={isNew}
          adminFetch={adminFetch}
          avatarTick={avatarTick}
          uploading={uploadingId === persona.id}
          update={update}
          onPickAvatar={(file) => onUploadAvatar(persona.id, file)}
          onGenerateAvatar={() => onGenerateAvatar(persona.id)}
          onClearAvatar={() => onClearAvatar(persona.id)}
        />

        <PersonaBehaviorCard persona={persona} update={update} />

        <PersonaVoiceCard
          persona={persona}
          data={data}
          defaultEngine={defaultEngine}
          cloudIssueText={cloudIssueText}
          adminFetch={adminFetch}
          updateTts={updateTts}
        />

        <PersonaSkillsCard persona={persona} skillCatalog={skillCatalog} setSkills={setSkills} />
      </div>
    </EditorDialog>
  );
}
