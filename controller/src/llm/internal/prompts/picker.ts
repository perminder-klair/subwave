// LLM pool picker — choose the next track from a candidate pool (the stateless
// fallback path; the conversational agent picker lives in broadcast/dj-agent.js).
// PICKER_CRITERIA is shared with that agent so the two strategies can't drift.

import { z } from 'zod';
import * as settings from '../../../settings.js';
// Straight from settings/, not through the barrel: the barrel re-exports it,
// but naming the module keeps the per-effect rule findable from the prompt.
import { effectEnabled, enabledEffects } from '../../../settings/transition-effects.js';
import { TRANSITION_EFFECTS } from '../../../settings/vocab.js';
import { djObject } from '../strategy/object.js';
import { instruction } from './instructions.js';

export const PICKER_CRITERIA = instruction('pick-criteria', 'criteria');

// Coaching for the DJ transition effects (the "transition" output field),
// shared by both pick strategies — the conversational agent (dj-agent.ts
// pickSystem) and the pool picker below — so the craft guidance can't drift
// between them. Returns '' when effects are off (the on-air persona isn't in
// DJ mode — settings.effectsActive), so callers append it unconditionally.
// Lives here rather than in broadcast/dj-agent.ts because llm/ must not
// import from broadcast/.
// Compact by design (~250 words, was ~600): this block rides on EVERY DJ-mode
// pick on both paths, and the agent path pays for it alongside the schema
// description. The station validates every ask against the audio analysis
// (queue.applyMixTransition), so the prompt only needs to teach WHEN to reach
// for each effect — trigger + counter-indication — not how the audio works.
export function effectsGuidance(): string {
  if (!settings.effectsActive()) return '';
  // Per-effect operator switches (#1565). The catalogue in pick-criteria.md
  // stays whole and a closing line names what is switched off, rather than the
  // bullets being filtered out of the markdown: the coaching paragraphs are
  // written as one piece (the pacing and variety rules read across all six),
  // and dicing them by name would leave a different, worse prompt on every
  // combination of switches. With nothing left on, the whole block goes —
  // callers treat that exactly like DJ mode being off.
  const off = TRANSITION_EFFECTS.filter(k => !effectEnabled(k));
  if (off.length === TRANSITION_EFFECTS.length) return '';
  const unavailable = off.length
    ? `\nSwitched off on this station right now: ${off.map(k => `"${k}"`).join(', ')} — never choose ${off.length > 1 ? 'those' : 'that'}.`
    : '';
  return `\n\n${instruction('pick-criteria', 'effects')}${unavailable}`;
}

/**
 * The `transition` enum offered to a pick call, narrowed to the effects an
 * operator has left on. 'normal' is always available — it is the absence of an
 * effect, not one of them.
 *
 * Only the ONE-SHOT pool path uses this. The agent's PICK_SCHEMA deliberately
 * keeps the full enum whatever the switches say (see dj-agent/schemas.ts): its
 * schema is session-anchored, so a shape that changed under a running
 * conversation would contradict the history already in it. That path is
 * gated by the guidance above plus the strip in queue.applyMixTransition.
 */
export function transitionEnumValues(): [string, ...string[]] {
  return ['normal', ...enabledEffects()];
}

type ShowEra = { fromYear?: number | null; toYear?: number | null };
export type ShowMusic = { name: string; topic: string; moods?: string[]; genres?: string[]; eras?: ShowEra[]; energies?: string[]; vocals?: string | null; filtersStrict?: boolean };

// One era window as prose ("1990–1999", "1970 onward", "up to 1989").
function eraWindowText(e: ShowEra): string {
  const from = e.fromYear != null ? String(e.fromYear) : '';
  const to = e.toYear != null ? String(e.toYear) : '';
  return from && to ? `${from}–${to}` : from ? `${from} onward` : to ? `up to ${to}` : '';
}

// A show can pin moods, genres, decades and/or energy bands on track selection
// — each a multi-value list (#929): any entry satisfies the attribute, all
// entries weighted equally. All are SOFT leans by default, or HARD constraints
// when `filtersStrict` is on (one toggle governs every set filter). Render it
// as one prompt line shared by both pick paths (the pool picker here and the
// conversational agent in broadcast/dj-agent.ts). Returns '' when the show
// pins nothing, so callers can append it unconditionally.
export function showMusicLean(show?: ShowMusic | null): string {
  if (!show) return '';
  const genres = show.genres ?? [];
  const moods = show.moods ?? [];
  const energies = show.energies ?? [];
  // '' / absent = no constraint. Rendered as prose rather than the stored token,
  // which reads as a flag name to a model rather than a property of the music.
  const vocalText = show.vocals === 'instrumental'
    ? 'instrumental tracks (no singing)'
    : show.vocals === 'vocal' ? 'tracks with vocals' : '';
  const eraText = (show.eras ?? []).map(eraWindowText).filter(Boolean).join(' or ');
  // Strict only bites when there's actually a filter to lock to.
  const hasFilter = !!(genres.length || moods.length || energies.length || vocalText || eraText);
  const strict = !!(show.filtersStrict && hasFilter);
  const or = (xs: string[]) => xs.join(' / ');

  if (strict) {
    // The hard rule. Track selection is code-enforced for strict shows (the
    // prefer* locks in both pick paths), so this is lean: it governs the DJ's
    // TALK and the never-starve fallback case (where off-filter tracks can
    // still surface), not the candidate list. Mood joins the lock here — soft
    // shows carry mood through the room-context prompt instead.
    const locks: string[] = [];
    if (genres.length) locks.push(`${or(genres)} tracks`);
    if (eraText) locks.push(`the ${eraText} era${(show.eras?.length ?? 0) > 1 ? 's' : ''}`);
    if (moods.length) locks.push(`the ${or(moods)} mood${moods.length > 1 ? 's' : ''}`);
    if (energies.length) locks.push(`${or(energies)}-energy tracks`);
    if (vocalText) locks.push(vocalText);
    return `\n\nThis show's music filters are STRICT — every pick must fit: ${locks.join('; ')}. Keep your talk inside them too; only step outside if there is genuinely nothing left that fits (never leave dead air).`;
  }

  // Soft preferences. Mood is deliberately absent — it steers the room context
  // (dominantMood) rather than reading as a per-track preference.
  const parts: string[] = [];
  if (genres.length) parts.push(`lean toward ${or(genres)}`);
  if (eraText) parts.push(`prefer tracks from ${eraText}`);
  if (energies.length) parts.push(`favour ${or(energies)}-energy tracks`);
  if (vocalText) parts.push(`favour ${vocalText}`);
  return parts.length
    ? `\n\nMusic steer for this show — ${parts.join('; ')}. These are preferences, not hard filters: break them only when the flow genuinely demands it.`
    : '';
}

function pickerSystem(show?: ShowMusic | null) {
  const stationName = settings.get().station;
  const showLine = show?.topic
    ? `\n\n${instruction('pool-picker', 'show-brief', { topic: show.topic })}`
    : '';
  return `${instruction('pool-picker', 'frame', { station: stationName })}${showLine}${showMusicLean(show)}

${PICKER_CRITERIA}

${instruction('pool-picker', 'source-tags')}

${instruction('pool-picker', 'recent-plays')}`;
}

export async function pickNextTrack({ candidates, recentPlays, context, show = null, current = null, recentTransitions = [] }: {
  candidates: any[];
  recentPlays: any;
  context: any;
  show?: ShowMusic | null;
  // The track on air right now, with its measured facts when analysed
  // ({ title, artist, bpm?, key?, pace? }). This is the anchor FLOW judges
  // against — without it the criteria said "prefer a tempo near the current
  // one" while the payload never stated the current tempo.
  current?: any;
  // The model's recent transition asks (oldest first), for the same deliberate-
  // variety nudge the agent path gets — the queue's monoculture guard strips a
  // third identical choice either way, this just keeps the model from wasting
  // picks on choices that will be stripped. Only used when effects are active.
  recentTransitions?: string[];
}) {
  // Compact serialization on purpose: the old 2-space pretty-print spent a
  // few hundred tokens on whitespace per pick, and models read dense JSON
  // fine (the agent path's tool results arrive compact already). undefined
  // fields drop out entirely — the projection upstream leans on that.
  const user = JSON.stringify({
    now: {
      time: context.time?.period,
      vibe: context.time?.vibe,
      mood: context.dominantMood,
      weather: context.weather?.condition,
      festival: context.festival?.name,
      current: current || undefined,
    },
    recentPlays,
    candidates,
  });

  // The id is a plain string, NOT z.enum(candidateIds), deliberately (#939):
  // the tool-strategy providers this path was meant to protect (llama.cpp via
  // openai-compatible / locca, ollama) deliver the schema as forced-tool
  // ARGUMENTS, which llama.cpp does not grammar-constrain — so the enum never
  // reached the decoder, and its only effect was a hard Zod reject on the 2-3
  // char id corruptions small local models produce, killing the pick before
  // pickViaPool's nearestId repair could run. Validation lives at the call
  // site instead: exact match → near-miss repair → first-candidate fallback.
  const idSchema = z.string().describe('the exact id of one candidate');

  // Transition effects on the pool path too: the queue's applyMixTransition
  // validates/strips whatever any pick strategy asks for, so a DJ-mode persona
  // keeps its craft even while picks run through this fallback (breaker open,
  // soft budget tier, pickerAgent off). Unlike the agent's session-anchored
  // schema pair (PICK_SCHEMA / PICK_SCHEMA_NO_FX), this is a one-shot call with
  // no history to poison — when effects are off the field simply doesn't exist.
  // Both halves must agree: with every effect switched off there is no
  // guidance and no `transition` field either, which is the same prompt an
  // effectsActive:false persona gets.
  const fxActive = settings.effectsActive() && enabledEffects().length > 0;
  const fxGuidance = effectsGuidance();
  const fxHistory = fxActive && recentTransitions.length
    ? `\n\nYour recent transition choices, oldest first: ${recentTransitions.join(', ')} — the station strips a third repeat, so vary deliberately.`
    : '';

  return djObject({
    system: `${pickerSystem(show)}${fxGuidance}${fxHistory}`,
    prompt: user,
    schema: z.object({
      id: idSchema,
      reason: z.string().describe('one short sentence on why this one'),
      ...(fxActive ? {
        // One-line pointer only — the full coaching lives in effectsGuidance()
        // in the system prompt; duplicating it here doubled the token bill.
        transition: z.enum(transitionEnumValues()).nullable()
          .describe('transition treatment per the TRANSITION EFFECTS guidance: "washout"/"loop" end THIS pick (loop needs measured tempo), "sweep"/"dissolve"/"chop" carry the previous track across a clash (chop only out of beat-driven material), "blend" only for an exceptionally locked pair; "normal" or null for a plain crossfade.'),
      } : {}),
    }),
    temperature: 0.5,
    kind: 'pickNextTrack',
  });
}
