// LLM pool picker — choose the next track from a candidate pool (the stateless
// fallback path; the conversational agent picker lives in broadcast/dj-agent.js).
// PICKER_CRITERIA is shared with that agent so the two strategies can't drift.

import { z } from 'zod';
import * as settings from '../../../settings.js';
import { djObject } from '../strategy/object.js';

export const PICKER_CRITERIA = `Selection criteria, in order:
1. FLOW — does it transition naturally from what just played? Match energy, mood and tempo, or step them deliberately for the daypart. Some candidates carry MEASURED acoustic facts — treat these as tie-breakers, never hard rules (many tracks won't have them): "bpm" and Camelot "key" (prefer a tempo near the current one and a harmonically-close key for a smooth segue); "pace" (0–1 perceptual energy, decoupled from tempo — shape build/release arcs: don't stack two peaks back-to-back, ease down for wind-down dayparts, lift for workout/drive); "sections" (higher = a busier, evolving intro); "instrumental" (true = no vocals — avoid stacking instrumentals back-to-back, and an instrumental opener leaves room to talk over).
2. CONTEXT — does it fit the time of day, weather, and dominant mood? When a candidate carries its own "moods" tags and an "energy" band (low/medium/high), weigh those against the room's mood and the daypart — match a calm room with calm tracks, lift the energy for a workout slot.
3. VARIETY — avoid the same artist back-to-back; don't repeat tracks you've already played today; rotate energy. Variety over cleverness — never pick a track because its title literally matches the time of day, the weather, or anything else literal.
4. INTEREST — prefer something that creates a moment, not the most generic option.`;

// Coaching for the DJ transition effects (the "transition" output field),
// shared by both pick strategies — the conversational agent (dj-agent.ts
// pickSystem) and the pool picker below — so the craft guidance can't drift
// between them. Returns '' when effects are off (the on-air persona isn't in
// DJ mode — settings.effectsActive), so callers append it unconditionally.
// Lives here rather than in broadcast/dj-agent.ts because llm/ must not
// import from broadcast/.
export function effectsGuidance(): string {
  if (!settings.effectsActive()) return '';
  return `\n\nTRANSITION EFFECTS ("transition") — part of your craft, not a gimmick: a working DJ fires one every few songs when the moment earns it. Actively look for the moment on every pick; when you spot one, flag it — the station validates your choice against the audio analysis and skips ones that don't land. The PACING is entirely yours: there is no rate limit, so be the taste — an effect hits hardest coming out of a stretch of clean blends, so let a few ordinary transitions breathe between them. VARY THEM: they are equals in your kit, and if your recent picks leaned on one, reach for another.\n- "washout": your pick dissolves into a pulsing, tempo-synced echo tail as it ENDS, ringing out into whatever follows. Fire it whenever your pick is the natural END of something: the last track of a run of similar songs, a song with a big or atmospheric ending, anything dreamy/hazy/anthemic, or when the NEXT stretch will change direction. In a normal set several tracks qualify — this is your workhorse exit move, not a rarity.\n- "sweep": the track playing before your pick sinks under a slowly closing filter across the blend while your pick rises clean underneath. Use it on a genuine gear-change — a clear jump in energy, tempo, or mood (it only fires when the tracks measurably clash).\n- "blend": spectral handover — across a long crossfade the outgoing track hands its bass, then its mids, to your pick, keeping only its highs to the end, while your pick arrives lows-first underneath. The two feel like ONE continuous piece of music. Reserve it for the EXCEPTIONAL pair, not the merely similar — your picks already flow, and the plain crossfade handles an ordinary same-lane transition on its own. Flag blend only when the two tracks are properly locked (near-identical tempo, harmonically close key) — roughly one pick in five, or it stops meaning anything (it only fires when the tracks measurably fit).\n- "dissolve": the track playing before your pick melts into a diffuse, beatless ambient wash while your pick rises clean through it — the reverb throw. The SMOOTH way across a clash where the sweep is the dramatic way: choose it when the tempo or mood jump should be hidden rather than announced (into a talk break's aftermath, easing between worlds late at night). Like the sweep it only fires when the tracks measurably clash.\nUse "normal" or null only when nothing above applies.`;
}

export type ShowMusic = { name: string; topic: string; mood?: string; genre?: string; fromYear?: number | null; toYear?: number | null; energy?: string; filtersStrict?: boolean };

// A show can pin a mood, genre, decade and/or energy band on track selection.
// All are SOFT leans by default, or HARD constraints when `filtersStrict` is on
// (one toggle governs every set filter). Render it as one prompt line shared by
// both pick paths (the pool picker here and the conversational agent in
// broadcast/dj-agent.ts). Returns '' when the show pins nothing, so callers can
// append it unconditionally.
export function showMusicLean(show?: ShowMusic | null): string {
  if (!show) return '';
  const eraText = (() => {
    if (show.fromYear == null && show.toYear == null) return '';
    const from = show.fromYear != null ? String(show.fromYear) : '';
    const to = show.toYear != null ? String(show.toYear) : '';
    return from && to ? `${from}–${to}` : from ? `${from} onward` : `up to ${to}`;
  })();
  // Strict only bites when there's actually a filter to lock to.
  const hasFilter = !!(show.genre || show.mood || show.energy || eraText);
  const strict = !!(show.filtersStrict && hasFilter);

  if (strict) {
    // The hard rule. Track selection is code-enforced for strict shows (the
    // prefer* locks in both pick paths), so this is lean: it governs the DJ's
    // TALK and the never-starve fallback case (where off-filter tracks can
    // still surface), not the candidate list. Mood joins the lock here — soft
    // shows carry mood through the room-context prompt instead.
    const locks: string[] = [];
    if (show.genre) locks.push(`${show.genre} tracks`);
    if (eraText) locks.push(`the ${eraText} era`);
    if (show.mood) locks.push(`the ${show.mood} mood`);
    if (show.energy) locks.push(`${show.energy}-energy tracks`);
    return `\n\nThis show's music filters are STRICT — every pick must fit: ${locks.join('; ')}. Keep your talk inside them too; only step outside if there is genuinely nothing left that fits (never leave dead air).`;
  }

  // Soft preferences. Mood is deliberately absent — it steers the room context
  // (dominantMood) rather than reading as a per-track preference.
  const parts: string[] = [];
  if (show.genre) parts.push(`lean toward ${show.genre}`);
  if (eraText) parts.push(`prefer tracks from ${eraText}`);
  if (show.energy) parts.push(`favour ${show.energy}-energy tracks`);
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

recentPlays is context for judging flow — every candidate is already guaranteed
unplayed, so you never need to reject one for being recent.

Pick exactly one candidate.`;
}

export async function pickNextTrack({ candidates, recentPlays, context, show = null, recentTransitions = [] }: {
  candidates: any[];
  recentPlays: any;
  context: any;
  show?: ShowMusic | null;
  // The model's recent transition asks (oldest first), for the same deliberate-
  // variety nudge the agent path gets — the queue's monoculture guard strips a
  // third identical choice either way, this just keeps the model from wasting
  // picks on choices that will be stripped. Only used when effects are active.
  recentTransitions?: string[];
}) {
  const user = JSON.stringify({
    now: {
      time: context.time?.period,
      vibe: context.time?.vibe,
      mood: context.dominantMood,
      weather: context.weather?.condition,
      festival: context.festival?.name,
    },
    recentPlays,
    candidates,
  }, null, 2);

  // Constrain the pick to the actual candidate ids. On a local model (llama.cpp
  // via openai-compatible / locca) this becomes a grammar so the model can only
  // emit a real id — closing the "agent returned unknown id" hole. On providers
  // that don't enforce the schema at decode time, Zod still rejects an invalid
  // id, so the caller's fallback fires instead of a bogus track. Empty pool →
  // plain string (z.enum needs ≥1 literal); pickViaPool never calls with [].
  const candidateIds = [
    ...new Set(
      (candidates || [])
        .map((c: any) => c?.id)
        .filter((id: any): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const idSchema = candidateIds.length
    ? z.enum(candidateIds as [string, ...string[]]).describe('the exact id of one candidate')
    : z.string().describe('the exact id of one candidate');

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
        transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve']).nullable()
          .describe('transition treatment for this pick — "blend" only when the pair is exceptionally locked (near-identical tempo, close key; a plain crossfade already handles ordinary same-lane picks), "sweep" for a genuine gear-change, "washout" to ring this pick out as it ends, "dissolve" to melt the previous track into ambience under this pick; "normal" or null for a plain crossfade. The TRANSITION EFFECTS guidance above explains each.'),
      } : {}),
    }),
    temperature: 0.5,
    kind: 'pickNextTrack',
  });
}
