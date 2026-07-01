'use client';
// "Editing · <name>" card: AI fill, avatar, name, tagline, soul, language.
// Two columns from lg up so the soul textarea sits beside the identity fields
// instead of running the full editor width.
import type { ChangeEvent } from 'react';
import type { Persona } from './types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { NAME_MAX, TAGLINE_MAX, SOUL_MAX, LANGUAGE_MAX } from './constants';
import { Card } from '../ui';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { Label } from '../../ui/label';
import { AiFill } from '../AiFill';
import { PersonaAvatarPicker } from './PersonaAvatarPicker';
import { cn } from '../../../lib/cn';

interface PersonaIdentityCardProps {
  persona: Persona;
  isNew: boolean;       // show the AI-draft field only while creating
  adminFetch: AdminAuth['adminFetch'];
  avatarTick: number;
  uploading: boolean;
  update: (patch: Partial<Persona>) => void;
  onPickAvatar: (file: File) => void;
  onGenerateAvatar: () => void;
  onClearAvatar: () => void;
}

export function PersonaIdentityCard({
  persona, isNew, adminFetch, avatarTick, uploading,
  update, onPickAvatar, onGenerateAvatar, onClearAvatar,
}: PersonaIdentityCardProps) {
  const soulLen = persona.soul.trim().length;
  const soulOver = soulLen > SOUL_MAX;
  return (
    <Card flat title="Identity">
      {isNew && (
        <div className="mb-4">
          <AiFill<Partial<Persona>>
            endpoint="/generate/persona"
            resultKey="persona"
            adminFetch={adminFetch}
            placeholder="e.g. a late-night jazz host with a dry wit"
            onApply={(p) => update(p)}
          />
        </div>
      )}

      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-8">
        {/* LEFT — avatar, name, tagline, language */}
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
              <div className="field">
                <Label>On-air name</Label>
                <Input
                  value={persona.name}
                  maxLength={NAME_MAX}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => update({ name: e.target.value })}
                  className={persona.name.trim() ? 'border-ink' : 'border-[var(--danger)]'}
                />
                <div className="field-hint">
                  Shown in the player and injected into every prompt as <code>{'{name}'}</code>.
                  <span className="ml-2 text-muted">{persona.name.trim().length} / {NAME_MAX}</span>
                </div>
              </div>
              <div className="field">
                <Label>Tagline</Label>
                <Input
                  value={persona.tagline}
                  maxLength={TAGLINE_MAX}
                  placeholder="e.g. late-night drift"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => update({ tagline: e.target.value })}
                />
                <div className="field-hint">
                  A short line shown alongside the persona. Optional.
                  <span className="ml-2 text-muted">{persona.tagline.trim().length} / {TAGLINE_MAX}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="field">
            <Label>Language</Label>
            <Input
              value={persona.language}
              maxLength={LANGUAGE_MAX}
              placeholder="English (default)"
              onChange={(e: ChangeEvent<HTMLInputElement>) => update({ language: e.target.value })}
            />
            <div className="field-hint">
              The DJ speaks every on-air line in this language. Leave empty for English.
              Pick a voice that can actually speak it.
              <span className="ml-2 text-muted">{persona.language.trim().length} / {LANGUAGE_MAX}</span>
            </div>
          </div>
        </div>

        {/* RIGHT — soul */}
        <div className="field mt-4 lg:mt-0">
          <Label>Soul</Label>
          <Textarea
            rows={9}
            value={persona.soul}
            placeholder="e.g. warm and dry, never corny, observant, favours one good image over a list"
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => update({ soul: e.target.value })}
            className={soulOver || soulLen === 0 ? 'border-[var(--danger)]' : 'border-ink'}
          />
          <div className="field-hint">
            One short personality sketch. Injected into the prompt as <code>{'{soul}'}</code>.
            <span className={cn('ml-2', soulOver ? 'text-[var(--danger)]' : 'text-muted')}>
              {soulLen} / {SOUL_MAX}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}
