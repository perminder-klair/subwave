'use client';

// Visual pickers for the show editor's "persona owner" and "theme override"
// fields — richer replacements for the plain name dropdowns.
//
//  • PersonaPicker — a card grid showing each host's avatar (initials
//    fallback), name and tagline, so you pick a face, not a string.
//  • ThemePicker  — swatch cards showing each palette's actual colours, plus a
//    "Station default" card that mirrors the live station palette.
//
// Both mirror existing admin patterns: the persona card from
// personas/PersonaRoster, the swatch strip + SWATCH_KEYS from SettingsPanel's
// theme gallery. Swatch colours route through useDynamicStyle because the lint
// rule (#50) bans the inline `style` prop.

import { useRef } from 'react';
import { cn } from '../../lib/cn';
import { useDynamicStyle } from '../../hooks/useDynamicStyle';

export interface PersonaOpt {
  id: string;
  name?: string;
  tagline?: string;
  avatar?: string;
  tts?: { engine?: string; voice?: string };
}

export interface ThemeOpt {
  id: string;
  name: string;
  mode?: string;
  description?: string;
  tokens?: Record<string, string>;
}

// Read the palette at a glance: paper, ink, accent, overlay — same four the
// admin theme gallery shows.
const SWATCH_KEYS = ['--bg', '--ink', '--accent', '--overlay'] as const;
// Fallback for the "Station default" card when the active theme's tokens aren't
// known: paint the live CSS variables so it still shows the real palette.
const LIVE_TOKENS: Record<string, string> = {
  '--bg': 'var(--bg)',
  '--ink': 'var(--ink)',
  '--accent': 'var(--accent)',
  '--overlay': 'var(--overlay)',
};

const cardClass = (selected: boolean) =>
  cn(
    'flex min-w-0 items-center border text-left font-[inherit] transition-colors',
    selected
      ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
      : 'border-ink bg-[var(--card-bg)] hover:bg-[var(--overlay)]',
  );

function initials(name?: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? '';
  if (!first) return '—';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return (first.slice(0, 1) + last.slice(0, 1)).toUpperCase();
}

function Swatch({ color }: { color?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color || 'transparent' });
  return <span ref={ref} className="h-5 w-5" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------

export function PersonaPicker({
  personas,
  value,
  onChange,
  apiBase,
}: {
  personas: PersonaOpt[];
  value: string;
  onChange: (id: string) => void;
  apiBase: string;
}) {
  if (!personas.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {personas.map((p) => {
        const selected = p.id === value;
        const src = p.avatar ? `${apiBase}/persona-avatar/${encodeURIComponent(p.id)}` : null;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            aria-pressed={selected}
            className={cn(cardClass(selected), 'gap-2.5 p-2.5')}
          >
            {/* Initials sit behind the image so a missing / broken avatar still
                shows a readable placeholder. */}
            <span className="relative grid size-9 flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]">
              <span className="text-[11px] font-extrabold text-muted">{initials(p.name)}</span>
              {src && (
                <img
                  src={src}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-extrabold text-ink">
                {p.name?.trim() || 'Unnamed'}
              </span>
              <span className="block truncate text-[11px] text-muted">
                {p.tagline?.trim() || 'no tagline'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

// Multi-select variant for the show's guest co-hosts: same persona cards, but
// each toggles in/out of the selection. The host is excluded by the caller;
// unselected cards go inert once `max` guests are picked.
export function GuestPersonaPicker({
  personas,
  value,
  onChange,
  apiBase,
  max,
}: {
  personas: PersonaOpt[];
  value: string[];
  onChange: (ids: string[]) => void;
  apiBase: string;
  max: number;
}) {
  if (!personas.length) return null;
  const toggle = (id: string) => {
    if (value.includes(id)) onChange(value.filter((v) => v !== id));
    else if (value.length < max) onChange([...value, id]);
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      {personas.map((p) => {
        const selected = value.includes(p.id);
        const full = !selected && value.length >= max;
        const src = p.avatar ? `${apiBase}/persona-avatar/${encodeURIComponent(p.id)}` : null;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => toggle(p.id)}
            aria-pressed={selected}
            disabled={full}
            className={cn(cardClass(selected), 'gap-2.5 p-2.5', full && 'opacity-40')}
          >
            <span className="relative grid size-9 flex-none place-items-center overflow-hidden border border-ink bg-[var(--ink-softer)]">
              <span className="text-[11px] font-extrabold text-muted">{initials(p.name)}</span>
              {src && (
                <img
                  src={src}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-extrabold text-ink">
                {p.name?.trim() || 'Unnamed'}
              </span>
              <span className="block truncate text-[11px] text-muted">
                {selected ? 'in the studio' : p.tagline?.trim() || 'no tagline'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemeCard({
  selected,
  name,
  sub,
  tokens,
  onClick,
}: {
  selected: boolean;
  name: string;
  sub?: string;
  tokens?: Record<string, string>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={sub}
      className={cn(cardClass(selected), 'gap-2 p-2')}
    >
      <span className="inline-flex shrink-0 border border-ink" aria-hidden="true">
        {SWATCH_KEYS.map((k) => (
          <Swatch key={k} color={tokens?.[k]} />
        ))}
      </span>
      <span className="truncate text-[11px] font-bold tracking-[0.08em] uppercase">{name}</span>
    </button>
  );
}

export function ThemePicker({
  themes,
  activeThemeId,
  value,
  onChange,
}: {
  themes: ThemeOpt[];
  activeThemeId: string;
  value: string; // '' = station default
  onChange: (id: string) => void;
}) {
  const active = themes.find((t) => t.id === activeThemeId);
  return (
    <div className="flex flex-wrap gap-2">
      <ThemeCard
        selected={!value}
        name="Station default"
        sub="follows the station palette"
        tokens={active?.tokens ?? LIVE_TOKENS}
        onClick={() => onChange('')}
      />
      {themes.map((t) => (
        <ThemeCard
          key={t.id}
          selected={value === t.id}
          name={t.name}
          sub={t.description || (t.mode === 'dark' ? 'Dark palette' : 'Light palette')}
          tokens={t.tokens}
          onClick={() => onChange(t.id)}
        />
      ))}
    </div>
  );
}
