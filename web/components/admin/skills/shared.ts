// Shared skill-catalogue vocabulary for the Skills admin — the row shape from
// GET /dj/skills, the organise-bar modes, the per-kind glyph, and the cooldown
// formatter. Lives here so the card list (SkillsPanel) and the table list
// (SkillsTable) agree without one importing the other.

import type { LucideIcon } from 'lucide-react';
import {
  CloudSun, Newspaper, TrafficCone, Lightbulb, Cake, Disc3, Globe, Sparkles,
} from 'lucide-react';

// The full catalogue row. SkillEditModal's `SkillLike` is the subset of this
// the edit sheet needs.
export interface Skill {
  name: string;
  label?: string;
  kind?: string;
  description?: string;
  enabled?: boolean;
  ready?: boolean;
  requiresKey?: string;
  keyUrl?: string;
  cooldownMs?: number;
  custom?: boolean;
  feed?: string | null;
  feedMaxItems?: number | null;
  tags?: string[];
}

export type StatusFilter = 'all' | 'enabled' | 'disabled' | 'needs-key' | 'custom' | 'builtin';
export type SortMode = 'az' | 'enabled' | 'cooldown';

// A glyph for each of the seven built-in segment kinds — fills the slate card's
// "face" slot where personas/shows have an avatar, and the table's face column.
// Custom skills (and any unmapped kind) fall back to Sparkles, so this is not a
// maintenance trap.
export const KIND_ICONS: Record<string, LucideIcon> = {
  weather: CloudSun,
  news: Newspaper,
  traffic: TrafficCone,
  curiosity: Lightbulb,
  'album-anniversary': Cake,
  'library-deep-cut': Disc3,
  'web-search': Globe,
};

export function iconFor(s: Skill): LucideIcon {
  return KIND_ICONS[s.kind || s.name] ?? Sparkles;
}

export function cooldownLabel(ms?: number): string {
  if (!ms) return 'no cooldown';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min cooldown`;
  const h = Math.round(min / 6) / 10;
  return `${h} h cooldown`;
}
