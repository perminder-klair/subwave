'use client';
// Persona roster — a list of cards (one per persona), matching the skills list:
// avatar + tagline + meta pills on the left, status pills + Edit on the right.
// Click Edit to open the full-screen editor; adding lives in the hero's
// "+ Add persona" button.
import { Users } from 'lucide-react';
import type { Persona } from './types';
import { API_BASE, PERSONA_MAX } from './constants';
import { initialsFor, personaValid } from './helpers';
import { Card, Btn, Pill } from '../ui';

interface PersonaRosterProps {
  personas: Persona[];
  // The admin-selected default — gets the "default" pill.
  activePersonaId: string;
  // The persona actually broadcasting now (show override aware) — gets the
  // "on air" pill. Equals activePersonaId unless a show overrides.
  onAirPersonaId: string;
  avatarTick: number;
  // Opens the system-prompt library modal.
  onOpenPrompt: () => void;
  onAdd: () => void;
  onSelect: (idx: number) => void;
  // Shipped community catalog size (null = still loading — button disabled).
  communityCount: number | null;
  onCommunity: () => void;
}

export function PersonaRoster({
  personas, activePersonaId, onAirPersonaId, avatarTick,
  onOpenPrompt, onAdd, onSelect, communityCount, onCommunity,
}: PersonaRosterProps) {
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="caption">roster · {personas.length} / {PERSONA_MAX}</span>
        <div className="flex flex-wrap gap-2">
          <Btn
            onClick={onCommunity}
            disabled={communityCount === null}
            title="Browse and install personas shared by other stations"
          >
            <Users size={14} /> Community
            {communityCount !== null && communityCount > 0 && (
              <span className="ml-1 text-vermilion">{communityCount}</span>
            )}
          </Btn>
          <Btn onClick={onOpenPrompt}>System prompt</Btn>
          <Btn tone="accent" onClick={onAdd} disabled={personas.length >= PERSONA_MAX}>
            + Add persona
          </Btn>
        </div>
      </div>
      {personas.map((p, i) => {
        const isOnAir = p.id === onAirPersonaId;
        const isDefault = p.id === activePersonaId;
        const valid = personaValid(p);
        const src = p.avatar
          ? `${API_BASE}/persona-avatar/${encodeURIComponent(p.id)}?v=${avatarTick}`
          : null;
        return (
          <Card
            key={p.id}
            title={p.name.trim() || `Persona ${i + 1}`}
            right={
              <>
                {isOnAir && <Pill tone="accent" dot>on air</Pill>}
                {isDefault && !isOnAir && <Pill>default</Pill>}
                {!valid && (
                  <Pill className="border-[var(--danger)] text-[var(--danger)]">incomplete</Pill>
                )}
              </>
            }
          >
            <div className="grid grid-cols-[1fr_auto] items-center gap-4">
              <div className="flex min-w-0 items-start gap-3">
                {/* Initials sit behind the image so a missing / broken avatar
                    still shows a readable placeholder. */}
                <span className="relative grid size-11 flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]">
                  <span className="text-[13px] font-extrabold text-muted">{initialsFor(p.name)}</span>
                  {src && (
                    <img
                      src={src}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={e => { e.currentTarget.style.visibility = 'hidden'; }}
                    />
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] leading-[1.6] text-muted">
                    {p.tagline.trim() || 'no tagline'}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Pill className="text-[8px]">{p.frequency}</Pill>
                    {p.scriptLength !== 'concise' && <Pill className="text-[8px]">{p.scriptLength}</Pill>}
                    <Pill className="text-[8px]">{p.tts.engine}</Pill>
                    {p.tts.engine !== 'piper' && p.tts.voice.trim() && (
                      <Pill className="max-w-[120px] truncate text-[8px]">{p.tts.voice.trim()}</Pill>
                    )}
                    <Pill className="text-[8px]">
                      {p.skills.length} skill{p.skills.length === 1 ? '' : 's'}
                    </Pill>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Btn className="min-w-[92px]" onClick={() => onSelect(i)}>Edit</Btn>
              </div>
            </div>
          </Card>
        );
      })}
    </section>
  );
}
