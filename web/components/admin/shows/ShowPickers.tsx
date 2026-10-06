'use client';

// Visual pickers for the show editor's "persona owner" and "theme override"
// fields. Swatch colours route through useDynamicStyle because the lint rule (#50)
// bans the inline `style` prop.

import { useRef, useState } from 'react';
import { cn } from '../../../lib/cn';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { SkeletonText } from '../../ui/skeleton';
import { Input } from '../../ui/input';
import { SWATCH_KEYS } from '../../../lib/theme-tokens.generated';
import type { PlaylistIndexStatus } from './types';

interface PersonaOpt {
  id: string;
  name?: string;
  tagline?: string;
  avatar?: string;
  tts?: { engine?: string; voice?: string };
}

interface ThemeOpt {
  id: string;
  name: string;
  mode?: string;
  description?: string;
  tokens?: Record<string, string>;
}

// When the active theme's tokens aren't known, paint the live CSS variables so the
// "Station default" card still shows the real palette.
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

// The host is excluded by the caller; unselected cards go inert once `max` guests
// are picked.
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
    if (value.includes(id)) onChange(value.filter(v => v !== id));
    else if (value.length < max) onChange([...value, id]);
  };
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {personas.map(p => {
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
                  onError={e => {
                    e.currentTarget.style.visibility = 'hidden';
                  }}
                />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-extrabold text-ink">{p.name?.trim() || 'Unnamed'}</span>
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
        {SWATCH_KEYS.map(k => (
          <Swatch key={k} color={tokens?.[k]} />
        ))}
      </span>
      <span className="truncate text-[11px] font-bold tracking-[0.08em] uppercase">{name}</span>
    </button>
  );
}

interface PlaylistOpt {
  id: string;
  name: string;
  songCount: number | null;
}

// Checkbox list for the show's playlist anchor / exclusion sets.
//
// Pinned ids that no longer resolve get a row of their own: a playlist deleted
// in Navidrome leaves its id behind on the show, and rendering only the live
// index left it with no checkbox — invisible and unremovable, while failing to
// resolve on every pick cycle.
//
// `status` gates that: a pending or failed /dj/playlists fetch also leaves the
// index empty, and flagging every working anchor as missing there would invite
// the operator to delete good config. Unknown means "say nothing", not "say
// gone" — an empty index is only genuinely empty under `ready`.
export function PlaylistPicker({
  playlists,
  status,
  selected,
  max,
  onChange,
  searchLabel,
}: {
  playlists: PlaylistOpt[];
  status: PlaylistIndexStatus;
  selected: string[];
  max: number;
  onChange: (next: string[]) => void;
  searchLabel: string;
}) {
  const [search, setSearch] = useState('');
  const missing = status === 'ready' ? selected.filter(id => !playlists.some(p => p.id === id)) : [];

  // Same box as the loaded list so the field doesn't jump when it resolves.
  if (status === 'loading') {
    return (
      <div className="grid max-h-44 gap-1 overflow-y-auto border border-ink bg-[var(--ink-softer)] p-2">
        <SkeletonText lines={4} label="Loading Navidrome playlists" />
      </div>
    );
  }

  // No rows at all here: without the index there is no name to put beside a
  // pinned id, and a bare id list is the "is this gone?" ambiguity this picker
  // exists to remove. Say the index is unavailable and leave the config alone.
  if (status === 'error') {
    return (
      <span className="field-hint opacity-60">
        Couldn&apos;t reach Navidrome to list playlists, so this show&apos;s pinned playlists are left as they are.
        Reopen this panel to try again.
      </span>
    );
  }

  if (!playlists.length && !missing.length) {
    return (
      <span className="field-hint opacity-60">
        No Navidrome playlists found yet. Create some in Navidrome, then reopen this panel.
      </span>
    );
  }

  const atCap = selected.length >= max;
  const matching = playlists.filter(playlist =>
    playlist.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <Input
          type="search"
          aria-label={searchLabel}
          placeholder="Find a playlist…"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <span className="flex-none text-[11px] text-muted tabular-nums">
          {selected.length}/{max} selected
        </span>
      </div>
      <div className="grid max-h-52 gap-1 overflow-y-auto border border-ink bg-[var(--ink-softer)] p-2">
        {matching.map(pl => {
          const checked = selected.includes(pl.id);
          const capped = !checked && atCap;
          return (
            <label
              key={pl.id}
              className={cn('flex items-center gap-2 text-sm', capped ? 'opacity-40' : 'cursor-pointer')}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={capped}
                onChange={() => onChange(checked ? selected.filter(id => id !== pl.id) : [...selected, pl.id])}
              />
              <span className="truncate">{pl.name}</span>
              {pl.songCount != null && <span className="field-hint">({pl.songCount})</span>}
            </label>
          );
        })}
        {missing.map(id => (
          <label
            key={id}
            className="flex cursor-pointer items-center gap-2 text-sm opacity-70"
            title={`Playlist ${id} no longer exists in Navidrome. Uncheck to remove it from this show.`}
          >
            <input type="checkbox" checked onChange={() => onChange(selected.filter(x => x !== id))} />
            <span className="truncate">(missing) {id}</span>
            <span className="field-hint">deleted in Navidrome</span>
          </label>
        ))}
        {matching.length === 0 && <p className="p-2 text-xs text-muted">No playlists match this search.</p>}
      </div>
    </div>
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
  const active = themes.find(t => t.id === activeThemeId);
  return (
    <div className="flex flex-wrap gap-2">
      <ThemeCard
        selected={!value}
        name="Station default"
        sub="follows the station palette"
        tokens={active?.tokens ?? LIVE_TOKENS}
        onClick={() => onChange('')}
      />
      {themes.map(t => (
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
