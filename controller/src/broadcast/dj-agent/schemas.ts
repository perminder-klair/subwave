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
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just note what makes THIS pick a fresh step (a shift in energy/era/texture, or an artist genuinely new to the rotation), not a vibe label you would recycle pick after pick (e.g. "warmer, driving energy", never a repeated "mellow reflective step"). Default to actual flow; never mention Musical Leanings here. Only call a pick a "new artist" when it has no "artist_play_count"/"artist_last_played_days_ago"; "unaired" means this song is new to the station, not that its artist is. If the artist shows recent or frequent plays, describe the real reason instead (energy shift, texture, flow)'),
  // Required rather than optional: OpenAI strict structured output requires
  // every object property to be listed as required, and an omitted diagnostic
  // told us nothing about whether the model had considered the tie-breaker.
  usedMusicalLeanings: z.boolean().describe('private diagnostic decision — always include this. Default false with leaningsTieBreak null. Set true ONLY when two or more eligible tracks already fit the flow and supplied Musical Leanings genuinely settle that close choice; compatibility alone is not enough. Leanings never override show rules, rotation, safety, or musical flow.'),
  // Keep the proof separate from `reason`: requiring an exact phrase in a
  // second free-text field made both local and cloud models silently omit the
  // diagnostic. `null` is an explicit, cheap no-use answer; a short trait is
  // auditable evidence when the model claims a real tie-break.
  leaningsTieBreak: z.string().nullable().describe('always include this. Set null when usedMusicalLeanings is false. When true, give the short specific trait of the chosen discovered candidate that directly matches the supplied Musical Leanings (for example "warm vocal and melodic hook"). Do not use generic flow facts such as energy, pace, key, or club feel as Leanings evidence.'),
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

// The picker response deliberately contains no listener-facing speech. The
// selected song crosses into generateLink only after the tool run is complete,
// so selection context cannot become DJ copy. Keep this wrapper because
// constrained re-picks extend the plain schema before tolerance is applied.
export function pickSchemaBase() {
  return settings.effectsActive() ? PICK_SCHEMA : PICK_SCHEMA_NO_FX;
}

export function pickSchema() {
  // modelTolerant repairs GLM's malformed nullable spellings ("null"-the-
  // string, an omitted key) at the object level, on every parse path (done-
  // tool args, text salvage) — the wire schema stays identical to the plain
  // object's, all fields still required. See core/pure.ts.
  return modelTolerant(pickSchemaBase());
}

export function agenticDiscoverySchema() {
  return modelTolerant(pickSchemaBase().omit({ usedMusicalLeanings: true, leaningsTieBreak: true }));
}

export type AgenticLeaningsReviewContext = {
  currentTrack?: { id?: string | null; title?: string | null; artist?: string | null; album?: string | null } | null;
  journeyActive?: boolean;
  link?: string;
  djName?: string | null;
};

export const NO_AGENTIC_LEANINGS_INFLUENCE = 'NO_LEANINGS_INFLUENCE';

export function agenticLeaningsReviewSchema(ids: string[], leaningsOptions: string[], baselineId: string) {
  const choices = [...new Set(ids)];
  if (choices.length < 2) throw new Error('cannot review an Agentic pick without multiple candidates');
  if (!choices.includes(baselineId)) throw new Error('Agentic Leanings baseline must be one of the reviewed candidates');
  if (leaningsOptions.length < 1) throw new Error('cannot review an Agentic pick without exact Leanings options');
  return modelTolerant(z.object({
    // Strings avoid the first-enum-value bias observed with llama.cpp. The
    // controller still validates both values against the supplied closed sets.
    selectedId: z.string().trim().min(1).max(160).describe(`copy the final exact id from baseline or challengers. Choose a close challenger with a supported Leanings match; otherwise use ${baselineId}. Never invent an id.`),
    leaningsBasis: z.string().trim().min(1).max(100).describe(`write ${NO_AGENTIC_LEANINGS_INFLUENCE} when selectedId is ${baselineId}. When changing selectedId, copy exactly one supplied leaningsOptions phrase that materially caused that change; never invent or paraphrase evidence.`),
    musicalReason: z.string().trim().min(16).max(180).describe('one natural, specific clause about the selected track, beginning with "its" or "it". Describe sound, texture, melody, rhythm, production or songwriting like a music lover, not a metadata report. Do not name the DJ, artist, title, preferences, Leanings, baseline, challenger, preliminary choice, current flow, queue position, BPM, key, energy level or mood tag; the controller adds verified identity and evidence.'),
    transition: pickSchemaBase().shape.transition,
  }), { objectFallbacks: { leaningsBasis: NO_AGENTIC_LEANINGS_INFLUENCE, musicalReason: '[musical reason unavailable]' } });
}

export function agenticLeaningsReviewSystem(): string {
  return 'You are performing one private music-editor review. The controller has already selected an eligible baseline without Musical Leanings. First look for a supplied challenger that is a verified close ordinary-flow choice and has a controller-supported Leanings match; that is a genuine tie-break and should replace the baseline. Use a possible-flow match only when its musical fit is convincingly comparable. Keep the baseline when no such challenger exists. Never invent tracks, preference evidence or facts beyond the supplied data.';
}

export function agenticLeaningsReviewPrompt({
  baseline,
  challengers,
  leaningsOptions,
  context = {},
}: {
  baseline: Record<string, unknown>;
  challengers: Array<Record<string, unknown>>;
  leaningsOptions: string[];
  context?: AgenticLeaningsReviewContext;
}): string {
  return JSON.stringify({
    context,
    baseline,
    challengers,
    leaningsOptions,
  }, null, 2)
    + '\n\nUse this decision order: (1) scan every challenger for flowCloseness="close" plus a non-empty leaningsMatches; if present, choose the strongest such challenger and copy its matching phrase into leaningsBasis. (2) Otherwise consider a flowCloseness="possible" match only when its musical continuation is genuinely comparable. (3) Only when neither exists, keep the baseline and write leaningsBasis=NO_LEANINGS_INFLUENCE. Do not independently rerank tracks that have no supported match.'
    + '\n\nflowCloseness is a Leanings-blind controller comparison using energy, mood, tempo, key and genre. A candidate’s leaningsMatches contains exact active-profile phrases supported by its genre/mood tags. The controller independently verifies both fields, so copy ids and phrases exactly.'
    + '\n\nAlways write musicalReason for selectedId as one natural, specific musical clause of roughly 12–28 words, beginning with "its" or "it". Write like a music lover: describe an audible texture, melody, rhythm, production choice or songwriting quality. Do not repeat the DJ, artist or title. Do not mention preferences, Leanings, baseline, challenger, preliminary choice, current flow, queue position, BPM, key, energy levels or mood tags. Avoid stock evaluator wording such as "complements the current flow". The controller adds the verified names and exact evidence. Set transition for selectedId.';
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
export type GuestMusicalNudge = {
  guest: { id: string; name: string };
  musicalLeanings: string;
};

export type EditorialLeaningsContext = {
  host: string | null;
  guest: GuestMusicalNudge | null;
  promptValue: string | null;
};

// Keep variable editorial preference at the end of the system prompt. Guest
// nudges are sampled per pick; placing them before the shared picker guidance
// would unnecessarily shorten the reusable cloud prompt-cache prefix.
export function pickerMusicLeanings(
  host: string | null,
  guest: GuestMusicalNudge | null,
): string {
  const hostLine = host
    ? `\n\nMusical Leanings — ${host}\nTreat this as a soft editorial preference when choosing between eligible tracks that fit the current flow. It may guide an otherwise sound selection, and may be reflected naturally in the private selection reason when it materially matters. It never overrides show rules, rotation, safety, or the musical flow.`
    : '';
  const guestLine = guest
    ? `\n\nGuest Musical Leanings — ${guest.guest.name}: ${guest.musicalLeanings}\nThis is weaker than the host's Musical Leanings. It may guide an otherwise sound selection when it naturally fits the flow; never override show rules, rotation, safety, or the musical flow.`
    : '';
  return hostLine + guestLine;
}

export function resolveEditorialLeanings(showAt: Date | null = null): EditorialLeaningsContext {
  const persona = session.onAirPersona();
  const host = settings.personaMusicLeanings(persona);
  const guest = settings.guestEditorialNudge(showAt ?? new Date());
  const lines = [host ? `Host: ${host}` : '', guest ? `Guest (${guest.guest.name}, secondary): ${guest.musicalLeanings}` : ''].filter(Boolean);
  return { host, guest, promptValue: lines.join('\n') || null };
}

export function resolvedMusicalLeaningsFlag(context: EditorialLeaningsContext | null, modelFlag: unknown, tieBreak: unknown): boolean {
  // A badge is evidence of a specific claimed tie-break, not an inference from
  // generic flow prose. This rejects routine true values from small models that
  // simply see a compatible taste cue in every pick.
  return !!context?.promptValue && modelFlag === true && typeof tieBreak === 'string' && tieBreak.trim().length > 2;
}

const LEANINGS_REASON_REFERENCE = /\b(?:musical\s+leanings?|broad\s+alternative\s+taste|(?:dj|host)(?:'s)?\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?)|(?:my|his|her|their)\s+(?:musical\s+)?(?:taste|tastes|preference|preferences)|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}['’]s\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?))\b/i;

// The Agentic reason becomes queue metadata and the next session turn. Match
// the Shortlist final-boundary safeguard: a model that mentions Leanings but
// did not explicitly claim the diagnostic cannot pass that assertion forward
// as ordinary selection context.
export function agentReasonForLeanings(reason: unknown, usedMusicalLeanings: boolean, tieBreak: unknown = null): string {
  const compact = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (usedMusicalLeanings) {
    const evidence = typeof tieBreak === 'string' ? tieBreak.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    return evidence ? `Leanings: ${evidence}` : 'flow fit after the current track';
  }
  if (!LEANINGS_REASON_REFERENCE.test(compact)) return compact;
  return 'flow fit after the current track';
}

// The system prompt holds the complete editorial policy, while this compact
// reminder rides the newest pick event so a long Agentic session cannot bury
// the tie-breaker beneath its own earlier selections. It receives the one
// snapshot resolved for the logical selection; never resolve a guest again.
export function musicalLeaningsPickReminder(context: EditorialLeaningsContext): string {
  if (!context.promptValue) return '';
  return ' Musical Leanings are supplied for this pick as a soft tie-breaker. Always return both diagnostic fields: default "usedMusicalLeanings" to false and "leaningsTieBreak" to null. Set true and give a short leaningsTieBreak trait ONLY when two or more eligible tracks already fit the flow and Leanings genuinely settle that close choice—not merely because this track is compatible. The trait must describe the chosen discovered track AND directly match the supplied Musical Leanings; generic flow facts such as energy, pace, key, or club feel are not Leanings evidence. Otherwise use false and null. They may affect the choice, never listener-facing output, and never override show rules, rotation, safety, or musical flow.';
}

export function pickSystem(showAt: Date | null = null, playlistResolved = true, editorialLeanings: EditorialLeaningsContext | null = null, candidateSelection = false) {
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
  // Persona Musical Leanings are deliberately separate from the DJ's Soul:
  // this is a private soft tie-breaker for music choice, not a voice or
  // discovery instruction. Keep it in the agentic picker too, so changing
  // picker implementation does not change the station's musical identity.
  const leanings = editorialLeanings ?? resolveEditorialLeanings(showAt);
  const editorialLeaningsPrompt = candidateSelection ? '' : pickerMusicLeanings(leanings.host, leanings.guest);
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
  const findingCandidates = candidateSelection
    ? 'The controller has supplied a preliminary choice and eligible alternatives. Review only those tracks; do not request or invent candidates.'
    : rounds > 1
    ? instruction('picker', 'finding-candidates-multi', { rounds })
    : instruction('picker', 'finding-candidates');
  return `${settings.agentPersonaPreamble(persona)}

${instruction('picker', 'frame')}${djModeLine}${showLine}${musicLean}${playlistLean}

${dj.PICKER_CRITERIA}

${instruction('picker', 'listener-requests', { listenerText: LISTENER_TEXT_CLAUSE })}${dj.REQUESTER_NAME_CLAUSE}

${findingCandidates}${dj.effectsGuidance()}${editorialLeaningsPrompt}`;
}

// Exported for scripts/llm-bench, like requestSchema above.
export function requestSystem(persona = session.onAirPersona()) {
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
