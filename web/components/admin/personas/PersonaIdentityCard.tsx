'use client';
import type { Control } from 'react-hook-form';
import { useController } from 'react-hook-form';
import type { Persona, PersonasFormValues } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { NAME_MAX, TAGLINE_MAX, SOUL_MAX, MUSIC_LEAN_MAX, LANGUAGE_MAX, TAGS_MAX, TAG_MAX, TAG_RE } from './constants';
import { Card } from '../ui';
import { TagField } from '../TagField';
import { Label } from '../../ui/label';
import { TextField, TextareaField } from '@/lib/form-fields';
import { AiFill } from '../AiFill';
import { PersonaAvatarPicker } from './PersonaAvatarPicker';

interface PersonaIdentityCardProps {
  persona: Persona;
  index: number;
  control: Control<PersonasFormValues>;
  isNew: boolean;       // show the AI-draft field only while creating
  adminFetch: AdminAuth['adminFetch'];
  avatarTick: number;
  uploading: boolean;
  // The AI-draft "apply" is the one remaining multi-field bulk patch — every
  // keystroke field below is bound straight to `control` instead.
  onUpdate: (patch: Partial<Persona>) => void;
  // Tags already used by the OTHER personas, offered as one-click adds so the
  // roster converges on one vocabulary instead of near-duplicates.
  tagSuggestions: string[];
  onTagDraftBlockedChange: (blocked: boolean) => void;
  onPickAvatar: (file: File) => void;
  onGenerateAvatar: () => void;
  onClearAvatar: () => void;
}

export function PersonaIdentityCard({
  persona, index, control, isNew, adminFetch, avatarTick, uploading, tagSuggestions,
  onTagDraftBlockedChange,
  onUpdate, onPickAvatar, onGenerateAvatar, onClearAvatar,
}: PersonaIdentityCardProps) {
  const soulLen = persona.soul.trim().length;
  const musicLeanLen = persona.musicLean.trim().length;
  const tagsCtl = useController({ control, name: `personas.${index}.tags` });
  return (
    <Card flat title="Identity">
      {isNew && (
        <div className="mb-4">
          <AiFill<Partial<Persona>>
            endpoint="/generate/persona"
            resultKey="persona"
            adminFetch={adminFetch}
            placeholder="e.g. a late-night jazz host with a dry wit"
            onApply={(p) => onUpdate(p)}
          />
        </div>
      )}

      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        <div className="grid gap-4">
          <div className="stack-mobile grid grid-cols-[96px_1fr] items-start gap-4">
            <PersonaAvatarPicker
              persona={persona}
              tick={avatarTick}
              uploading={uploading}
              onPick={onPickAvatar}
              onGenerate={onGenerateAvatar}
              onClear={onClearAvatar}
            />
            <div className="grid gap-4">
              <div>
                <TextField
                  control={control}
                  name={`personas.${index}.name`}
                  label="On-air name"
                  maxLength={NAME_MAX}
                />
                <div className="field-hint">
                  Shown in the player and injected into every prompt as <code>{'{name}'}</code>.
                  <span className="ml-2 text-muted">{persona.name.trim().length} / {NAME_MAX}</span>
                </div>
              </div>
              <div>
                <TextField
                  control={control}
                  name={`personas.${index}.tagline`}
                  label="Tagline"
                  placeholder="e.g. late-night drift"
                  maxLength={TAGLINE_MAX}
                />
                <div className="field-hint">
                  A short line shown alongside the persona. Optional.
                  <span className="ml-2 text-muted">{persona.tagline.trim().length} / {TAGLINE_MAX}</span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <TextField
              control={control}
              name={`personas.${index}.language`}
              label="Language"
              placeholder="English (default)"
              maxLength={LANGUAGE_MAX}
            />
            <div className="field-hint">
              The DJ <em>writes</em> every on-air line in this language; leave empty for English.
              The <em>accent</em> comes from the voice, not this field, so set a matching voice
              in the Voice section below (e.g. a Piper <code>it_IT-*.onnx</code> in{' '}
              <code>state/voices/</code>, or a Cloud voice). An English-only voice reads it
              with an English accent.
              <span className="ml-2 text-muted">{persona.language.trim().length} / {LANGUAGE_MAX}</span>
            </div>
          </div>

          {/* Filing, not personality: tags never reach a prompt, the public
              roster or anything on air. They group this list and stop there,
              which is why they sit below the fold of Identity rather than
              beside Soul. */}
          <div>
            <Label>Tags</Label>
            <TagField
              className="mt-1.5"
              value={tagsCtl.field.value || []}
              onChange={tagsCtl.field.onChange}
              pattern={TAG_RE}
              max={TAGS_MAX}
              charMax={TAG_MAX}
              suggestions={tagSuggestions}
              noun="DJ"
              onDraftBlockedChange={onTagDraftBlockedChange}
            />
            <div className="field-hint">
              Freeform filing for the roster — by station, by shift, by whatever
              you group on. Up to {TAGS_MAX}. Nothing on air reads them.
            </div>
          </div>
        </div>

        <div className="mt-4 lg:mt-0">
          <TextareaField
            control={control}
            name={`personas.${index}.soul`}
            label="Soul"
            rows={14}
            placeholder="e.g. warm and dry, never corny, observant, favours one good image over a list"
          />
          <div className="field-hint">
            One short personality sketch. Injected into the prompt as <code>{'{soul}'}</code>.
            <span className="ml-2 text-muted">{soulLen} / {SOUL_MAX}</span>
          </div>
          <div className="mt-4">
            <TextareaField
              control={control}
              name={`personas.${index}.musicLean`}
              label="Musical Leanings"
              rows={4}
              placeholder="e.g. favour melodic post-punk, deep soul cuts and surprising cover versions"
              maxLength={MUSIC_LEAN_MAX}
            />
            <div className="field-hint">
              A private, soft tie-breaker for track selection. It never changes the presenter&apos;s voice,
              overrides show rules, or goes on air.
              <span className="ml-2 text-muted">{musicLeanLen} / {MUSIC_LEAN_MAX}</span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
