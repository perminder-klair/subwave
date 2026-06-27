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

export type ShowMusic = { name: string; topic: string; genre?: string; fromYear?: number | null; toYear?: number | null; energy?: string; genreStrict?: boolean };

// A show can pin a genre, decade and/or energy band on track selection. Genre
// is a SOFT lean by default, or a HARD constraint when `genreStrict` is on;
// decade and energy are always soft. Render it as one prompt line shared by both
// pick paths (the pool picker here and the conversational agent in
// broadcast/dj-agent.ts). Returns '' when the show pins nothing, so callers can
// append it unconditionally.
export function showMusicLean(show?: ShowMusic | null): string {
  if (!show) return '';
  // Strict only bites when there's actually a genre to lock to.
  const strict = !!(show.genreStrict && show.genre);
  // Soft preferences (the genre lean is dropped here when strict — it becomes a
  // hard rule on its own line below).
  const parts: string[] = [];
  if (show.genre && !strict) parts.push(`lean toward ${show.genre}`);
  if (show.fromYear != null || show.toYear != null) {
    const from = show.fromYear != null ? String(show.fromYear) : '';
    const to = show.toYear != null ? String(show.toYear) : '';
    parts.push(from && to ? `prefer tracks from ${from}–${to}` : `prefer tracks ${from ? `from ${from} onward` : `up to ${to}`}`);
  }
  if (show.energy) parts.push(`favour ${show.energy}-energy tracks`);

  // The hard genre rule. Track selection is now code-enforced for strict shows
  // (preferGenre in both pick paths), so this is lean: it governs the DJ's TALK
  // and the never-starve fallback case (where off-genre tracks can still surface),
  // not the candidate list.
  const lock = strict
    ? `\n\nThis show is ${show.genre}-only — keep your picks and your talk in ${show.genre}; only step outside if there is genuinely no ${show.genre} track left to play (never leave dead air).`
    : '';
  const soft = parts.length
    ? `\n\nMusic steer for this show — ${parts.join('; ')}. These are preferences, not hard filters: break them only when the flow genuinely demands it.`
    : '';
  return `${lock}${soft}`;
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

export async function pickNextTrack({ candidates, recentPlays, context, show = null }: {
  candidates: any[];
  recentPlays: any;
  context: any;
  show?: ShowMusic | null;
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

  return djObject({
    system: pickerSystem(show),
    prompt: user,
    schema: z.object({
      id: idSchema,
      reason: z.string().describe('one short sentence on why this one'),
    }),
    temperature: 0.5,
    kind: 'pickNextTrack',
  });
}
