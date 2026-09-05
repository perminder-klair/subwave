// Deterministic, listener-safe facts assembled after a track is selected.
// This deliberately knows nothing about picker reasoning, tool transcripts, or
// the model prompt: it is a small trusted packet for the main DJ link path.

import { trackEraYear } from '../../../music/show-filter.js';
import { unairedFlag, type AiredIndex } from '../../../music/airing.js';

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
    notes.push(`Station plays before today: ${playCount}.`);
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
  const notes = sleeveNotesFor(track, playCount);
  if (stationHistoryNote) notes.push(stationHistoryNote);
  const season = text(context?.date?.season);
  if (season) notes.push(`Season: ${season}.`);
  const condition = text(context?.weather?.condition);
  if (condition && condition !== 'unknown') {
    const place = text(context?.weather?.location);
    notes.push(`Weather${place ? ` in ${place}` : ''}: ${condition}.`);
  }
  const show = context?.activeShow;
  if (text(show?.topic)) notes.push(`Show theme: ${text(show.topic)}.`);
  if (text(show?.episodeAngle)) notes.push(`Episode angle: ${text(show.episodeAngle)}.`);
  const festival = text(context?.festival?.name);
  if (festival) notes.push(`Festival: ${festival}.`);
  return notes;
}

/**
 * A link needs a little colour, not a metadata checklist. Keep a single
 * supplemental fact varied per link while retaining a deterministic seam for
 * tests. The identity fact is added separately and is never random.
 */
export function selectSleeveNotes(notes: readonly string[], random: () => number = Math.random): string[] {
  if (notes.length < 2) return [...notes];
  const index = Math.min(notes.length - 1, Math.floor(random() * notes.length));
  return [notes[index]!];
}

/**
 * The complete prompt packet. The track identity is always present when it is
 * known; at most one supplemental sleeve note follows it. A malformed/raw
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
