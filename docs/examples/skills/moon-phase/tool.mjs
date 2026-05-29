// Example custom-skill data tool for SUB/WAVE.
//
// The default export is wrapped as an AI SDK tool the segment director can call
// before deciding whether to air this skill's line. It is invoked with the
// moment's context (`ctx` — the same shape as getFullContext(): time, weather,
// festival, dominantMood, clock) and the cross-tick dedup `state`. Return any
// JSON-serialisable object; a `{ available: false }` convention tells the agent
// there is nothing worth airing. Keep it fast — the call is timeout-guarded at
// 8s and any throw degrades cleanly to "no data".
//
// This one needs no API key and no network: it computes the lunar phase from
// the current date with a simple synodic-month approximation.

const SYNODIC = 29.530588853; // mean length of a lunar month, days
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // 2000-01-06 18:14 UTC

const PHASES = [
  'new moon', 'waxing crescent', 'first quarter', 'waxing gibbous',
  'full moon', 'waning gibbous', 'last quarter', 'waning crescent',
];

export default async function moonPhase() {
  const daysSince = (Date.now() - KNOWN_NEW_MOON) / 86_400_000;
  const age = ((daysSince % SYNODIC) + SYNODIC) % SYNODIC; // 0..29.53, days into the cycle
  const fraction = age / SYNODIC;                          // 0..1 through the cycle
  const index = Math.round(fraction * 8) % 8;
  const phase = PHASES[index];
  // Illumination: 0 at new, 1 at full, back to 0 — a cosine over the cycle.
  const illumination = Math.round((1 - Math.cos(fraction * 2 * Math.PI)) / 2 * 100);

  // Only the headline phases are really worth a mention; tell the agent so.
  const notable = phase === 'full moon' || phase === 'new moon'
    || phase === 'waxing crescent' || phase === 'waning crescent';

  return { available: notable, phase, illumination };
}
