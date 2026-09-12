// One editorial model call over a controller-built Track Shortlist.
//
// Discovery is deliberately absent here: candidates and factual provenance are
// supplied by music/shortlist.ts. The model chooses only from their ids plus
// the private selection note and transition. The verified link writer runs
// afterwards, once the selected track is known.

import { z } from 'zod';
import { djObject, modelTolerant } from '../llm/sdk.js';
import { pickSchemaBase, pickSystem } from '../broadcast/dj-agent/schemas.js';
import type { ShortlistCandidate, ShortlistSourceRun } from './shortlist.js';

export type ShortlistPick = {
  id: string;
  selectionReason: string;
  transition: 'normal' | 'blend' | 'sweep' | 'washout' | 'dissolve' | 'chop' | 'loop' | null;
};

const UNUSABLE_SELECTION_REASON = '[selection note unavailable]';
const QUEUE_LANGUAGE = /\b(?:next\s+up|up\s+next|coming\s+up|we(?:'|’)re\s+playing|we\s+have)\b/i;

// Native sources are controller-run, rather than model-invoked tools. Keeping
// their compact execution record beside the final LLM call preserves the
// familiar Debug view while retaining that distinction.
export function shortlistDebugTools(sourceRuns: ShortlistSourceRun[]) {
  return sourceRuns.map(({ source, args, status, returned, accepted, elapsedMs, error }) => ({
    name: source,
    args,
    result: { status, returned, accepted, elapsedMs, ...(error ? { error } : {}) },
  }));
}

// The selection note is for the Booth Log, not the listener-facing link. Keep
// a controller-written floor for a weak local model rather than spending a
// second model call (or losing an otherwise valid pick) over editorial copy.
export function usableSelectionReason(reason: unknown, song: { artist?: unknown; title?: unknown }): string {
  const note = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (note.length >= 24 && !QUEUE_LANGUAGE.test(note) && note !== UNUSABLE_SELECTION_REASON) return note;

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
    selectionReason: z.string().trim().min(24).max(280).describe('private Booth Log selection note — never spoken on air. Name the selected artist and track title, then explain their musical fit in this moment. Do not introduce or announce the track, imply queue position, use first-person DJ framing, or say "next up", "coming up", "we are playing", or "we have". A guest may be named only when their supplied Musical Leanings genuinely settled a close tie. Never claim source names, source counts, or diagnostic facts.'),
  }), { objectFallbacks: { selectionReason: UNUSABLE_SELECTION_REASON } });
}

export function shortlistPickPrompt(candidates: ShortlistCandidate[], context: Record<string, unknown> = {}): string {
  return JSON.stringify({ context, shortlist: candidates }, null, 2)
    + '\n\nChoose one id from this Track Shortlist. The controller has already applied the station guards. Write selectionReason as a private Booth Log note, never on-air DJ speech: name your selected artist and track title, then explain the musical fit. It must not introduce or announce the track, imply it is next in the queue, use first-person DJ framing, or say "next up", "coming up", "we are playing", or "we have". Do not name shortlist sources: the controller adds that factual hint. If context includes Musical Leanings, use them only to break a close tie between otherwise suitable candidates; never override the shortlist, show rules, rotation, safety, or the musical flow. A Guest Musical Leaning is weaker than the host\'s. Name the guest naturally in selectionReason only when their preference genuinely breaks that close tie; otherwise do not mention it.';
}

export function shortlistRepickPrompt(
  candidates: ShortlistCandidate[],
  reason: string,
  context: Record<string, unknown> = {},
): string {
  return JSON.stringify({ context, shortlist: candidates }, null, 2)
    + `\n\n${reason} Choose one id from the supplied alternative Track Shortlist only. The controller has already applied the station guards; do not discover or suggest another track. Write selectionReason as a private Booth Log note, never on-air DJ speech: name your selected artist and track title, then explain the musical fit. Do not introduce or announce the track, imply queue position, use first-person DJ framing, or say "next up", "coming up", "we are playing", or "we have"; the controller adds factual source hints separately. If context includes Musical Leanings, use them only to break a close tie and never to override this alternative subset. A Guest Musical Leaning is weaker than the host's; name that guest naturally in selectionReason only if it genuinely breaks the tie.`;
}

export async function djPick({
  candidates,
  showAt = null,
  playlistResolved = true,
  context = {},
  sourceRuns = [],
}: {
  candidates: ShortlistCandidate[];
  showAt?: Date | null;
  playlistResolved?: boolean;
  context?: Record<string, unknown>;
  sourceRuns?: ShortlistSourceRun[];
}): Promise<ShortlistPick> {
  const ids = candidates.map((candidate) => candidate.id).filter((id): id is string => typeof id === 'string');
  const toolCalls = shortlistDebugTools(sourceRuns);
  return djObject({
    system: pickSystem(showAt, playlistResolved, true),
    prompt: shortlistPickPrompt(candidates, context),
    schema: shortlistPickSchema(ids),
    temperature: 0.5,
    kind: 'djShortlistPick',
    telemetry: { toolCalls, steps: toolCalls.length + 1 },
  }) as Promise<ShortlistPick>;
}

// A corrective editorial choice for the artist-variety guard. The caller has
// already removed every disallowed artist from this subset, so this call must
// neither rediscover nor receive the wider shortlist.
export async function djShortlistRepick({
  candidates,
  reason,
  showAt = null,
  playlistResolved = true,
  context = {},
}: {
  candidates: ShortlistCandidate[];
  reason: string;
  showAt?: Date | null;
  playlistResolved?: boolean;
  context?: Record<string, unknown>;
}): Promise<ShortlistPick | null> {
  const ids = candidates.map((candidate) => candidate.id).filter((id): id is string => typeof id === 'string');
  try {
    return await djObject({
      system: pickSystem(showAt, playlistResolved, true),
      prompt: shortlistRepickPrompt(candidates, reason, context),
      schema: shortlistPickSchema(ids),
      temperature: 0.5,
      kind: 'djShortlistRepick',
    }) as ShortlistPick;
  } catch {
    return null;
  }
}
