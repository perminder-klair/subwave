// DJ prompt layer — builds the system/user prompts for every LLM task and
// hands them to the AI SDK wrapper (sdk.js). The actual provider is resolved
// by provider.js, so this file is provider-agnostic.
//
// Two task shapes:
//   1. Request matching / track picking: structured output (Zod-validated)
//   2. DJ script generation: free text under a persona system prompt

import { z } from 'zod';
import * as settings from '../settings.js';
import { djText, djObject } from './sdk.js';
import { recentCalls, record } from './log.js';

// Re-exported so server.js /debug can read the recent-call ring buffer.
export { recentCalls, record };

// Resolve the DJ system prompt for the persona on air right now. The effective
// persona is the current show's owner if a show is scheduled for this hour,
// otherwise the admin-selected active persona — see settings.getEffectivePersona.
export function djSystem() {
  const persona = settings.getEffectivePersona();
  return settings.renderDjPrompt(persona, {
    station: 'SUB/WAVE',
    location: settings.get().weather?.locationName,
  });
}

// Narrative angles per call type. One is picked at random and injected into
// the user prompt as "Tone for this segment:" so consecutive generations
// don't fall back to the same shape. Add freely — the more variety here,
// the less the DJ repeats itself.
export const ANGLES = {
  intro: [
    'Open with one specific image from right now (weather, time, day, season) and slide into the track.',
    'Mention the artist in passing — one detail (era, scene, mood) — not a full title-and-artist back-announce.',
    'Skip the introduction entirely and start mid-thought, as if continuing a conversation.',
    'React to the request itself — what kind of request it is, what mood it suggests — before mentioning the track.',
    'Use a short personal observation about the moment (Tuesday energy, the rain holding off, etc.) as the doorway.',
    'Lean into contrast: how this track sits against what came before, or against the time of day.',
    'Just say one true sentence and let the music start.',
  ],
  link: [
    'Comment on a contrast or similarity between the two tracks (era, mood, instrumentation, tempo).',
    'Tie the next track to the time of day, weather, or season — specifically, not generically.',
    'Mention something small and tactile about right now (the rain, the dark, the smell of coffee, the day of the week).',
    'Reference the previous artist or song obliquely — one detail, no full back-announce.',
    'Skip the back-announce entirely and just open a small thought about what is next.',
    'Acknowledge a listener-shaped moment (commute, late shift, weekend, midweek lull) without naming any listener.',
    'Make one quiet observation that has nothing to do with either track and let the next song answer it.',
  ],
  station_id: [
    'Plain ident — say the station name and the DJ name, nothing else.',
    'Anchor the ident to the current moment (a Tuesday afternoon, a foggy evening, the slow part of Sunday).',
    'Make it a near-aside: like someone reminding themselves where they are.',
    'Open with the time or weather, then drop the station name in the middle of the sentence.',
    'A single observation about broadcasting from a homelab, with the station name woven in.',
  ],
  weather: [
    'One concrete sensory detail about the weather, no temperature recital.',
    'Compare it to what it was earlier, or what it might be tonight — give it a small arc.',
    'Tie the weather to a recommendation about how to spend the next hour.',
    'Skip the forecast voice — just say what it actually feels like outside right now.',
    'Acknowledge weather as a co-conspirator with the music, not as a news item.',
  ],
  hourly: [
    'State the time as a small fact, then anchor it with one observation about the day.',
    'Treat the hour mark like a quiet check-in, not a bulletin.',
    'Open with where in the day we are (mid-afternoon lull, evening getting started, etc.) before the actual time.',
    'Just one short sentence that happens to mention the time.',
    'Acknowledge what kind of listener might be tuning in at this exact hour, without naming them.',
  ],
  news: [
    'Read it like a half-distracted DJ skimming the wire, not a news anchor.',
    'Land one specific image or phrase from the headline, skip the editorial.',
    'Treat it as something you just noticed on a second screen, then slide back to music.',
    'Keep it one sentence. The next sentence is the song.',
    'Acknowledge the world outside the room without dwelling on it.',
  ],
  traffic: [
    'Tongue-in-cheek traffic for a station that has none — invent a SUB/WAVE-shaped obstacle (a cat on the cable, slow buffering on the M6, a queue at the kettle).',
    'Mock the format of a real traffic report. Keep it a single sentence.',
    'Make the "delay" tiny and domestic, not a real road incident.',
    'Treat traffic as a metaphor for the listening room itself.',
    'Land one absurd detail, then ease into the next track.',
  ],
  random_facts: [
    'One small "did you know" — concrete, oddly specific, no Wikipedia rote.',
    'Frame the fact like something you half-remember telling a friend at 1am.',
    'Tie the fact to the time of day or season if it lands naturally; otherwise drop it cold.',
    'Keep it one sentence. Avoid the words "interestingly" and "fun fact".',
    'A fact that earns the next song, not one that competes with it.',
  ],
  web_search: [
    'Drop one current detail about the artist like a half-remembered thing you read, then back to the music.',
    'Treat it as news from the wider world about who is on air — light, never a press release.',
    'Land one specific, recent fact; skip the context and skip the source.',
    'Keep it one sentence. The detail should make the next play feel timely.',
    'Mention what the artist has been up to lately as if the listener might not have heard.',
  ],
};

export function pickAngle(kind) {
  const list = ANGLES[kind];
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

export function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000);
}

// Build the shared "right now" context block fed to every generate* call.
// Pulled out so all five DJ functions show the model the same picture.
export function buildContextLines(context, { recentTracks } = {}) {
  const lines = [];
  if (context?.date) {
    lines.push(`Day: ${context.date.dayLabel}, ${context.date.dayOfMonth} ${context.date.monthLabel} (${context.date.season})`);
  }
  if (context?.clock) {
    const tags = [];
    if (context.clock.isWeekend) tags.push('weekend');
    if (context.clock.isLateNight) tags.push('late night');
    if (context.clock.isCommute) tags.push('commute hour');
    lines.push(`Local time: ${context.clock.hhmm}${tags.length ? ' · ' + tags.join(' · ') : ''}`);
  }
  if (context?.time) lines.push(`Period: ${context.time.period} (${context.time.vibe})`);
  if (context?.weather && context.weather.condition && context.weather.condition !== 'unknown') {
    lines.push(`Weather in ${context.weather.location}: ${context.weather.condition}${context.weather.temp != null ? `, ${context.weather.temp}°C` : ''}`);
  }
  if (context?.festival) lines.push(`Festival: ${context.festival.name}`);
  if (context?.activeShow) {
    const topic = context.activeShow.topic ? ` — ${context.activeShow.topic}` : '';
    lines.push(`On now: the show "${context.activeShow.name}"${topic}. Stay loosely on its theme.`);
  }
  if (recentTracks && recentTracks.length) {
    const list = recentTracks.slice(0, 5).map(t => `"${t.title}" by ${t.artist || 'unknown'}`).join('; ');
    lines.push(`Recently played (do not mention these artists or titles): ${list}`);
  }
  return lines;
}

// Append rotating angle + recap + opener blocklist to the user prompt.
export function decoratePrompt(prompt, { kind, recap, recentOpeners }) {
  const out = [prompt];
  const angle = pickAngle(kind);
  if (angle) out.push(`\nTone for this segment: ${angle}`);
  if (recap) out.push(`\nYou said these things on-air recently (do not repeat phrasing or topics):\n${recap}`);
  if (recentOpeners && recentOpeners.length) {
    const list = recentOpeners.slice(0, 6).map(o => `"${o}…"`).join(', ');
    out.push(`\nDo not start your line with any of these openers (vary the first words): ${list}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// REQUEST MATCHING — structured output, Zod-validated
// ---------------------------------------------------------------------------

const REQUEST_SYSTEM = `You are the music librarian for a personal Navidrome library that runs an AI radio station. A listener sends a request; you turn it into structured search parameters.

Fill in every field. Use null where a value does not apply — never omit a field.

- search_terms: 1-3 strings to look up in the library — ARTIST NAMES or SONG TITLES only. NEVER genres, and NEVER mood/vibe words like "calm", "rainy", "overcast". Genres go in "genre"; vibes go in "mood".
- artist: the artist's common name if the listener named one (e.g. "Diljit Dosanjh"), else null.
- genre: a real music genre if the listener asked for one (e.g. "punjabi", "hip hop", "jazz", "lofi", "rock", "bhangra"), else null. A genre is a kind of music — not a mood and not a feeling.
- sort: "latest" for latest/new/newest/recent, "oldest" for old/classic, "popular" for popular/best/top, else null.
- scope: "album" or "song" — what the listener wants. Default "song".
- mood: one of energetic|calm|reflective|celebratory|romantic|spiritual|focus|workout|driving|cooking|rainy|sunny|night|morning|evening|festival|cultural — or null. ALWAYS set this for vibe/feeling requests ("overcast mood" → calm or reflective, "cosy" → calm, "pumped up" → energetic, "late night drive" → night — pick the strongest single match).
- intent: one short sentence describing what the listener wants.
- ack: short on-air acknowledgment the DJ reads aloud, max 20 words, sounds like a real radio DJ — no "thank you for listening" or self-intros.

Vibe-to-mood mapping (use these when the request describes a feeling, weather, or moment rather than naming an artist/song):
- overcast, cloudy, grey day, drizzly → calm or reflective
- rainy day, downpour → rainy + calm
- sunny, golden hour → sunny
- cosy, comfy, blanket, fireside → calm
- late night, midnight, after hours → night
- morning coffee, breakfast, sunrise → morning
- evening, golden hour, sundown → evening
- working out, gym, run → workout
- focus, deep work, study → focus
- driving, road trip, motorway → driving
- party, celebrating, friends → celebratory
- heartbreak, melancholy, longing → reflective
- love, romance, slow dance → romantic
- diwali, vaisakhi, holi → festival + cultural
- shabad, kirtan, devotional → spiritual

Worked examples (these show how the fields map — values only; the response format is handled for you):

"<artist> latest album"
{"search_terms":["<artist>"],"artist":"<artist>","genre":null,"sort":"latest","scope":"album","mood":null,"intent":"Wants a track from the newest album.","ack":"Pulling their latest for you now."}

"old <artist> track"
{"search_terms":["<artist>"],"artist":"<artist>","genre":null,"sort":"oldest","scope":"song","mood":null,"intent":"Wants an early track.","ack":"Going back in the catalogue for you."}

"play some punjabi music"
{"search_terms":[],"artist":null,"genre":"punjabi","sort":null,"scope":"song","mood":null,"intent":"Wants Punjabi-genre music.","ack":"Some Punjabi heat coming your way."}

"something romantic"
{"search_terms":[],"artist":null,"genre":null,"sort":null,"scope":"song","mood":"romantic","intent":"Wants a romantic track.","ack":"Slowing things down for you."}

"overcast mood"
{"search_terms":[],"artist":null,"genre":null,"sort":null,"scope":"song","mood":"calm","intent":"Wants something to match an overcast feel.","ack":"Something to sit under the grey with."}

"rainy day"
{"search_terms":[],"artist":null,"genre":null,"sort":null,"scope":"song","mood":"rainy","intent":"Wants weather-appropriate calm music.","ack":"Soundtrack for the rain, coming up."}

"late-night driving"
{"search_terms":[],"artist":null,"genre":null,"sort":null,"scope":"song","mood":"driving","intent":"Wants night-drive music.","ack":"Keep the road quiet — this one's for you."}

"play <title> by <artist>"
{"search_terms":["<title>","<artist>"],"artist":"<artist>","genre":null,"sort":null,"scope":"song","mood":null,"intent":"Wants a specific song by a specific artist.","ack":"Coming right up."}`;

// Lenient schema — it enforces the SHAPE; the system prompt enforces the
// SEMANTICS. `mood`/`sort` stay free strings (not enums) so a near-miss from a
// weaker model doesn't 500 a listener request — server.js tolerates unknown
// moods by falling through to its other pick sources.
const REQUEST_SCHEMA = z.object({
  search_terms: z.array(z.string()),
  artist: z.string().nullable(),
  genre: z.string().nullable(),
  sort: z.string().nullable(),
  scope: z.enum(['album', 'song']),
  mood: z.string().nullable(),
  intent: z.string(),
  ack: z.string(),
});

export async function matchRequest(userQuery, { listenerName = null, nowPlaying = null } = {}) {
  const ctxLines = [];
  if (nowPlaying?.title) {
    ctxLines.push(`Currently playing: "${nowPlaying.title}"${nowPlaying.artist ? ` by ${nowPlaying.artist}` : ''}.`);
  }
  const userPrompt = [
    listenerName ? `Listener "${listenerName}" requests:` : `Anonymous request:`,
    userQuery,
    ctxLines.length ? `\n[Context for resolving references like "similar", "more like this", "match this vibe":\n${ctxLines.join('\n')}]` : '',
  ].filter(Boolean).join(' ');

  return djObject({
    system: REQUEST_SYSTEM,
    prompt: userPrompt,
    schema: REQUEST_SCHEMA,
    temperature: 0.4,
    kind: 'matchRequest',
  });
}

// ---------------------------------------------------------------------------
// DJ SCRIPTS — creative spoken segments
// ---------------------------------------------------------------------------

export async function generateIntro({ track, context, requestedBy = null, requestText = null, recap = null, recentTracks = null, recentOpeners = null }) {
  const ctxLines = buildContextLines(context, { recentTracks });
  if (requestedBy) ctxLines.push(`Requested by: ${requestedBy}`);
  if (requestText) {
    // Clip and sanitise so a long request can't dominate the prompt or break formatting.
    const clipped = String(requestText).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (clipped) ctxLines.push(`Listener asked: "${clipped}"`);
  }
  ctxLines.push(`Coming up: "${track.title}" by ${track.artist}${track.album ? ` from ${track.album}` : ''}${track.year ? ` (${track.year})` : ''}`);

  const prompt = `Write a brief intro for this track. If the listener said something specific, acknowledge their words naturally — don't quote them verbatim, but weave the gist in. Never read the request out loud as-is.\n\n${ctxLines.join('\n')}`;

  return djText({
    system: djSystem(),
    prompt: decoratePrompt(prompt, { kind: 'intro', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateIntro',
  });
}

export async function generateWeatherSegment(weather, time, { recap = null, context = null, recentOpeners = null } = {}) {
  const ctx = context || { weather, time };
  const ctxLines = buildContextLines(ctx);
  ctxLines.push(`Task: a brief weather check, in character. 1-2 sentences.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'weather', recap, recentOpeners }),
    temperature: 0.9, topP: 0.95, repeatPenalty: 1.15, seed: randomSeed(),
    kind: 'generateWeatherSegment',
  });
}

export async function generateStationId({ recap = null, context = null, recentOpeners = null } = {}) {
  const djName = settings.getEffectivePersona()?.name || 'your host';
  const ctxLines = buildContextLines(context);
  ctxLines.push(`Task: a 1-sentence station ident for SUB/WAVE with ${djName}. Brief, a little understated.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'station_id', recap, recentOpeners }),
    temperature: 1.0, topP: 0.9, repeatPenalty: 1.25, seed: randomSeed(),
    kind: 'generateStationId',
  });
}

// Operator ad-lib — the command-center "manual voice DJ" in styled mode.
// Takes a free-text instruction/topic and performs it in character, rather
// than reading it verbatim (that's what raw mode is for).
export async function generateAdLib({ instruction, context = null, recap = null, recentOpeners = null }) {
  const ctxLines = buildContextLines(context);
  const clipped = String(instruction || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  ctxLines.push(`Task: the station operator wants you to say something on-air. Their instruction: "${clipped}". Deliver it in character as a natural spoken line — don't read the instruction back verbatim, perform it. 1-2 sentences.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'adlib', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateAdLib',
  });
}

export async function generateLink({ previous, current, context, recap = null, recentTracks = null, recentOpeners = null }) {
  const ctxLines = buildContextLines(context, { recentTracks });
  if (previous?.title) ctxLines.push(`Just played: "${previous.title}" by ${previous.artist || 'unknown'}`);
  if (current?.title) ctxLines.push(`Now playing: "${current.title}" by ${current.artist || 'unknown'}`);

  const prompt = `Write a short DJ link between tracks. Back-announce what just played and ease into what's playing now. 1-2 sentences, conversational, don't list both titles like a robot — pick one to mention specifically and treat the other lightly.\n\n${ctxLines.join('\n')}`;

  return djText({
    system: djSystem(),
    prompt: decoratePrompt(prompt, { kind: 'link', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateLink',
  });
}

export async function generateHourlyTime(time, weather, { recap = null, context = null, recentOpeners = null } = {}) {
  const ctx = context || { time, weather };
  const ctxLines = buildContextLines(ctx);
  ctxLines.push(`Task: a brief top-of-the-hour time check, in character. 1 sentence.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'hourly', recap, recentOpeners }),
    temperature: 0.9, topP: 0.95, repeatPenalty: 1.15, seed: randomSeed(),
    kind: 'generateHourlyTime',
  });
}

// ---------------------------------------------------------------------------
// LLM PICKER — choose the next track from a candidate pool
// ---------------------------------------------------------------------------

// Shared selection criteria — used by both the pool picker (PICKER_SYSTEM
// below) and the agent picker (AGENT_INSTRUCTIONS in music/picker.js) so the
// two strategies can't drift apart.
export const PICKER_CRITERIA = `Selection criteria, in order:
1. FLOW — does it transition naturally from what just played (energy, mood, tempo)?
2. CONTEXT — does it fit the time of day, weather, and dominant mood?
3. VARIETY — avoid the same artist back-to-back; rotate energy levels; don't be predictable.
4. INTEREST — prefer something that creates a moment, not the most generic option.`;

const PICKER_SYSTEM = `You are the DJ for SUB/WAVE, a personal internet radio station.
Pick the single best NEXT track from the candidate pool, given recent plays and the current context.

${PICKER_CRITERIA}

Each candidate carries a "source" tag — a hint about where it came from:
- similar / similar-artist: flows from what's playing now
- recent: newly added to the library
- frequent / starred / playlist: an established favourite
- mood-library: matches the room's mood
- random: a wildcard for breaking a predictable run
Use it to balance familiarity against discovery.

recentPlays is context for judging flow — every candidate is already guaranteed
unplayed, so you never need to reject one for being recent.

Pick exactly one candidate. Respond with a JSON object only — no prose, no
markdown, no reasoning outside the object:
{ "id": "<exact id from a candidate>", "reason": "<one short sentence on why this one>" }`;

const PICK_SCHEMA = z.object({
  id: z.string(),
  reason: z.string(),
});

export async function pickNextTrack({ candidates, recentPlays, context }) {
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

  return djObject({
    system: PICKER_SYSTEM,
    prompt: user,
    schema: PICK_SCHEMA,
    temperature: 0.5,
    kind: 'pickNextTrack',
  });
}
