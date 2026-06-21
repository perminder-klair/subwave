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

export async function generateStationId({ recap = null, context = null, recentOpeners = null }: any = {}) {
  const djName = settings.getEffectivePersona()?.name || 'your host';
  const stationName = settings.get().station;
  const ctxLines = buildContextLines(context, { contextFields: SCRIPT_CONTEXT_FIELDS });
  ctxLines.push(`Task: ${lengthPhrase('stationId')} for ${stationName} with ${djName}. A little understated.`);
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

export async function generateLink({ previous, current, context, recap = null, recentTracks = null, recentOpeners = null }: any) {
  const ctxLines = buildContextLines(context, { recentTracks, contextFields: SCRIPT_CONTEXT_FIELDS });
  if (previous?.title) ctxLines.push(`Just played: "${previous.title}" by ${previous.artist || 'unknown'}`);
  if (current?.title) ctxLines.push(`Now playing: "${current.title}" by ${current.artist || 'unknown'}`);

  // DJ-mode personas tease what's coming, not just back-announce — mirrors the
  // agent path in broadcast/dj-agent.ts so both pickers feel like the same DJ.
  const djMode = !!settings.getEffectivePersona()?.djMode;
  const teaseClause = djMode
    ? ` Tease what's coming — name the artist or capture the feel so listeners know what's next.`
    : '';
  // DJ-mode mix patter: only when BOTH tracks carry measured tempo/key, and
  // only as a natural option — never forced, never robotic numbers on air.
  const prevAK = bpmKeyFor(previous);
  const curAK = bpmKeyFor(current);
  const patterClause = (djMode && (prevAK.bpm || prevAK.key) && (curAK.bpm || curAK.key))
    ? ` You may nod to the mix if it feels natural — e.g. easing into something a touch faster or slower, or how it sits in key — but never say raw numbers.`
    : '';
  // Talk-within-the-intro budget for the track now starting (current = the pick).
  const budget = introBudgetPhrase(introMsFor(current));
  const prompt = `Write a DJ link between tracks. Back-announce what just played and ease into what's playing now.${teaseClause}${patterClause}${budget ? ' ' + budget : ''} ${lengthPhrase('link')}, conversational, don't list both titles like a robot — pick one to mention specifically and treat the other lightly.\n\n${ctxLines.join('\n')}`;

  return djText({
    system: djSystem(),
    prompt: decoratePrompt(prompt, { kind: 'link', recap, recentOpeners }),
    temperature: 0.95, topP: 0.92, repeatPenalty: 1.2, seed: randomSeed(),
    kind: 'generateLink',
  });
}

export async function generateHourlyTime(time: any, weather: any, { recap = null, context = null, recentOpeners = null }: any = {}) {
  const ctx = context || { time, weather };
  const ctxLines = buildContextLines(ctx, { contextFields: SCRIPT_CONTEXT_FIELDS });
  ctxLines.push(`Task: a brief top-of-the-hour time check, in character. ${lengthPhrase('hourly')}.`);
  return djText({
    system: djSystem(),
    prompt: decoratePrompt(ctxLines.join('\n'), { kind: 'hourly', recap, recentOpeners }),
    temperature: 0.9, topP: 0.95, repeatPenalty: 1.15, seed: randomSeed(),
    kind: 'generateHourlyTime',
  });
}
