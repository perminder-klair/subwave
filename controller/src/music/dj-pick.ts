// One editorial model call over a controller-built Track Shortlist.
//
// Discovery is deliberately absent here: candidates and factual provenance are
// supplied by music/shortlist.ts. The model chooses only from their ids and
// writes the listener-facing link/transition in the existing pick shape.

import { z } from 'zod';
import { djObject, modelTolerant } from '../llm/sdk.js';
import { pickSchemaBase, pickSystem } from '../broadcast/dj-agent/schemas.js';
import type { ShortlistCandidate } from './shortlist.js';

export type ShortlistPick = {
  id: string;
  selectionReason: string;
  say: string | null;
  transition: 'normal' | 'blend' | 'sweep' | 'washout' | 'dissolve' | 'chop' | 'loop' | null;
};

function comparable(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Library metadata commonly uses “feat.” while models naturally write
    // “featuring”. They identify the same credited artist list.
    .replace(/\bfeaturing\b/g, 'feat')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimDanglingEnding(value: string): string {
  return value
    .replace(/\s*[,;:]\s*(?:and|or|but)?\s*$/i, '')
    .replace(/\s+(?:and|or|but)\s*$/i, '')
    .trim();
}

// A model-written sentence is useful only when it identifies the very track
// that reached the queue. Corrective guards can replace the initial choice, so
// do this once at the final queue boundary rather than trusting a reason from a
// previous selection. A safe generic line is preferable to explaining Sam
// Smith with a Porcupine Tree note.
export function shortlistSelectionReason(track: any, reason: unknown): string {
  const trackTitle = typeof track?.title === 'string' ? track.title.trim() : '';
  const trackArtist = typeof track?.artist === 'string' ? track.artist.trim() : '';
  const title = comparable(trackTitle);
  const artist = comparable(trackArtist);
  const note = comparable(reason);
  if (note && (!title || note.includes(title)) && (!artist || note.includes(artist))) {
    return String(reason).trim();
  }

  // Small local models sometimes stop after naming the artist. Keep only a
  // clearly generic, artist-led fragment, trim a dangling conjunction, then
  // anchor it to the verified final title. This preserves useful variation
  // without allowing a corrected pick to inherit another track's explanation.
  const raw = typeof reason === 'string' ? trimDanglingEnding(reason.replace(/\s+/g, ' ')) : '';
  if (raw && trackTitle && trackArtist && artist && !note.includes(title)) {
    const remainder = raw.replace(new RegExp(`^${escapeRegExp(trackArtist)}\\s*[-—,:]?\\s*`, 'i'), '').trim();
    if (/^(?:fits|works|brings|keeps|matches|follows|continues|adds|carries|suits|makes|offers)\b/i.test(remainder)) {
      return `“${trackTitle}” by ${trackArtist} — ${/[.!?]$/.test(remainder) ? remainder : `${remainder}.`}`;
    }
  }

  const identity = [trackTitle, trackArtist].filter(Boolean).join(' by ');
  return identity ? `Selected "${identity}" from the eligible shortlist.` : 'Selected from the eligible shortlist.';
}

// A verified note can still be too thin to be useful in the Booth. Keep a
// controller-written, track-specific floor without spending another model call.
export function usableSelectionReason(reason: unknown, song: { artist?: unknown; title?: unknown }): string {
  const note = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (note.length >= 24) return note;
  const artist = typeof song.artist === 'string' && song.artist.trim() ? song.artist.trim() : 'This artist';
  const title = typeof song.title === 'string' && song.title.trim() ? song.title.trim() : 'this track';
  return `${artist} — ${title}: selected for its fit with the current musical flow.`;
}

export function shortlistPickSchema(ids: string[]) {
  if (!ids.length) throw new Error('cannot select from an empty Track Shortlist');
  const idEnum = z.enum(ids as [string, ...string[]]).describe('the exact id of one track in the supplied Track Shortlist');
  return modelTolerant(pickSchemaBase().omit({ reason: true }).extend({
    id: idEnum,
    // Editorial only: provenance remains controller-written and must never be
    // reconstructed from the model's interpretation of the shortlist.
    selectionReason: z.string().describe('internal editorial reason only — max 12 words. Explain why this candidate fits the musical moment; never claim source names, source counts, or diagnostic facts.'),
  }));
}

export function shortlistPickPrompt(candidates: ShortlistCandidate[]): string {
  return JSON.stringify({ shortlist: candidates }, null, 2)
    + '\n\nChoose one id from this Track Shortlist. The controller has already applied the station guards.';
}

export async function djPick({
  candidates,
  showAt = null,
  playlistResolved = true,
}: {
  candidates: ShortlistCandidate[];
  showAt?: Date | null;
  playlistResolved?: boolean;
}): Promise<ShortlistPick> {
  const ids = candidates.map((candidate) => candidate.id).filter((id): id is string => typeof id === 'string');
  return djObject({
    system: pickSystem(showAt, playlistResolved, true),
    prompt: shortlistPickPrompt(candidates),
    schema: shortlistPickSchema(ids),
    temperature: 0.5,
    kind: 'djShortlistPick',
  }) as Promise<ShortlistPick>;
}
