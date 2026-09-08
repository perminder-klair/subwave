'use client';

// Shapes, vocab and the small formatters the playlist builder shares.

import { SHOW_ENERGY } from '@/lib/schemas.generated';

export const API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';

// No mood list here: moods are operator-editable (/admin/moods), so the panel
// reads the live names off /settings (tts.moods). Energy IS fixed, and its one
// home is the show schema — read out of the mirror, never re-declared.
export const ENERGIES: readonly string[] = SHOW_ENERGY;
export type ArcShape = 'flat' | 'build' | 'peak-then-cool' | 'wind-down';
export const ARCS: { id: ArcShape; label: string; hint: string }[] = [
  { id: 'flat', label: 'Steady', hint: 'even energy throughout' },
  { id: 'build', label: 'Build', hint: 'calm → energetic' },
  { id: 'peak-then-cool', label: 'Peak', hint: 'rise, then cool down' },
  { id: 'wind-down', label: 'Wind down', hint: 'high → mellow' },
];
// Band domains. Anchors parked at the extremes mean "unbounded" on that end.
export const LEN_MAX = 600;                              // track length: 0 → 10:00, 15s notches
export const LEN_STEP = 15;
export const BPM_MIN = 60;                               // tempo: 60 → 200 bpm, 5 bpm notches
export const BPM_MAX = 200;
export const BPM_STEP = 5;
export const YEAR_MIN = 1950;                            // release year: 1950 → current year
export const YEAR_MAX = new Date().getFullYear();

// Theme-aware mixes, so dark mode keeps the same low/med/high contrast. Raw values
// feed SVG `fill` attributes; the class twins style HTML swatches.
export const EN_LOW = 'color-mix(in oklab, var(--ink) 22%, var(--bg))';
export const EN_MED = 'color-mix(in oklab, var(--ink) 80%, var(--bg))';
export const EN_HIGH = 'var(--accent)';
export const EN_LOW_BG = 'bg-[color-mix(in_oklab,var(--ink)_22%,var(--bg))]';
export const EN_MED_BG = 'bg-[color-mix(in_oklab,var(--ink)_80%,var(--bg))]';
export const EN_HIGH_BG = 'bg-[var(--accent)]';

export type View = 'result' | 'empty' | 'generating' | 'nomatch' | 'error';
export type GenMode = 'fresh' | 'regenerate' | 'more';

export interface DraftTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSec: number;
  year?: number | null;
  genre?: string | null;
  energy?: string | null;
  moods?: string[];
  instrumental?: boolean | null;
}
export interface SeedChip { id: string; title: string; artist: string }
export interface PlaylistSummary { id: string; name: string; songCount: number; synced?: boolean; lastSyncedAt?: string | null }

// Loose: the controller returns Subsonic-derived fields with varying key names
// across endpoints.
export interface RawTrackRow {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  durationSec?: number;
  year?: number | null;
  genre?: string | null;
  energy?: string | null;
  moods?: string[];
}

export function rowToDraft(s: RawTrackRow): DraftTrack {
  return {
    id: s.id,
    title: s.title || '',
    artist: s.artist || '',
    album: s.album,
    durationSec: s.durationSec ?? s.duration ?? 0,
    year: s.year,
    genre: s.genre ?? null,
    energy: s.energy ?? null,
    moods: s.moods || [],
    instrumental: null,
  };
}

export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}
export function fmtRun(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
export function relTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

