// The shared "right now" context block + narrative-variety helpers. Used by
// every generate* script, by matchRequest, and by the segment director
// (skills/_agent.js) — so they all show the model the same picture of the moment.

// Narrative angles per call type. One is picked at random and injected into the
// user prompt as "Tone for this segment:" so consecutive generations don't fall
// back to the same shape. Only the generate* callers consume these — the segment
// director gets its variety from its CAPABILITIES descriptions. Add freely — the
// more variety here, the less the DJ repeats itself.
export const ANGLES = {
  intro: [
    'Open with one specific image from right now (the time, the day, the season, the light) and slide into the track.',
    'Mention the artist in passing — one detail (era, scene, mood) — not a full title-and-artist back-announce.',
    'Skip the introduction entirely and start mid-thought, as if continuing a conversation.',
    'React to the request itself — what kind of request it is, what mood it suggests — before mentioning the track.',
    'Use a short personal observation about the moment (Tuesday energy, the slow drift of the afternoon, etc.) as the doorway.',
    'Lean into contrast: how this track sits against the time of day or the mood of the moment.',
    'Just say one true sentence and let the music start.',
  ],
  // Links are FORWARD-LOOKING — they introduce the track now starting and never
  // back-announce the previous one (it may not be what actually aired just
  // before this; see generateLink + dj-agent linkClause). So every angle here is
  // about the track coming on or the moment, never "that was…". Keep them varied
  // so the opener doesn't settle into one shape ("here's…", "coming up…").
  link: [
    'Open mid-thought, as if you never stopped talking — skip "here\'s" / "this is" / "coming up" entirely.',
    // No "the hour" here: a link is written one track before it airs, so a
    // clock reference is stale on air (issue #864) — the air-time clock, when
    // known, reaches the model through the event/prompt clause instead. No
    // "the weather" either: it isn't in the link context (issue #471), so the
    // model would only invent it.
    'Lead with one specific image from right now — the light, the day, the season — and let the track answer it.',
    'Drop one detail about the track now starting (its era, its scene, how its first seconds feel), woven into a sentence, not announced like a title card.',
    'Make one small, true observation that has nothing to do with music, then let the song pick it up.',
    'Name the artist only in passing, folded into a thought — never "this is X by Y".',
    'Pose a tiny question or thought and let the track be the answer.',
    'Acknowledge a listener-shaped moment (commute, late shift, weekend, midweek lull) without naming anyone, then ease in.',
    'Say one honest sentence about how this track lands right now, and get out of the way.',
    'React to the shift in the room as it comes on — how it lifts, settles, darkens, or opens things up.',
  ],
  station_id: [
    'Plain ident — say the station name and the DJ name, nothing else.',
    'Anchor the ident to the current moment (a Tuesday afternoon, a quiet evening, the slow part of Sunday).',
    'Make it a near-aside: like someone reminding themselves where they are.',
    'Open with the time of day, then drop the station name in the middle of the sentence.',
    'One small observation about the station itself — its scale, its late hours, its one-room intimacy — with the name woven in.',
    'Address the listener directly for once — wherever they are, whatever they\'re doing, they found the right place.',
    'Say it like a signature at the bottom of a letter — brief, warm, done.',
    'Fold the ident into a quiet promise of what the next stretch holds — more of this, whatever this is.',
  ],
  hourly: [
    'State the time as a small fact, then anchor it with one observation about the day.',
    'Treat the hour mark like a quiet check-in, not a bulletin.',
    'Open with where in the day we are (mid-afternoon lull, evening getting started, etc.) before the actual time.',
    'Just one short sentence that happens to mention the time.',
    'Acknowledge what kind of listener might be tuning in at this exact hour, without naming them.',
    'Note what this hour usually means — the kettle hour, the last-push hour, the winding-down hour — then land the time inside it.',
    'Mark the hour as a small milestone in the day: one down, or one to go, or the halfway point.',
    'Mention the time as if answering someone who just asked — offhand, unbothered.',
    'Let the hour prompt a tiny aside about how fast or slow the day is moving, time folded in.',
    'Tie the hour to the light outside — what the sky is probably doing right now — and slip the time in after.',
  ],
};

// Uniform random, but never the same angle twice running for a kind — on an
// aggressive station (3 idents/hour) a ~20% consecutive-repeat chance made the
// segment shape audibly settle. The opener blocklist only guards first words;
// this guards the whole framing.
const lastAngleIdx = new Map<string, number>();

export function pickAngle(kind: string) {
  const list = (ANGLES as any)[kind];
  if (!list || list.length === 0) return null;
  let idx = Math.floor(Math.random() * list.length);
  if (list.length > 1 && idx === lastAngleIdx.get(kind)) idx = (idx + 1) % list.length;
  lastAngleIdx.set(kind, idx);
  return list[idx];
}

export function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000);
}

// The "right now" fields buildContextLines can emit — the vocabulary every
// per-skill / per-generator context allowlist is drawn from (issue #471). Order
// is the order the lines are emitted in. Keep in sync with the guards below.
export const CONTEXT_FIELDS = ['date', 'clock', 'time', 'weather', 'festival', 'show', 'listeners'] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];

// Normalise a contextFields spec (array | comma-string | null/undefined) to a
// Set of known field keys, or `null` meaning "every field" — the back-compat
// default for callers that pass nothing. `all` / `*` is an explicit "every
// field" too. Unknown tokens are dropped silently, so a typo in a SKILL.md
// just narrows the block rather than crashing the tick.
export function normalizeContextFields(spec?: string | readonly string[] | null): Set<string> | null {
  if (spec == null) return null;
  const raw = Array.isArray(spec) ? spec : String(spec).split(',');
  const out = new Set<string>();
  for (const tok of raw as readonly string[]) {
    const k = String(tok).trim().toLowerCase();
    if (!k) continue;
    if (k === 'all' || k === '*') return null;
    if ((CONTEXT_FIELDS as readonly string[]).includes(k)) out.add(k);
  }
  return out;
}

export function buildContextLines(
  context: any,
  { recentTracks, contextFields }: { recentTracks?: any[]; contextFields?: string | readonly string[] | null } = {},
) {
  // `allow === null` means no gating (every field) — the historical behaviour
  // for callers that don't pass contextFields.
  const allow = normalizeContextFields(contextFields);
  const on = (f: ContextField) => allow === null || allow.has(f);
  const lines: string[] = [];
  if (on('date') && context?.date) {
    lines.push(`Day: ${context.date.dayLabel}, ${context.date.dayOfMonth} ${context.date.monthLabel} (${context.date.season})`);
  }
  if (on('clock') && context?.clock) {
    const tags: string[] = [];
    if (context.clock.isDark) tags.push('after dark');
    if (context.clock.isWeekend) tags.push('weekend');
    if (context.clock.isLateNight) tags.push('late night');
    // No 'commute hour' tag: stapling it to every spoken segment (alongside the
    // drive-time period label) made the DJ read as a traffic-report station for
    // two hours a day. isCommute still gates commute-window skills and the
    // energy pacing in code (context.ts) — it just isn't prompt fodder anymore.
    lines.push(`Local time: ${context.clock.hhmm}${tags.length ? ' · ' + tags.join(' · ') : ''}`);
  }
  if (on('time') && context?.time) lines.push(`Period: ${context.time.period} (${context.time.vibe})`);
  if (on('weather') && context?.weather && context.weather.condition && context.weather.condition !== 'unknown') {
    lines.push(`Weather in ${context.weather.location}: ${context.weather.condition}${context.weather.temp != null ? `, ${context.weather.temp}°${context.weather.tempUnit || 'C'}` : ''}`);
  }
  if (on('festival') && context?.festival) lines.push(`Festival: ${context.festival.name}`);
  if (on('show') && context?.activeShow) {
    const topic = context.activeShow.topic ? ` — ${context.activeShow.topic}` : '';
    lines.push(`On now: the show "${context.activeShow.name}"${topic}. Stay loosely on its theme.`);
  }
  if (on('listeners') && context?.listeners?.count != null) {
    const n = context.listeners.count;
    lines.push(n === 0
      ? `No one is tuned in right now.`
      : `Listeners tuned in right now: ${n}.`);
  }
  if (recentTracks && recentTracks.length) {
    const list = recentTracks.slice(0, 5).map((t: any) => `"${t.title}" by ${t.artist || 'unknown'}`).join('; ');
    lines.push(`Recently played (do not mention these artists or titles): ${list}`);
  }
  return lines;
}

// Append rotating angle + recap + opener blocklist to the user prompt.
export function decoratePrompt(
  prompt: string,
  { kind, recap, recentOpeners }: { kind: string; recap?: string | null; recentOpeners?: string[] | null },
) {
  const out: string[] = [prompt];
  const angle = pickAngle(kind);
  if (angle) out.push(`\nTone for this segment: ${angle}`);
  if (recap) out.push(`\nYou said these things on-air recently (do not repeat phrasing or topics):\n${recap}`);
  if (recentOpeners && recentOpeners.length) {
    const list = recentOpeners.slice(0, 6).map((o: string) => `"${o}…"`).join(', ');
    out.push(`\nDo not start your line with any of these openers (vary the first words): ${list}`);
  }
  return out.join('\n');
}
