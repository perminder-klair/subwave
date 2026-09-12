// The pick and request output schemas, and the system prompts that go with
// them. Read the nullability notes before changing a field.

import { z } from 'zod';
import * as settings from '../../settings.js';
import * as session from '../session.js';
import * as dj from '../../llm/dj.js';
import { modelTolerant } from '../../llm/sdk.js';
import { autoVoiceAllowed } from '../voice-policy.js';
import { SEED_NOT_A_PICK_CLAUSE } from '../../util/pick-seed.js';
import { instruction } from '../../llm/dj.js';


// Plain .nullable() fields, deliberately: malformed spellings of "nothing" are
// repaired by the modelTolerant wrapper in pickSchema() at the OBJECT level.
// Never wrap an individual field in a preprocess — a per-field pipe drops that
// field from the tool inputSchema's `required` array and invites providers to
// omit it. See modelTolerant in core/pure.ts.
export const PICK_SCHEMA = z.object({
  // The seed clause is load-bearing (#1247): a cornered model otherwise answers
  // with the on-air track's own id. One shared wording in util/pick-seed.ts.
  id: z.string().describe(`the exact song id returned by one of the discovery tools — never invent or compose ids. ${SEED_NOT_A_PICK_CLAUSE}`),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just note what makes THIS pick a fresh step (a shift in energy/era/texture, or an artist genuinely new to the rotation), not a vibe label you would recycle pick after pick (e.g. "warmer, driving energy", never a repeated "mellow reflective step"). Only call a pick a "new artist" when it has no "artist_play_count"/"artist_last_played_days_ago"; "unaired" means this song is new to the station, not that its artist is. If the artist shows recent or frequent plays, describe the real reason instead (energy shift, texture, flow)'),
  // Only honoured when the system prompt offers them (settings.effectsActive).
  // Keep this a pointer: the full coaching is dj.effectsGuidance(), and
  // repeating it here sends the effects text twice per call.
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('transition treatment per the TRANSITION EFFECTS guidance: "washout"/"loop" end THIS pick (loop needs measured tempo), "sweep"/"dissolve"/"chop" carry the previous track across a clash (chop only out of beat-driven material), "blend" only for an exceptionally locked pair; "normal" or null for a plain crossfade'),
});

// Same shape, transition coaching stripped: field descriptions reach the model
// even when every prompt mention is gated off, so the coaching above would talk
// a non-DJ persona into effects runTrackEvent then discards. The enum stays
// identical (validation must not depend on persona state); only the wording.
export const PICK_SCHEMA_NO_FX = PICK_SCHEMA.extend({
  transition: z.enum(['normal', 'blend', 'sweep', 'washout', 'dissolve', 'chop', 'loop']).nullable().describe('always set to null — transition effects are not available for this persona'),
});

// Selection deliberately contains no listener-facing speech. The selected song
// crosses into generateLink only after the editorial decision is complete.
export function pickSchemaBase() {
  return settings.effectsActive() ? PICK_SCHEMA : PICK_SCHEMA_NO_FX;
}

export function pickSchema() {
  // Repairs malformed nullable spellings at the object level on every parse
  // path; the wire schema stays identical, all fields still required.
  return modelTolerant(pickSchemaBase());
}

// Resolved per run, like pickSchema: the intro length follows the on-air
// persona's scriptLength. Exported for scripts/llm-bench; live callers stay on
// requestAgent.
export function requestSchema() {
  const base = z.object({
    // The classification is EXPLICIT and separate from `id`: an omitted `id`
    // coerces to null, which would read as the chat escape and silently play
    // nothing for a real music request. With `kind` carrying the decision, an
    // omission degrades to 'track' (objectFallbacks below) and falls through to
    // the salvage cascade, keeping "never refuse music" true.
    kind: z.enum(['track', 'chat']).describe('"track" when the listener wants music played — the normal case, and the right answer whenever you are unsure. "chat" ONLY when the message is not a music request at all (a question, a greeting, banter, a demand to change how the station behaves) — then "ack" answers them, "id" is null, and nothing is queued.'),
    // Same seed clause as PICK_SCHEMA.id: the request event line carries the
    // on-air track's `[id: …]` too.
    id: z.string().nullable().describe(`the exact song id returned by one of the discovery tools — never invent or compose ids. ${SEED_NOT_A_PICK_CLAUSE} Null ONLY when kind is "chat"`),
    ack: z.string().describe('short on-air acknowledgement of the listener, in character — max 20 words; no "thank you for listening" or self-intros'),
  });
  // `kind` is required and non-nullable, so coerceModelPayload leaves an
  // omission alone and a plain enum would throw the run away. 'track' is the
  // pre-existing safe behaviour.
  const tolerant = { objectFallbacks: { kind: 'track' } };
  // Station voice off: no spoken intro can air, so the field leaves the
  // contract rather than being written and dropped. runRequestViaAgent still
  // guards its own read, covering a switch flipped mid-run.
  if (!autoVoiceAllowed()) return modelTolerant(base, tolerant);
  return modelTolerant(base.extend({
    intro: z.string().describe(`a natural DJ intro for the track in the DJ voice; weave in what the listener asked for without reading the request back verbatim, and name the listener once if the final user line gives their name. It airs over the track's opening seconds, so write it in the present tense — never "next" or "coming up". ${dj.lengthPhrase('intro')}`),
  }), tolerant);
}

// The data-not-direction rule, shared verbatim by BOTH agent prompts that can
// see listener text: requestSystem() in the message it resolves, pickSystem()
// in the session window, which carries recent request turns for ~40 turns.
export const LISTENER_TEXT_CLAUSE = instruction('shared', 'listener-text');

// Keep this prompt minimal — persona plus editorial criteria. Tool
// descriptions, the done-tool description, schema field descriptions and the
// event message already carry the rest, and duplicating them derails smaller
// models. Effects guidance lives in prompts/picker.ts so the pool picker shares
// it verbatim, and is appended only when settings.effectsActive.
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
export function pickSystem(showAt: Date | null = null, playlistResolved = true, nativeShortlist = false) {
  const persona = session.onAirPersona();
  const djModeLine = persona?.djMode
    ? `\n\n${instruction('picker', 'dj-mode')}`
    : '';
  // The show topic must live in the system prompt, not only the session-opening
  // message: the ~40-turn window scrolls past the opener within the first hour
  // and the picker would lose every show constraint mid-show.
  const activeShow = settings.resolveActiveShow(showAt ?? undefined);
  const showLine = activeShow?.topic
    ? `\n\n${instruction('picker', 'show-brief', { topic: activeShow.topic })}`
    : '';
  // The same mood/genre/decade/energy steer the pool picker applies, including
  // the show's filtersStrict, so both pick paths honour strict the same way.
  // In the system prompt for the same session-window reason as the show brief.
  const musicLean = dj.showMusicLean(activeShow);
  // Playlist anchor, separate from genre/era. Gated on playlistResolved: when
  // no pinned playlist resolved the showPlaylistTracks tool is NOT registered,
  // and naming a tool that doesn't exist burns steps and invites fabrication.
  const playlistLean = activeShow?.playlistIds?.length && playlistResolved
    ? `\n\n${instruction('picker', activeShow.playlistStrict ? 'playlist-strict' : 'playlist-soft')}`
    : '';
  // Listener favourites (#991) deliberately do NOT render here: the list
  // changes as likes land, which breaks the byte-stable prefix prompt caching
  // keys on. They ride the pick event turn instead (runTrackEvent favClause).
  //
  // "Finding candidates" must match the provider's real discovery budget: on a
  // one-round provider, sequential advice ("if a tool returns nothing, switch
  // tools") is unfollowable and corners the model at the forced commit; on a
  // wider one, claiming a single round wastes the exploration. Takes the
  // MINIMUM across legs, since the prompt is built before failover picks one.
  const rounds = dj.promptDiscoverySteps();
  const findingCandidates = nativeShortlist
    ? 'The controller has already built a Track Shortlist under the station guards. Choose exactly one supplied id; do not request or invent candidates.'
    : rounds > 1
      ? instruction('picker', 'finding-candidates-multi', { rounds })
      : instruction('picker', 'finding-candidates');
  return `${settings.agentPersonaPreamble(persona)}

${instruction('picker', 'frame')}${djModeLine}${showLine}${musicLean}${playlistLean}

${dj.PICKER_CRITERIA}

${instruction('picker', 'listener-requests', { listenerText: LISTENER_TEXT_CLAUSE })}${dj.REQUESTER_NAME_CLAUSE}

${findingCandidates}${dj.effectsGuidance()}${settings.agentLanguageReminder(persona, 'the selection response')}`;
}

// Exported for scripts/llm-bench, like requestSchema above.
export function requestSystem() {
  const persona = session.onAirPersona();
  // Follows requestSchema(): with the station voice off there is no "intro"
  // field, and a prompt still naming one invites the model to stuff it in "ack".
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
