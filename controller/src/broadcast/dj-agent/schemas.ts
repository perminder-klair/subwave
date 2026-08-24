// The pick and request output schemas, and the system prompts that go with
// them. The schema comments are load-bearing - read them before changing a
// field's nullability.
//
// Part of the dj-agent/ split - see ../dj-agent.ts for the pick/request runs.

import { z } from 'zod';
import * as settings from '../../settings.js';
import * as session from '../session.js';
import * as dj from '../../llm/dj.js';
import { modelTolerant } from '../../llm/sdk.js';
import { autoVoiceAllowed } from '../voice-policy.js';
import { speakClockAllowed } from '../clock-policy.js';
import { SEED_NOT_A_PICK_CLAUSE } from '../../util/pick-seed.js';
import { instruction } from '../../llm/dj.js';


// Plain .nullable() fields, deliberately — GLM's malformed spellings of
// "nothing" (the string "null", an omitted key, a double-JSON-encoded object)
// are repaired by the modelTolerant wrapper in pickSchema() below, at the
// OBJECT level. Do not wrap individual fields in a preprocess: a per-field
// pipe drops that field from the tool inputSchema's `required` array (the AI
// SDK renders Zod with io:'input'), which invites every provider to omit it —
// see modelTolerant's comment in core/pure.ts.
export const PICK_SCHEMA = z.object({
  // The seed clause is NOT decoration (#1247): "never invent or compose ids" is
  // literally satisfied by the on-air track's id, which the pick event message
  // hands over precisely so the model can seed the discovery tools with it — so
  // a model cornered into committing with an empty tool result answered with it,
  // the run was discarded, and the slot fell to the pool picker. One shared
  // wording, in util/pick-seed.ts; don't inline a second copy here.
  id: z.string().describe(`the exact song id returned by one of the discovery tools — never invent or compose ids. ${SEED_NOT_A_PICK_CLAUSE}`),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just note what makes THIS pick a fresh step (a shift in energy/era/texture, or an artist genuinely new to the rotation), not a vibe label you would recycle pick after pick (e.g. "warmer, driving energy", never a repeated "mellow reflective step"). Only call a pick a "new artist" when it has no "artist_play_count"/"artist_last_played_days_ago"; "unaired" means this song is new to the station, not that its artist is. If the artist shows recent or frequent plays, describe the real reason instead (energy shift, texture, flow)'),
  say: z.string().nullable().describe('when the latest event message says to write a spoken link, set this to one or two natural sentences in the DJ voice that INTRODUCE the track you are about to play — set it up, name the artist or capture its feel, vary your opener. Do NOT back-announce, recap, or name the track that just played (a listener request may slip in ahead of your pick, so what aired right before it is not certain). Never state a clock time unless the event message tells you when the link airs — then use exactly that time. When the event says stay silent, set this to null'),
  // Transition effects (only honoured when the system prompt offers them — persona djMode, see settings.effectsActive).
  // One-line pointer only: the full coaching is dj.effectsGuidance() in the
  // system prompt. This description used to repeat all of it, so every agent
  // pick carried the effects text TWICE (~500 wasted tokens per call).
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('transition treatment per the TRANSITION EFFECTS guidance: "washout"/"loop" end THIS pick (loop needs measured tempo), "sweep"/"dissolve"/"chop" carry the previous track across a clash (chop only out of beat-driven material), "blend" only for an exceptionally locked pair; "normal" or null for a plain crossfade'),
});

// Same shape, transition coaching stripped. Zod field descriptions travel to
// the model as part of the structured-output contract even when every prompt
// mention is gated off, so with DJ mode off the description above kept talking
// the model into "blend"/"sweep" picks that runTrackEvent silently discarded —
// the LLM log showed effects that could never air. The enum stays identical
// (validation must not depend on persona state); only the description flips.
export const PICK_SCHEMA_NO_FX = PICK_SCHEMA.extend({
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('always set to null — transition effects are not available for this persona'),
});

// The live pick schema, resolved per run: the transition coaching follows the
// on-air persona's djMode (settings.effectsActive), and the `say` length
// follows its scriptLength — without this overlay an 'extended' storytelling
// persona stretched to 4-6 sentence links on the pool path (generateLink gets
// lengthPhrase in its prompt) but snapped back to the consts' hard-coded "one
// or two sentences" whenever the default-on agent picker was doing the talking.
// The plain (un-wrapped) object — for callers that still need to .extend()
// (repickFromSeen pins `id` to the run's own candidate set). Extend THIS,
// then re-wrap with modelTolerant; a ZodPreprocess pipe has no .extend.
export function pickSchemaBase() {
  const base = settings.effectsActive() ? PICK_SCHEMA : PICK_SCHEMA_NO_FX;
  // Clock rule, resolved per run like effectsActive() above. With the station's
  // clock switch off (broadcast/clock-policy.ts) the "unless the event message
  // tells you" escape hatch is dropped rather than left dangling: the event
  // message never offers a time in that mode, and a flat ban is a clearer
  // instruction than a condition that can never be met. The static description
  // on PICK_SCHEMA is deliberately NOT gated — it is module-level, so it would
  // freeze at boot instead of applying live, and this override always replaces
  // it on the air path.
  const clockRule = speakClockAllowed()
    ? 'Never state a clock time unless the event message tells you when the link airs — then use exactly that time.'
    : 'Never state a clock time, the hour, or the time of day.';
  return base.extend({
    say: z.string().nullable().describe(`when the latest event message says to write a spoken link, set this to ${dj.lengthPhrase('link')} of natural speech in the DJ voice that INTRODUCE the track you are about to play — set it up, name the artist or capture its feel, vary your opener. Do NOT back-announce, recap, or name the track that just played (a listener request may slip in ahead of your pick, so what aired right before it is not certain). ${clockRule} When the event says stay silent, set this to null`),
  });
}

export function pickSchema() {
  // modelTolerant repairs GLM's malformed nullable spellings ("null"-the-
  // string, an omitted key) at the object level, on every parse path (done-
  // tool args, text salvage) — the wire schema stays identical to the plain
  // object's, all fields still required. See core/pure.ts.
  return modelTolerant(pickSchemaBase());
}

// Resolved per run, like pickSchema: the intro length follows the on-air
// persona's scriptLength. The stateless fallback's generateIntro gets
// lengthPhrase('intro') in its prompt, so without this overlay an 'extended'
// storytelling persona kept its long intros on the cascade path but snapped
// back to an unspecified length whenever the agent handled the request.
// Exported for scripts/llm-bench (same precedent as pickSystem/pickSchema for
// picker-test.mjs) — live callers stay on requestAgent.
export function requestSchema() {
  const base = z.object({
    // The classification is EXPLICIT, and separate from `id`, for one reason:
    // a missing key and a deliberate "this isn't a music request" used to be
    // the same wire value. coerceModelPayload maps an omitted nullable key to
    // null (core/pure.ts), so a model that simply FORGOT `id` — a documented,
    // observed failure mode of the local/GLM-class models this station runs —
    // took the chat escape, and the listener's real music request silently
    // played nothing. With `kind` carrying the decision, an omission degrades
    // to 'track' (objectFallbacks below) and falls through to the repick
    // salvage and then the caller's stateless cascade — the branch that keeps
    // the "never refuse music" rule true.
    kind: z.enum(['track', 'chat']).describe('"track" when the listener wants music played — the normal case, and the right answer whenever you are unsure. "chat" ONLY when the message is not a music request at all (a question, a greeting, banter, a demand to change how the station behaves) — then "ack" answers them, "id" is null, and nothing is queued.'),
    // Same seed clause as PICK_SCHEMA.id above — the request event line carries
    // the on-air track's `[id: …]` too (routes/request.ts + runRequestViaAgent),
    // and repickRequestFromSeen's comment records the same id-copied-from-the-
    // session-turn signature. requestSystem() says it in prose; the field
    // description is what travels to every provider as the output contract.
    id: z.string().nullable().describe(`the exact song id returned by one of the discovery tools — never invent or compose ids. ${SEED_NOT_A_PICK_CLAUSE} Null ONLY when kind is "chat"`),
    ack: z.string().describe('short on-air acknowledgement of the listener, in character — max 20 words; no "thank you for listening" or self-intros'),
  });
  // `kind` is REQUIRED and non-nullable, so coerceModelPayload deliberately
  // leaves it alone when the model omits it ("modelTolerant's fallbacks handle
  // it") and a plain enum would throw the run away. Fall back to 'track' — the
  // pre-existing, already-safe behaviour from before this field existed. Same
  // precedent as REQUEST_SCHEMA_TOLERANT (llm/internal/prompts/request.ts) and
  // skills/_agent.ts's `segment`.
  const tolerant = { objectFallbacks: { kind: 'track' } };
  // Station voice off (settings.tts.enabled): no spoken intro can air, so the
  // field leaves the contract entirely rather than being written and dropped —
  // the request-path counterpart of runTrackEvent forcing wantLink=false, on
  // the same resolved-per-run pattern as pickSchemaBase's effectsActive()
  // branch. runRequestViaAgent still guards its own read, covering the switch
  // flipping mid-run (this schema resolved before the flip).
  // modelTolerant repairs weak-model nullable spellings ("null"-the-string, an
  // omitted key) at the OBJECT level, same precedent as pickSchema() above —
  // `id`'s .nullable() stays a plain field; never wrap an individual field in
  // its own preprocess pipe (see the note atop pickSchema).
  if (!autoVoiceAllowed()) return modelTolerant(base, tolerant);
  return modelTolerant(base.extend({
    intro: z.string().describe(`a natural DJ intro for the track in the DJ voice; weave in what the listener asked for without reading the request back verbatim, and name the listener once if the final user line gives their name. It airs over the track's opening seconds, so write it in the present tense — never "next" or "coming up". ${dj.lengthPhrase('intro')}`),
  }), tolerant);
}

// The data-not-direction rule, shared verbatim by BOTH agent prompts that can
// see listener text. requestSystem() sees it in the message it is resolving;
// pickSystem() sees it in the session window, which carries every recent
// request turn for ~40 turns / 4h — so a later pick's spoken link is just as
// much a listener-text-to-air path as the request intro is, and used to be the
// only one with no framing at all behind it.
export const LISTENER_TEXT_CLAUSE = instruction('shared', 'listener-text');

// Ultra-minimal — persona + editorial criteria, nothing else. The AI SDK already
// conveys the rest through its own channels: tool descriptions, the done-tool
// description, schema field descriptions, and the per-pick event message in the
// session window. Duplicating those in prompt text competes with the framework's
// structural signals and derails smaller models. PICKER_CRITERIA stays because
// editorial preference (flow, context, variety, interest) is in no tool or
// schema.
//
// The transition-effects guidance lives in prompts/picker.ts (dj.effectsGuidance)
// so the pool picker shares it verbatim, and is appended ONLY when effects are
// active (settings.effectsActive — there is no separate toggle). Invisible
// otherwise, so the model leaves "transition" null.

// `showAt` — resolve the show brief/leans for that future moment instead of
// now: the pick airs when the current track ends, so near a show boundary the
// INCOMING show's rules are the ones to follow (see the look-ahead in
// queue.onTrackStarted). The persona now comes from the session, which the
// same look-ahead has already rolled — the mic-pass aired ahead of this pick,
// so the incoming DJ introduces their own opener rather than the outgoing DJ
// teeing up a show they've already signed off from.
export function pickSystem(showAt: Date | null = null, playlistResolved = true) {
  const persona = session.onAirPersona();
  // In DJ mode, lean on the live session history: a working DJ runs threads
  // and calls back to a track or a remark from earlier in the shift. This pairs
  // with the cross-hour memory in broadcast/session.ts, which now keeps that
  // history alive across daypart turnovers.
  const djModeLine = persona?.djMode
    ? `\n\n${instruction('picker', 'dj-mode')}`
    : '';
  // The show topic must live in the system prompt, not only in the session-
  // opening message: the session window (~40 turns) scrolls past the opener
  // within the first hour, after which the picker would lose every show
  // constraint mid-show and revert to generic picks.
  const activeShow = settings.resolveActiveShow(showAt ?? undefined);
  const showLine = activeShow?.topic
    ? `\n\n${instruction('picker', 'show-brief', { topic: activeShow.topic })}`
    : '';
  // The same mood/genre/decade/energy steer the pool picker applies — the agent
  // already owns songsByGenre + tracksByMood(energy) tools, so this line is
  // enough to make it reach for them. showMusicLean reflects the show's
  // filtersStrict here too: a strict show gets a hard "stay within" rule
  // instead of soft leans, so both pick paths honour strict the same way. Lives
  // in the system prompt for the same session-window reason as the show brief.
  const musicLean = dj.showMusicLean(activeShow);
  // Playlist anchor: a separate steer from genre/era. Strict → every pick MUST
  // come from the pinned playlist (the tools already enforce this in code, but
  // saying so keeps the agent reaching for showPlaylistTracks instead of
  // burning steps on tools that come back empty); soft → strong preference,
  // occasional steps outside allowed for flow. Gated on playlistResolved: when
  // the show pins playlists but none resolved (stale ids / Navidrome error),
  // the showPlaylistTracks tool is NOT registered — telling the model to call
  // a tool that doesn't exist burns steps and invites fabrication.
  const playlistLean = activeShow?.playlistIds?.length && playlistResolved
    ? `\n\n${instruction('picker', activeShow.playlistStrict ? 'playlist-strict' : 'playlist-soft')}`
    : '';
  // Listener favourites (#991) deliberately do NOT render here: the list
  // changes as likes land, and re-rendering it inside the system prompt broke
  // the byte-stable prefix automatic prompt caching keys on. They ride the
  // pick event turn instead (dj-agent.ts runTrackEvent favClause).
  // The "Finding candidates" paragraph teaches the harness's REAL contract, so
  // it has to follow the provider's discovery budget rather than assert a fixed
  // number. On a forced-tool provider that budget is one round, and the
  // single-round wording is load-bearing: sequential advice ("if a tool returns
  // nothing, switch tools") is unfollowable there and corners the model at the
  // forced commit. Where the budget is wider the opposite is true — telling a
  // model with three rounds that it has one wastes the exploration the wider
  // budget was for. promptDiscoverySteps() takes the MINIMUM across the legs
  // that could run, because this prompt is built before failover picks one and
  // over-promising is the more expensive way to be wrong.
  const rounds = dj.promptDiscoverySteps();
  const findingCandidates = rounds > 1
    ? instruction('picker', 'finding-candidates-multi', { rounds })
    : instruction('picker', 'finding-candidates');
  return `${settings.agentPersonaPreamble(persona)}

${instruction('picker', 'frame')}${djModeLine}${showLine}${musicLean}${playlistLean}

${dj.PICKER_CRITERIA}

${instruction('picker', 'listener-requests', { listenerText: LISTENER_TEXT_CLAUSE })}${dj.REQUESTER_NAME_CLAUSE}

${findingCandidates}${dj.effectsGuidance()}${settings.agentLanguageReminder(persona, 'the "say" link')}`;
}

// Exported for scripts/llm-bench, like requestSchema above.
export function requestSystem() {
  const persona = session.onAirPersona();
  // Follows requestSchema() above: with the station voice off there IS no
  // "intro" field, and a prompt that keeps talking about one invites the model
  // to stuff the intro into "ack" instead.
  const wantIntro = autoVoiceAllowed();
  const frame = instruction('request', 'frame', {
    ackFields: wantIntro ? 'the "ack" and "intro"' : 'the "ack"',
  });
  // The air-time clause only applies when there IS an intro to air.
  const currentTrack = wantIntro
    ? `${instruction('request', 'current-track-with-intro')}${dj.AIR_TIME_CLAUSE}`
    : instruction('request', 'current-track-no-intro');
  return `${settings.agentPersonaPreamble(persona)}

${frame}${settings.agentLanguageReminder(persona, wantIntro ? 'the "ack" and "intro" lines' : 'the "ack" line')}

${LISTENER_TEXT_CLAUSE}${dj.REQUESTER_GREETING_CLAUSE}${dj.REQUESTER_NAME_CLAUSE} ${instruction('request', 'classification')}

${currentTrack}`;
}

