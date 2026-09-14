// Deterministic, listener-safe facts assembled after a track is selected.
// This deliberately knows nothing about picker reasoning, tool transcripts, or
// the model prompt: it is a small trusted packet for the main DJ link path.

import { trackEraYear } from '../../../music/show-filter.js';
import { unairedFlag, type AiredIndex } from '../../../music/airing.js';

export const RELEASE_YEAR_MENTION_FREQUENCIES = ['regular', 'occasional', 'rare'] as const;
export type ReleaseYearMentionFrequency = (typeof RELEASE_YEAR_MENTION_FREQUENCIES)[number];

function text(value: unknown, max = 180): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Facts derived from controller/library state, safe to hand to the DJ as facts. */
export function sleeveNotesFor(track: any, playCount: number | null = null): string[] {
  const notes: string[] = [];
  const album = text(track?.album);
  const title = text(track?.title);
  if (album && album.toLocaleLowerCase() !== title.toLocaleLowerCase()) {
    notes.push(`Album: ${album}.`);
  }
  const year = trackEraYear(track);
  if (year != null && Number.isInteger(year) && year >= 1880 && year <= new Date().getFullYear()) {
    notes.push(`Release year: ${year}.`);
  }
  if (Number.isInteger(playCount) && playCount! > 0) {
    notes.push(`Lifetime station plays: ${playCount}.`);
  }
  return notes;
}

// A small amount of station memory makes a link feel like it belongs to this
// broadcast, but an empty/unavailable play index must never be presented as a
// first play. `unairedFlag` makes exactly that distinction for the picker.
// A rare return needs both a low lifetime count and a meaningful gap; without
// the gap, a new station would call every second spin "rare".
export function stationHistoryNoteFor(
  track: any,
  stats: { count: number; lastPlayedAtMs: number } | null,
  index: AiredIndex,
  nowMs = Date.now(),
): string | null {
  if (unairedFlag(track, index)) return 'First station play.';
  if (!stats || stats.count < 1 || stats.count > 2) return null;
  const days = Math.floor((nowMs - stats.lastPlayedAtMs) / 86_400_000);
  if (!Number.isFinite(days) || days < 30) return null;
  const times = stats.count === 1 ? 'once' : 'twice';
  return `Played here only ${times} before; last heard ${days} days ago.`;
}

// Extra facts are derived from controller context, never model knowledge.
export function contextSleeveNotesFor(
  track: any,
  context: any,
  playCount: number | null = null,
  stationHistoryNote: string | null = null,
): string[] {
  void context;
  const notes = sleeveNotesFor(track, playCount);
  if (stationHistoryNote) notes.push(stationHistoryNote);
  // The default Sleeve Notes packet is track/library/station history only.
  // Show identity and an explicit near-boundary handover remain available in
  // Current Context; themes, episode angles and festivals are editorial
  // steering, not facts about the selected track, and must not leak into this
  // isolated listener-facing writer when metadata happens to be sparse.
  return notes;
}

/**
 * A link needs enough verified detail to avoid filling gaps from model memory,
 * not a metadata checklist. The identity fact is added separately; retain the
 * first two supplemental facts in their deterministic priority order.
 */
export function selectSleeveNotes(
  notes: readonly string[],
  random: () => number = Math.random,
  includeReleaseYear = true,
): string[] {
  void random;
  return (includeReleaseYear ? notes : notes.filter((note) => !note.startsWith('Release year:'))).slice(0, 2);
}

// A release year remains a verified library fact even when it is not useful
// copy for this particular link. The gate is deterministic rather than random:
// retries and a controller restart make the same editorial choice, while the
// track/time seed distributes eligible links through a show instead of fixing
// a track permanently as a "year" or "no year" track.
export function releaseYearMentionEligible(
  track: any,
  context: any,
  frequency: ReleaseYearMentionFrequency = 'regular',
): boolean {
  if (frequency === 'regular') return true;
  const divisor = frequency === 'occasional' ? 4 : 6;
  const seed = [
    text(track?.id || track?.title),
    text(track?.artist),
    text(context?.date?.iso || context?.date?.dayLabel),
    text(context?.clock?.hhmm || context?.clock?.display),
  ].join('|');
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % divisor === 0;
}

/**
 * The complete prompt packet. The track identity is always present when it is
 * known; up to two supplemental sleeve notes follow it. A malformed/raw
 * track degrades to no packet rather than creating an assertion from guesswork.
 */
export function verifiedFactsForLink(
  track: any,
  playCount: number | null = null,
  random: () => number = Math.random,
): string[] {
  const title = text(track?.title);
  if (!title) return [];
  const artist = text(track?.artist) || 'unknown artist';
  return [
    `Track: "${title}" by ${artist}.`,
    ...selectSleeveNotes(sleeveNotesFor(track, playCount), random),
  ];
}

export function verifiedFactsSection(facts: readonly string[]): string {
  if (!facts.length) return '';
  return `Verified facts:\n${facts.map((fact) => `- ${fact}`).join('\n')}`;
}
