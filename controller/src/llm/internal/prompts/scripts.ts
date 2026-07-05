// DJ scripts — creative spoken segments (free text under the persona prompt).
// Every generator: build context → compose prompt with a length budget and
// (where relevant) the talk-within-intro budget → decoratePrompt for variety →
// djText. Provider-agnostic; the model is resolved downstream.

import * as settings from '../../../settings.js';
import { djText } from '../strategy/text.js';
import { djSystem, lengthPhrase } from './system.js';
import { buildContextLines, decoratePrompt, randomSeed } from './context.js';
import { introBudgetPhrase, introMsFor, bpmKeyFor } from './intro-budget.js';

// Real-world context the generic between-track generators are allowed to weave
// in. Weather is deliberately EXCLUDED (issue #471): ambient weather stapled to
// every intro/link/ident/time-check made the DJ comically weather-heavy (~50%
// of all quips). Weather now reaches air only through the dedicated `weather`
// segment skill, which is cooldown- and change-gated. The weather-pushing
// narrative angles were trimmed to match — without the weather line in front of
// it, a model told to "mention the weather" would only invent it.
const SCRIPT_CONTEXT_FIELDS = ['date', 'clock', 'time', 'festival', 'show', 'listeners'];

export async function generateIntro({ track, context, requestedBy = null, requestText = null, artistMiss = null, recap = null, recentTracks = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context, { recentTracks, contextFields: SCRIPT_CONTEXT_FIELDS });
  if (requestedBy) ctxLines.push(`Requested by: ${requestedBy}`);
  if (requestText) {
    // Clip and sanitise so a long request can't dominate the prompt or break formatting.
    const clipped = String(requestText).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (clipped) ctxLines.push(`Listener asked: "${clipped}"`);
  }
  // Substitution: the listener named an artist we don't have, so the cascade
  // fell through to filler. Flag it so the intro stays HONEST instead of
  // pretending the track is by the requested artist (issue: "asked for Katy
  // Perry, got Daft Punk, intro still said Katy Perry").
  if (artistMiss) {
    ctxLines.push(`IMPORTANT: We do NOT have "${artistMiss}" in the library. The track coming up is NOT by them — it's a fitting substitute for the moment. Do not imply or claim the track is by "${artistMiss}".`);
  }
  ctxLines.push(`Coming up: "${track.title}" by ${track.artist}${track.album ? ` from ${track.album}` : ''}${track.year ? ` (${track.year})` : ''}`);

  // Talk-within-the-intro (A.3 phase 1): when the track's intro runway is
  // known, budget the line to land before the vocals. Advisory + additive —
  // empty for un-analysed tracks, so behaviour is unchanged there.
  const budget = introBudgetPhrase(introMsFor(track));
  const missClause = artistMiss
    ? ` The listener asked for "${artistMiss}", but we don't have them — briefly own that ("no ${artistMiss} in the crates", or similar), then introduce what's actually coming up as a worthy stand-in. Never pretend the track is by "${artistMiss}".`
    : '';
  const prompt = `Write an intro for this track. ${lengthPhrase('intro')}${budget ? ' ' + budget : ''} If the listener said something specific, acknowledge their words naturally — don't quote them verbatim, but weave the gist in. Never read the request out loud as-is. This is a listener request — keep the focus on what they asked for and the track coming up; don't back-announce or talk about the track that was just playing.${missClause}\n\n${ctxLines.join('\n')}`;

  return djText({
    system: djSystem(),
    prompt: decoratePrompt(prompt, { kind: 'intro', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateIntro',
  });
}

export async function generateStationId({ recap = null, context = null, recentOpeners = null, persona = null }: any = {}) {
  const speaker = persona || settings.getEffectivePersona();
  const djName = speaker?.name || 'your host';
  const stationName = settings.get().station;
  const ctxLines = buildContextLines(context, { contextFields: SCRIPT_CONTEXT_FIELDS });
  ctxLines.push(`Task: ${lengthPhrase('stationId', speaker)} for ${stationName} with ${djName}. A little understated.`);
  return djText({
    system: djSystem(speaker),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'station_id', recap, recentOpeners }),
    temperature: 1.0, topP: 0.9, repeatPenalty: 1.25, seed: randomSeed(),
    kind: 'generateStationId',
  });
}

// --- Persona handoff at a show boundary ------------------------------------
// When a show ends and a different persona takes over, the outgoing DJ signs
// off on air and passes the mic; the incoming DJ acknowledges and opens their
// shift. Both render as free text like every other segment, but each is voiced
// by ITS OWN persona — the system prompt is rendered with an explicit persona
// (djSystem(personaOut/In)) rather than the clock-driven effective one, which
// has already flipped to the incoming persona by the time these run.
// Anti-repeat: no ANGLES entry for 'handoff' (pickAngle returns null → no tone
// line), but the recent-openers blocklist still steers the first words clear of
// what just aired. A handoff fires at most ~once an hour, so that's plenty.

export async function generateSignoff({ personaOut, personaIn, showIn = null, context = null, recap = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context, { contextFields: SCRIPT_CONTEXT_FIELDS });
  const outName = personaOut?.name || 'your host';
  const inName = personaIn?.name || 'the next host';
  const handTo = showIn ? `${inName}, who's bringing you "${showIn}"` : inName;
  ctxLines.push(`Task: your time on air is wrapping up. Sign off in character as ${outName} and hand the mic over to ${handTo}. Say ${inName}'s name as you pass it along. ${lengthPhrase('link', personaOut)}. This is a real DJ passing the baton, warm and natural — not a formal announcement, and don't over-explain the schedule.`);
  return djText({
    system: djSystem(personaOut),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'handoff', recap, recentOpeners }),
    temperature: 1.0, topP: 0.9, repeatPenalty: 1.25, seed: randomSeed(),
    kind: 'generateSignoff',
  });
}

export async function generateHandoffGreeting({ personaIn, personaOut, signoffText = null, showIn = null, context = null, recap = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context, { contextFields: SCRIPT_CONTEXT_FIELDS });
  const inName = personaIn?.name || 'your host';
  const outName = personaOut?.name || 'the previous host';
  // The predecessor's actual sign-off rides in the prompt so the greeting can
  // genuinely respond to it ("Cheers Johnny…") rather than a generic hello.
  if (signoffText) {
    const clipped = String(signoffText).replace(/\s+/g, ' ').trim().slice(0, 240);
    if (clipped) ctxLines.push(`${outName} just signed off with: "${clipped}"`);
  }
  const showClause = showIn ? ` You're kicking off "${showIn}".` : '';
  ctxLines.push(`Task: you're ${inName}, just taking over the mic from ${outName}. Acknowledge ${outName} warmly and naturally — a quick nod to what they said if it fits — then ease into your shift.${showClause} ${lengthPhrase('link', personaIn)}. Keep it easy and in character; you're stepping up to the decks, not reading a bulletin.`);
  return djText({
    system: djSystem(personaIn),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'handoff', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateHandoffGreeting',
  });
}

// Operator ad-lib — the command-center "manual voice DJ" in styled mode.
// Takes a free-text instruction/topic and performs it in character, rather
// than reading it verbatim (that's what raw mode is for).
export async function generateAdLib({ instruction, context = null, recap = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context, { contextFields: SCRIPT_CONTEXT_FIELDS });
  const clipped = String(instruction || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  ctxLines.push(`Task: the station operator wants you to say something on-air. Their instruction: "${clipped}". Deliver it in character as a natural spoken line — don't read the instruction back verbatim, perform it. ${lengthPhrase('adlib')}.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'adlib', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateAdLib',
  });
}

export async function generateLink({ previous, current, context, recap = null, recentTracks = null, recentOpeners = null, persona = null }: any) {
  const speaker = persona || settings.getEffectivePersona();
  const ctxLines = buildContextLines(context, { recentTracks, contextFields: SCRIPT_CONTEXT_FIELDS });
  // Forward-looking only: the link is written when the pick is made but doesn't
  // air until that pick actually starts — and a listener request can slip ahead
  // of it in the meantime, so we can't know what really played just before it.
  // Naming the previous track is therefore unsafe (it goes stale → the DJ names
  // a track one older than reality). We intro the track NOW STARTING instead, so
  // the line is always correct whatever played before it. (`previous` is still
  // accepted for the tempo/key mix nod below — a vague feel, never a name.)
  if (current?.title) ctxLines.push(`Now playing: "${current.title}" by ${current.artist || 'unknown'}`);

  // DJ-mode personas lean harder into teasing the track's feel / artist.
  const djMode = !!speaker?.djMode;
  const teaseClause = djMode
    ? ` Name the artist or capture the feel so listeners know what they're hearing.`
    : '';
  // DJ-mode mix patter: only when BOTH tracks carry measured tempo/key, and
  // only as a natural option — never forced, never robotic numbers on air. This
  // is a feel ("easing into something a touch faster"), not a track name, so it
  // stays safe even if a request slipped in ahead of this pick.
  const prevAK = bpmKeyFor(previous);
  const curAK = bpmKeyFor(current);
  const patterClause = (djMode && (prevAK.bpm || prevAK.key) && (curAK.bpm || curAK.key))
    ? ` You may nod to the mix if it feels natural — e.g. easing into something a touch faster or slower, or how it sits in key — but never say raw numbers.`
    : '';
  // Talk-within-the-intro budget for the track now starting (current = the pick).
  const budget = introBudgetPhrase(introMsFor(current));
  const prompt = `Write a short DJ link to carry into the track now starting — set it up, capture its feel, weave in the moment.${teaseClause}${patterClause}${budget ? ' ' + budget : ''} ${lengthPhrase('link', speaker)}, conversational. Vary how you open — don't default to "here's", "this is", "coming up", or "that was"; find a different way in each time. Keep it forward-looking: don't back-announce, recap, or name the track that just played — focus on what's playing now.\n\n${ctxLines.join('\n')}`;

  return djText({
    system: djSystem(speaker),
    prompt: decoratePrompt(prompt, { kind: 'link', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateLink',
  });
}

export async function generateHourlyTime({ recap = null, context = null, recentOpeners = null, persona = null }: any = {}) {
  const ctxLines = buildContextLines(context, { contextFields: SCRIPT_CONTEXT_FIELDS });
  ctxLines.push(`Task: a brief top-of-the-hour time check, in character. ${lengthPhrase('hourly', persona || undefined)}. Say the time in natural spoken words ("two in the afternoon", "just gone eight") — never digits or 24-hour form.`);
  return djText({
    system: djSystem(persona || undefined),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'hourly', recap, recentOpeners }),
    temperature: 0.9, topP: 0.95, repeatPenalty: 1.15, seed: randomSeed(),
    kind: 'generateHourlyTime',
  });
}
