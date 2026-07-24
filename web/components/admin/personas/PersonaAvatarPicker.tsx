'use client';
// Avatar square + Upload / Generate / Remove buttons for the focused persona.
import { useRef } from 'react';
import type { Persona } from './types';
import { API_BASE } from './constants';
import { initialsFor } from './helpers';
import { Btn } from '../ui';
import { Label } from '../../ui/label';

interface PersonaAvatarPickerProps {
  persona: Persona;
  tick: number;
  uploading: boolean;
  onPick: (file: File) => void;
  onGenerate: () => void;
  onClear: () => void;
}

export function PersonaAvatarPicker({ persona, tick, uploading, onPick, onGenerate, onClear }: PersonaAvatarPickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The public endpoint serves a 1×1 transparent placeholder when no avatar
  // is set; rather than render that as a tiny grey square, fall back to
  // initials in the admin UI. The ?v=… buster forces a refetch after upload.
  const hasAvatar = !!persona.avatar;
  const src = hasAvatar
    ? `${API_BASE}/persona-avatar/${encodeURIComponent(persona.id)}?v=${tick}`
    : null;
  return (
    <div className="grid gap-2">
      <Label>Avatar</Label>
      <div
        className="relative grid h-[96px] w-[96px] place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]"
        aria-label={hasAvatar ? `${persona.name} avatar` : 'No avatar set'}
      >
        {/* Initials behind the image so a missing / transparent / broken avatar
            still shows a readable placeholder. */}
        <span className="text-[22px] font-extrabold tracking-[-0.02em] text-muted">
          {initialsFor(persona.name)}
        </span>
        {src && (
          <img
            src={src}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            onError={e => { e.currentTarget.style.visibility = 'hidden'; }}
          />
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label="Upload avatar image"
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // Reset so picking the same file twice still fires onChange.
          e.target.value = '';
        }}
      />
      <div className="grid w-[96px] gap-1.5">
        <Btn sm className="w-full justify-center" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? '…' : hasAvatar ? 'Replace' : 'Upload'}
        </Btn>
        <Btn sm className="w-full justify-center" onClick={onGenerate} disabled={uploading} title="Random DiceBear avatar. Click again for a different one">
          Generate
        </Btn>
        {hasAvatar && (
          <Btn sm tone="danger" className="w-full justify-center" onClick={onClear} disabled={uploading}>
            Remove
          </Btn>
        )}
      </div>
    </div>
  );
}
