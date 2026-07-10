// LLM pool picker — choose the next track from a candidate pool (the stateless
// fallback path; the conversational agent picker lives in broadcast/dj-agent.js).
// PICKER_CRITERIA is shared with that agent so the two strategies can't drift.

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { djObject } from '../strategy/object.js';

export const PICKER_CRITERIA = `Selection criteria, in order:
1. FLOW — does it transition naturally from what just played? Match energy, mood and tempo, or step them deliberately for the daypart. Some candidates carry MEASURED acoustic facts — treat these as tie-breakers, never hard rules (many tracks won't have them):
   - "bpm" and Camelot "key": prefer a tempo near the current one and a harmonically-close key for a smooth segue.
   - "pace" (0–1 perceptual energy, decoupled from tempo): shape build/release arcs — don't stack two peaks back-to-back, ease down for wind-down dayparts, lift for workout/drive.
   - "sections": higher = a busier, evolving intro.
   - "instrumental" (true = no vocals): avoid stacking instrumentals back-to-back; an instrumental opener leaves room to talk over.
2. CONTEXT — does it fit the time of day, weather, and dominant mood? When a candidate carries its own "moods" tags and an "energy" band (low/medium/high), weigh those against the room's mood and the daypart — match a calm room with calm tracks, lift the energy for a workout slot.
3. VARIETY — avoid the same artist back-to-back; rotate energy. Variety over cleverness — never pick a track because its title literally matches the time of day, the weather, or anything else literal.
4. INTEREST — prefer something that creates a moment, not the most generic option.`;

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
  return `\n\nTRANSITION EFFECTS ("transition") — part of your craft: a working DJ fires one every few songs when the moment earns it. Flag the moment when you see it — the station validates each choice against the audio analysis and silently drops one that doesn't land, so a bold call is safe. Pacing is yours: let a few plain crossfades breathe between effects, and VARY them — if your recent picks leaned on one, reach for another.
Exit moves (how YOUR PICK will end):
- "washout": the pick dissolves into a tempo-synced echo tail as it ends — the workhorse exit; fire on any natural ending (last of a themed run, a big/dreamy/atmospheric closer, a direction change coming next).
- "loop": the pick's final bar repeats hypnotically under the next track — the groove exit for a great riff or locked drum pattern; needs the track's measured tempo, never out of ambient.
Clash moves (carry the PREVIOUS track into your pick; these only fire when the tracks measurably clash):
- "sweep": previous sinks under a closing filter while yours rises clean — the DRAMATIC gear-change.
- "dissolve": previous melts into a beatless ambient wash — the SMOOTH way, when the jump should be hidden (late night, easing out of a talk break).
- "chop": previous is cut on its own beat, stabs thinning as yours rises — the PERCUSSIVE way to jump energy UP; only out of beat-driven material.
Pair move:
- "blend": spectral handover — the two tracks read as ONE continuous piece; only for an exceptionally locked pair (near-identical tempo, close key), roughly one pick in five at most.
Use "normal" or null when nothing above applies — an ordinary same-lane pick needs no effect.`;
}

export type ShowEra = { fromYear?: number | null; toYear?: number | null };
export type ShowMusic = { name: string; topic: string; moods?: string[]; genres?: string[]; eras?: ShowEra[]; energies?: string[]; filtersStrict?: boolean };

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
  const eraText = (show.eras ?? []).map(eraWindowText).filter(Boolean).join(' or ');
  // Strict only bites when there's actually a filter to lock to.
  const hasFilter = !!(genres.length || moods.length || energies.length || eraText);
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
    return `\n\nThis show's music filters are STRICT — every pick must fit: ${locks.join('; ')}. Keep your talk inside them too; only step outside if there is genuinely nothing left that fits (never leave dead air).`;
  }

  // Soft preferences. Mood is deliberately absent — it steers the room context
  // (dominantMood) rather than reading as a per-track preference.
  const parts: string[] = [];
  if (genres.length) parts.push(`lean toward ${or(genres)}`);
  if (eraText) parts.push(`prefer tracks from ${eraText}`);
  if (energies.length) parts.push(`favour ${or(energies)}-energy tracks`);
  return parts.length
    ? `\n\nMusic steer for this show — ${parts.join('; ')}. These are preferences, not hard filters: break them only when the flow genuinely demands it.`
    : '';
}

function pickerSystem(show?: ShowMusic | null) {
  const stationName = settings.get().station;
  const showLine = show?.topic
    ? `\n\nCurrent show brief — follow this for every pick:\n${show.topic}`
    : '';
  return `You are the DJ for ${stationName}, a personal internet radio station.
Pick the single best NEXT track from the candidate pool, given recent plays and the current context.${showLine}${showMusicLean(show)}

${PICKER_CRITERIA}

Each candidate carries a "source" tag — a hint about where it came from:
- similar / similar-artist: flows from what's playing now
- embedding-similar: closest in mood / lyric / metadata space to what's playing
- audio-similar: SOUNDS closest to what's playing (timbre, instrumentation, production)
- audio-journey: SOUNDS like where the set is heading — the next step of a deliberate drift toward a destination vibe, not necessarily the current track
- recent: newly added to the library
- frequent / starred / playlist: an established favourite
- mood-library: matches the room's mood
- random: a wildcard for breaking a predictable run
Use it to balance familiarity against discovery. The two *-similar sources may
carry a "similarity" (0–1, higher = closer) — a high value means a very tight
match you can lean on for a smooth segue.

recentPlays is context for judging flow (most recent first; now.current is the
track on air right now) — every candidate is already guaranteed unplayed, so
you never need to reject one for being recent.

Pick exactly one candidate.`;
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
  const fxActive = settings.effectsActive();
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
        transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable()
          .describe('transition treatment per the TRANSITION EFFECTS guidance: "washout"/"loop" end THIS pick (loop needs measured tempo), "sweep"/"dissolve"/"chop" carry the previous track across a clash (chop only out of beat-driven material), "blend" only for an exceptionally locked pair; "normal" or null for a plain crossfade.'),
      } : {}),
    }),
    temperature: 0.5,
    kind: 'pickNextTrack',
  });
}
