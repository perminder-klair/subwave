'use client';
// Full-width editor for the focused persona: identity, behaviour, voice and
// skills cards plus the save bar. Binds the index-taking mutators down to the
// focused persona so the cards stay index-agnostic.
import type { RefObject } from 'react';
import type { Persona, PersonaTts, SettingsResponse, SkillCatalogEntry } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { Btn } from '../ui';
import { cn } from '../../../lib/cn';
import { PersonaIdentityCard } from './PersonaIdentityCard';
import { PersonaBehaviorCard } from './PersonaBehaviorCard';
import { PersonaVoiceCard } from './PersonaVoiceCard';
import { PersonaSkillsCard } from './PersonaSkillsCard';

interface PersonaEditorProps {
  persona: Persona;
  index: number;
  personaCount: number;
  activePersonaId: string;
  data: SettingsResponse | null;
  adminFetch: AdminAuth['adminFetch'];
  avatarTick: number;
  uploadingId: string | null;
  defaultEngine: string;
  cloudIssueText: string | null;
  skillCatalog: SkillCatalogEntry[];
  editorRef: RefObject<HTMLDivElement | null>;
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
  persona, index, personaCount, activePersonaId, data, adminFetch, avatarTick, uploadingId,
  defaultEngine, cloudIssueText, skillCatalog, editorRef,
  setPersona, setPersonaTts, setPersonaSkills,
  onUploadAvatar, onGenerateAvatar, onClearAvatar, onSetActive, onRemove,
  canSave, focusedOk, allPersonasOk, promptOk, busy, onSave, onDiscard,
}: PersonaEditorProps) {
  const update = (patch: Partial<Persona>) => setPersona(index, patch);
  const updateTts = (patch: Partial<PersonaTts>) => setPersonaTts(index, patch);
  const setSkills = (skills: string[]) => setPersonaSkills(index, skills);

  return (
    <div ref={editorRef} className="grid scroll-mt-4 gap-4">
      <PersonaIdentityCard
        persona={persona}
        index={index}
        personaCount={personaCount}
        isActive={persona.id === activePersonaId}
        canRemove={personaCount > 1}
        adminFetch={adminFetch}
        avatarTick={avatarTick}
        uploading={uploadingId === persona.id}
        update={update}
        onSetActive={onSetActive}
        onRemove={onRemove}
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
        updateTts={updateTts}
      />

      <PersonaSkillsCard persona={persona} skillCatalog={skillCatalog} setSkills={setSkills} />

      {/* Save bar */}
      <div className="flex flex-wrap items-center gap-3 border border-ink bg-[var(--ink-softer)] p-3">
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
        <span className="ml-auto flex gap-2">
          <Btn onClick={onDiscard} disabled={busy}>Discard</Btn>
          <Btn tone="accent" onClick={onSave} disabled={busy || !canSave}>
            {busy ? 'Saving…' : 'Save persona'}
          </Btn>
        </span>
      </div>
    </div>
  );
}
