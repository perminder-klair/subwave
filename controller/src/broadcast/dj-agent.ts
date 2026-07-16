// Session DJ agent — the conversational brain that runs over a stream session.
//
// The system posts events into the session ("a track started, pick the next
// one"; "a listener requested X"); this module hands the session chat window
// to a tool-loop agent that explores the library and decides. Its output (the
// chosen track, an optional spoken link/intro) is enqueued and appended back
// to the session as turns, so the next event sees what the DJ just did.
//
// The conversational path is gated on `settings.llm.pickerAgent`. When it is
// off — or when the agent fails for any reason — this falls back to the
// stateless pool picker (music/picker.js) and the stateless link generator
// (llm/dj.js), so a pick is never missed. Either way the session is updated.

import { z } from 'zod';
import * as settings from '../settings.js';
import * as session from './session.js';
import * as picker from '../music/picker.js';
import { resolveShowPlaylistPool, resolveExcludedPlaylistIds } from '../music/show-playlist.js';
import * as library from '../music/library.js';
import * as subsonic from '../music/subsonic.js';
import * as mix from '../music/mix.js';
import * as journey from '../music/journey.js';
import { shuffle } from '../util/shuffle.js';
import * as dj from '../llm/dj.js';
import { energyForDaypart } from '../context.js';
import { defineAgent } from '../llm/agent.js';
import { djObject, nearestId, modelTolerant, stripThinking } from '../llm/sdk.js';
import { buildPickerTools } from '../llm/tools.js';
import { recordPick } from '../llm/log.js';
import * as budget from './dj-budget.js';
import { speechPaceScale } from '../audio/tts.js';
import { normalizeForSpeech } from '../audio/speech-text.js';
import { withTrace, logEvent } from '../observability/events.js';
import { recencyWindowsForLibrary, effectiveNoRepeatWindow } from '../music/recency.js';
import { hasEraBound } from '../music/show-filter.js';
import { djCallsAllowed } from './listeners.js';

// --- Feature 4: DJ-mode mini-runs ------------------------------------------
// A short, deliberate tempo/key journey across 2-3 consecutive picks. While a
// run is active the pool re-rank is anchored to the run target (not just the
// current track), and the link patter acknowledges the run. State is module-
// level — one station, one run at a time. Cleared when it runs out or when the
// active persona isn't in DJ mode.
//
// Phase 2 overlay — a SONIC JOURNEY. When the audio (CLAP) index is populated,
// a run can also carry a sequence of waypoint vectors through the audio space
// toward a destination vibe; each pick consumes one waypoint, handed to the
// picker as the audio-KNN anchor so the pool drifts toward the destination
// while the tempo/key re-rank still applies. `waypoints`/`step` are absent on a
// plain tempo/key run (no audio index, or the journey couldn't be built), in
// which case the run behaves exactly as it did before.
interface RunState {
  bpm: number | null;
  key: string | null;
  remaining: number;
  waypoints?: number[][];
  step?: number;
}
let runState: RunState | null = null;

// What advanceRun hands back per pick: the tempo/key re-rank target (feature 4)
// and, when a sonic journey is active, the current waypoint vector for the
// picker's audio anchor. Either may be null independently.
interface RunStep {
  rankTarget: { bpm: number | null; key: string | null } | null;
  audioWaypoint: number[] | null;
}

// How many candidate tracks to average for a destination-vibe centroid. Capped
// so a big energy bucket doesn't turn the centroid into one getAudioVector read
// per track in the library on every run start.
const JOURNEY_DEST_SAMPLE = 60;

// Consume the next waypoint from a run (clamped to the last one), advancing the
// step cursor. null when the run carries no journey.
function takeWaypoint(rs: RunState): number[] | null {
  if (!rs.waypoints || rs.waypoints.length === 0) return null;
  const idx = Math.min(rs.step ?? 0, rs.waypoints.length - 1);
  rs.step = idx + 1;
  return rs.waypoints[idx];
}

// Try to overlay a sonic journey on a freshly-started run. Destination is a
// daypart-appropriate energy bucket's centroid (brisker daypart → toward the
// high-energy sound, mellower → toward the low-energy sound), so the run drifts
// in the same direction the tempo/key target already nudges. No-op (leaves the
// run a plain tempo/key run) when the current track or the destination has no
// audio coverage. `totalSteps` is the number of picks the run will influence.
function maybeAttachJourney(rs: RunState, current: any, totalSteps: number): void {
  const startId = current?.id;
  if (!startId) return;
  try {
    const destEnergy = energyForDaypart().speed >= 1 ? 'high' : 'low';
    const destIds = shuffle(library.songsByEnergy(destEnergy).map((s: any) => s.id))
      .slice(0, JOURNEY_DEST_SAMPLE);
    if (destIds.length === 0) return;
    const j = journey.buildJourney({ startId, endIds: destIds, steps: totalSteps });
    if (!j) return;
    rs.waypoints = j.waypoints;
    rs.step = 0;
  } catch {
    // Journey is a best-effort enhancement — never let it break a pick.
  }
}

// Resolve {bpm, key} for a track via the library DB (queued/agent picks carry
// only id/title/artist). library.bpmKeyFor prefers the analyzer's numbers and
// treats Navidrome's ID3-derived `bpm: 0` as unknown (#862).
function analysisOf(track: any): { bpm: number | null; key: string | null } {
  return library.bpmKeyFor(track);
}

// Resolve a track's measured intro runway (ms), for the talk-within-the-intro
// budget enforcement.
function introMsOf(track: any): number | null {
  if (track?.introMs != null) return track.introMs;
  const rec = track?.id ? library.get(track.id) : null;
  return rec?.introMs ?? null;
}

// Probability of STARTING a run on a given pick, by chattiness. Quiet personas
// never start one; a run is a presence behaviour like the rest of DJ mode.
function runStartProbability(): number {
  const f = settings.effectiveFrequency();
  if (f === 'aggressive') return 0.5;
  if (f === 'chatty') return 0.4;
  if (f === 'moderate') return 0.3;
  return 0;
}

// Advance the mini-run state for this pick and return the re-rank target +
// (optional) sonic-journey waypoint to use. rankTarget null means "anchor the
// tempo/key re-rank to the current track as usual"; audioWaypoint null means
// "no journey — the audio source anchors to the current track". Only does
// anything in DJ mode with an analysed current track.
const NO_RUN: RunStep = { rankTarget: null, audioWaypoint: null };

function advanceRun(djMode: boolean, current: any): RunStep {
  if (!djMode) { runState = null; return NO_RUN; }
  if (runState && runState.remaining > 0) {
    runState.remaining--;
    const waypoint = takeWaypoint(runState);
    if (runState.remaining <= 0) {
      const rankTarget = { bpm: runState.bpm, key: runState.key };
      runState = null;
      return { rankTarget, audioWaypoint: waypoint };
    }
    return { rankTarget: { bpm: runState.bpm, key: runState.key }, audioWaypoint: waypoint };
  }
  // No active run — maybe start one off the current track.
  const cur = analysisOf(current);
  if ((cur.bpm == null && cur.key == null) || Math.random() >= runStartProbability()) return NO_RUN;
  const target = mix.pickRunTarget(cur, energyForDaypart());
  if (!target) return NO_RUN;
  const extra = 1 + Math.floor(Math.random() * 2); // 1-2 more picks after this
  runState = { bpm: target.bpm, key: target.key, remaining: extra };
  // Overlay a sonic journey if the audio index can support one (this pick + the
  // `extra` that follow → extra + 1 total waypoints). No-op otherwise.
  maybeAttachJourney(runState, current, extra + 1);
  return { rankTarget: target, audioWaypoint: takeWaypoint(runState) };
}

export function runActive(): boolean {
  return !!(runState && runState.remaining > 0);
}

// Plain .nullable() fields, deliberately — GLM's malformed spellings of
// "nothing" (the string "null", an omitted key, a double-JSON-encoded object)
// are repaired by the modelTolerant wrapper in pickSchema() below, at the
// OBJECT level. Do not wrap individual fields in a preprocess: a per-field
// pipe drops that field from the tool inputSchema's `required` array (the AI
// SDK renders Zod with io:'input'), which invites every provider to omit it —
// see modelTolerant's comment in core/pure.ts.
export const PICK_SCHEMA = z.object({
  id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just note what makes THIS pick a fresh step (new artist, a shift in energy/era/texture), not a vibe label you would recycle pick after pick (e.g. "new artist, lifts the energy", never a repeated "mellow reflective step")'),
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
function pickSchemaBase() {
  const base = settings.effectsActive() ? PICK_SCHEMA : PICK_SCHEMA_NO_FX;
  return base.extend({
    say: z.string().nullable().describe(`when the latest event message says to write a spoken link, set this to ${dj.lengthPhrase('link')} of natural speech in the DJ voice that INTRODUCE the track you are about to play — set it up, name the artist or capture its feel, vary your opener. Do NOT back-announce, recap, or name the track that just played (a listener request may slip in ahead of your pick, so what aired right before it is not certain). Never state a clock time unless the event message tells you when the link airs — then use exactly that time. When the event says stay silent, set this to null`),
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
  return z.object({
    id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
    ack: z.string().describe('short on-air acknowledgement of the listener, in character — max 20 words; no "thank you for listening" or self-intros'),
    intro: z.string().describe(`a natural DJ intro for the track in the DJ voice; weave in what the listener asked for without reading the request back verbatim. ${dj.lengthPhrase('intro')}`),
  });
}

// Ultra-minimal — persona + editorial criteria, nothing else. The AI SDK
// already conveys everything else through its own channels: tool descriptions
// (llm/tools.js), the done-tool description (llm/sdk.js), schema field
// descriptions (PICK_SCHEMA above), and the per-pick event message in the
// session window ("Stay silent — no link this time." vs "Also write a short
// link to speak over this track now."). Duplicating those in prompt text
// competes with the framework's structural signals and derails smaller
// models. PICKER_CRITERIA stays because it's editorial preference (flow,
// context, variety, interest) — that's not in any tool or schema.
// The transition-effects guidance (PICK_SCHEMA.transition) now lives in
// llm/internal/prompts/picker.ts (dj.effectsGuidance) so the pool picker
// shares it verbatim — it's appended to the picker system prompt ONLY when
// effects are active (the on-air persona's djMode — see
// settings.effectsActive; there is no separate toggle). Invisible otherwise,
// so the model leaves "transition" null.

// `showAt` — resolve the show brief/leans for that future moment instead of
// now: the pick airs when the current track ends, so near a show boundary the
// INCOMING show's rules are the ones to follow (see the look-ahead in
// queue.onTrackStarted). The persona stays the live one — the outgoing DJ
// tees the changeover up in their own voice; the on-air mic-pass is
// runPersonaHandoff's job.
export function pickSystem(showAt: Date | null = null, playlistResolved = true) {
  const persona = settings.getEffectivePersona();
  // In DJ mode, lean on the live session history: a working DJ runs threads
  // and calls back to a track or a remark from earlier in the shift. This pairs
  // with the cross-hour memory in broadcast/session.ts, which now keeps that
  // history alive across daypart turnovers.
  const djModeLine = persona?.djMode
    ? `\n\nYou're in full DJ mode — keep the thread alive across tracks: call back to something you played or said earlier in this session when it fits, and build a little momentum rather than treating each pick as isolated.`
    : '';
  // The show topic must live in the system prompt, not only in the session-
  // opening message: the session window (~40 turns) scrolls past the opener
  // within the first hour, after which the picker would lose every show
  // constraint mid-show and revert to generic picks.
  const activeShow = settings.resolveActiveShow(showAt ?? undefined);
  const showLine = activeShow?.topic
    ? `\n\nCurrent show brief — follow this for every pick:\n${activeShow.topic}`
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
    ? (activeShow.playlistStrict
        ? `\n\nThis show is anchored to a curated playlist: every track you pick MUST come from it. Call showPlaylistTracks first and choose from what it returns.`
        : `\n\nThis show leans on a curated playlist: call showPlaylistTracks first and strongly prefer those tracks; only step outside occasionally when the flow calls for it.`)
    : '';
  return `${settings.agentPersonaPreamble(persona)}

You run the station as one continuous shift. The messages above are the live session.${djModeLine}${showLine}${musicLean}${playlistLean}

${dj.PICKER_CRITERIA}

Finding candidates: prefer tools backed by the local library — searchLibrary, songsByGenre, tracksByMood, tracksByEnergy, randomSongs, and the audio/embedding similarity tools. similarSongs and topSongsByArtist use external data and often return little, so try them second. If a tool returns nothing, switch tools rather than retrying. If a tool returns only a few tracks (fewer than ~4), make one more discovery call with a different tool before choosing, so you pick from a real range rather than whatever the first call happened to surface.${dj.effectsGuidance()}${settings.agentLanguageReminder(persona, 'the "say" link')}`;
}

// Exported for scripts/llm-bench, like requestSchema above.
export function requestSystem() {
  const persona = settings.getEffectivePersona();
  return `${settings.agentPersonaPreamble(persona)}

The messages above are the live session. The final user line names the ONE listener request you are resolving now — any earlier request lines are already handled by someone else; ignore them. If the exact ask isn't in the library, pick the closest thing your tools actually returned and own the substitution in the "ack" and "intro" — never pretend it's what they asked for.${settings.agentLanguageReminder(persona, 'the "ack" and "intro" lines')}`;
}

// --- Agent circuit breaker ---------------------------------------------------
// A model that can't drive the done-tool harness — ignores toolChoice and
// burns its whole output budget thinking instead of emitting the tool call
// (minimax-m2.7:cloud is the canonical case) — fails EVERY agent run, and
// each failure costs the full agent deadline before the stateless fallback
// takes over. Rather than paying that stall on every track, consecutive agent
// failures open the breaker: picks and request matching go straight to their
// stateless fallbacks for a cooldown, then the agent gets another try. Any
// agent success closes it. Module-level — one station, one model config at a
// time; the trip is logged to the DJ log + events so the operator can see
// WHY the session-aware picker went quiet and switch model.
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
let breakerFails = 0;
let breakerOpenUntil = 0;

function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

function breakerSuccess() {
  breakerFails = 0;
}

function breakerFailure(queue: any) {
  breakerFails++;
  if (breakerFails < BREAKER_FAILURES) return;
  breakerFails = 0;
  breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  queue.log('picker', `agent picks failed ${BREAKER_FAILURES}× in a row — using the stateless fallbacks for ${Math.round(BREAKER_COOLDOWN_MS / 60_000)} min (the configured model may not handle tool calls; see /admin/debug and consider switching model)`);
  logEvent('pick.breaker', { failures: BREAKER_FAILURES, cooldownMs: BREAKER_COOLDOWN_MS });
}

// Named agents — the picker and request-handler specs in one declarable block
// each. `buildSystem` and `buildTools` resolve persona / per-call filters at
// run time; everything else (schema, step cap, hard timeout, log kind) is
// fixed here so the spec lives in one place. picker-test.mjs reads
// `pickerAgent.maxSteps` / `pickerAgent.timeoutMs` so test runs match prod
// without drifting. The hard timeout is what fails fast into the stateless
// fallback below instead of dragging on a pathological model call — enforced
// by runDeadlined's shared deadline in agent.ts (native run, main run, and
// both recovery attempts all draw down the SAME overall budget, so worst
// case per agent call is this value, not a multiple of it). It comes from
// settings.llm.agentTimeoutMs (default 45s, admin-tunable) — slow
// reasoning-heavy cloud models routinely need 20-40s per pick, and a pick has
// a whole track length of slack; the deadline exists to contain the unbounded
// 60s+ stalls (#352), not to demand snappy answers.
function agentDeadline(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}

export const pickerAgent = defineAgent({
  kind: 'djAgentPick',
  // Resolved per run: the effects coaching in the transition field follows
  // the on-air persona's djMode, and the say length its scriptLength — same
  // reason effectsGuidance() is dynamic. See pickSchema above.
  schema: () => pickSchema(),
  // The done-tool path is meant to end the loop at step 1 (COMMIT_AFTER_STEPS
  // in agent.ts): step 0 discovers, step 1 commits. That held for every
  // provider UNTIL GLM (Zhipu/Z.ai) — it can decline the forced `done` call
  // repeatedly within the SAME conversation rather than complying on the first
  // attempt, so a taller maxSteps stopped being a rarely-hit backstop and
  // became a real (and wasted) retry budget: each extra step just grows an
  // increasingly "I already declined" trail, which made compliance WORSE, not
  // better, in testing. 2 keeps the main run to exactly discovery + one
  // committed attempt and hands off to agent.ts's own two-tier recovery (which
  // includes a clean-context retry) sooner — recovery is the mechanism that
  // actually rescues these, not more steps on a polluted trail.
  maxSteps: 2,
  timeoutMs: agentDeadline,
  buildSystem: ({ showAt, playlistTracks }: any = {}) => pickSystem(showAt ?? null, !!playlistTracks?.length),
  buildTools: ({ recentIds, recentKeys, hardRecentIds, hardRecentKeys, audioWaypoint, genreLock, eraLock, moodLock, energyLock, playlistLock, playlistTracks, excludedIds }) => {
    // For a strict show (filtersStrict) EVERY set music filter — genre, era,
    // mood, energy — becomes a hard lock the discovery tools enforce on
    // candidates, not just the prompt. The locks are ALL pre-resolved in
    // pickViaAgent and threaded through run() (async work — genre free text →
    // library tags, library-coverage gating — that this sync builder can't do),
    // alongside playlistLock / playlistTracks / excludedIds. Resolving them in
    // one place off one show snapshot also keeps the prompt's brief and the
    // tools' locks agreeing across a show boundary. Track length is an on-air
    // cut, NOT a pick filter (#447), so no length cap is passed here.
    const { tools, seen } = buildPickerTools({ recentIds, recentKeys, hardRecentIds, hardRecentKeys, audioWaypoint, genreLock, eraLock, moodLock, energyLock, playlistLock, playlistTracks, excludedIds });
    return { tools, extras: { seen } };
  },
  // Native-path acceptance: the picked id must be one a discovery tool actually
  // surfaced this run. A fabricated id falls the run through to the done-tool
  // harness instead of surfacing as an unknown-id rejection (observed:
  // gpt-5-mini invented 7/32 ids after an empty tool result).
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});

export const requestAgent = defineAgent({
  kind: 'djAgentRequest',
  // Function form — resolved per run so the intro length follows the on-air
  // persona's scriptLength (see requestSchema).
  schema: () => requestSchema(),
  // See pickerAgent.maxSteps above — same reasoning.
  maxSteps: 2,
  timeoutMs: agentDeadline,
  buildSystem: () => requestSystem(),
  // resolveReferences adds the web-backed reference resolver (request path only;
  // no-op without a search provider) when the operator opts in via
  // settings.llm.requestWebResolve. (Artists are no longer filtered on any pick
  // path — see the buildPickerTools note — so a request for a recently-played
  // artist resolves naturally.)
  buildTools: ({ recentIds }) => {
    const { tools, seen } = buildPickerTools({
      recentIds,
      resolveReferences: settings.get().llm?.requestWebResolve ?? false,
    });
    return { tools, extras: { seen } };
  },
  // Same native-path acceptance as pickerAgent — the request agent runs the
  // same model through the same harness, so it fabricates the same way.
  validateObject: (object, extras) => !!(object?.id && extras?.seen?.has(object.id)),
});

function trackFields(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    year: song.year,
    // All genre tags, comma-joined — the slim projection already carries the
    // joined string in `genre` (songGenres passes it through unchanged), raw
    // Subsonic children get their multi-value array flattened here.
    genre: subsonic.songGenres(song).join(', ') || null,
    // Seconds. The queue needs it to spot picks that will hit the
    // max-track-length cap (its liq_cue_out) so it can auto-arm a washout on
    // the forced mid-song exit — see applyMixTransition. Field name varies by
    // source: Subsonic `duration`, the picker tools' slim projection (what the
    // agent's `seen` map stores) `duration_sec`, library rows `durationSec`.
    duration: song.duration ?? song.duration_sec ?? song.durationSec ?? null,
    // ReplayGain rides raw Subsonic songs (pool picks) but not the slim
    // projection agent picks resolve from — stays undefined there, which
    // tells queue.applyLoudnessGain to recover it with a getSong lookup.
    replayGain: song.replayGain,
  };
}

// Talk-within-the-intro budget (#962), applied to a between-track link in DJ
// mode: trim to the pick's measured intro runway so the DJ lands before the
// vocals — sentence/clause-complete or dropped (null), never a fragment.
// Enforced on the SPOKEN form of the line: tts.speak() later runs
// normalizeForSpeech(stripThinking(...)), which can EXPAND display symbols
// into extra words ("$5 million" → "5 million dollars"), so counting the raw
// text under-budgets the line that actually airs. The normalized text is what
// gets aired/queued — speak()'s own normalize pass is a no-op on it.
// speechPaceScale('link') maps the word ceiling to the rate the line will be
// spoken at (engine × persona × daypart). Returns the text unchanged when not
// in DJ mode; enforceIntroBudget itself no-ops on an un-analysed pick.
function trimLinkToIntro(text: string | null | undefined, song: any): string | null {
  const raw = (text || '').trim();
  if (!raw) return null;
  if (!settings.getEffectivePersona()?.djMode) return raw;
  // Same corrections as speak() so the word count matches the aired text.
  const spoken = normalizeForSpeech(stripThinking(raw), settings.get().tts?.corrections);
  return dj.enforceIntroBudget(spoken, introMsOf(song), speechPaceScale('link')) || null;
}

// `link`, when present, is the between-track line to speak as this pick starts
// playing. It's attached to the queued item so the queue airs it at the
// transition INTO this track (queue.airIntro), not over whatever is currently
// on-air when the pick is made — which is one track earlier (issue #189).
// Returns the queue position, or -1 when push()'s dedup guard dropped the pick
// because that track is already queued/on-air. On a drop we skip the ai-pick log
// AND the durable picks-log record so neither reports a phantom pick that never
// aired (push() has already logged the dedup-skip). Callers fall back on -1
// (agent → pool → auto.m3u) instead of recording a session turn for a no-op.
// `linkPrev` is the track the link back-announces (the one on-air when the pick
// was made); the queue uses it to drop the link if a request jumps ahead and it
// would otherwise air a stale "that was X" over the wrong transition.
async function enqueuePick(
  queue, song, reason, source,
  link: string | null = null,
  linkPrev: any = null,
  { sweep = false, washout = false, blend = false, dissolve = false, chop = false, loop = false }: { sweep?: boolean; washout?: boolean; blend?: boolean; dissolve?: boolean; chop?: boolean; loop?: boolean } = {},
): Promise<number> {
  // Single chokepoint for the intro budget: every pick path (agent, pool, any
  // future producer) funnels its link through here, so enforcement can't be
  // skipped by a new caller. Idempotent — callers that already trimmed (the
  // agent path does, to record the aired text in its session turn) pass
  // through unchanged.
  const introLink = trimLinkToIntro(link, song);
  const track: any = trackFields(song);
  // Flag the transition effects on this pick (DJ mode only). getAnnotatedUri
  // stamps liq_sweep / liq_washout / liq_dissolve / liq_chop; radio.liq ramps
  // them. sweep muffles the crossfade INTO this pick; dissolve melts the
  // PREVIOUS track into ambience under this pick; chop cuts the PREVIOUS
  // track out on the beat under this pick; washout rings this track out into
  // an echo tail as it ENDS.
  if (sweep) track.sweep = true;
  if (washout) track.washout = true;
  if (blend) track.blend = true;
  if (dissolve) track.dissolve = true;
  if (chop) track.chop = true;
  if (loop) track.loop = true;
  const pos = await queue.push({
    track,
    requestedBy: null,
    intent: reason || 'ai pick',
    introScript: introLink,
    introKind: 'link',
    aiPicked: true,
    linkPrev,
  });
  if (pos === -2) {
    // Never-play blocklist refused the pick — library-db-sourced candidates
    // can slip past the subsonic filter. Same "didn't queue" signal as dedup;
    // the caller's normal no-pick handling covers it.
    queue.log('ai-pick', `${song.title} — ${song.artist} refused (never-play blocklist)`, { reason, source });
    return -1;
  }
  if (pos === -1) return -1;
  queue.log('ai-pick', `${song.title} — ${song.artist}`, { reason, source });
  recordPick({ song, reason, source });
  return pos;
}

// ---------------------------------------------------------------------------
// Track event — a track started; pick the next one and maybe air a link.
// ---------------------------------------------------------------------------

// Stage-2 salvage for an agent run whose final id no tool surfaced (see the
// cascade in pickViaAgent): one djObject call over the run's OWN accumulated
// candidates (`seen`), with the id constrained to that exact set — z.enum
// becomes a decode-time grammar on local models and a Zod reject elsewhere,
// the same closing move pickNextTrack already uses. Returns a full pick object
// (id/reason/say/transition) or null; never throws, so a salvage failure falls
// through to the caller's pick.rejected path unchanged.
async function repickFromSeen({ seen, badId, wantLink, showAt = null, playlistResolved = true }: { seen: Map<string, any>; badId: string | null; wantLink: boolean; showAt?: Date | null; playlistResolved?: boolean }) {
  const ids = [...seen.keys()];
  if (ids.length === 0) return null;
  const schema = modelTolerant(pickSchemaBase().extend({
    id: z.enum(ids as [string, ...string[]]).describe('the exact id of one candidate'),
  }));
  try {
    return await djObject({
      // Same show snapshot as the failed run (showAt) and the same playlist-
      // resolved gate — a tool-less salvage call must NOT reinstate "call
      // showPlaylistTracks first / every pick MUST come from the playlist" when
      // the anchor never resolved (no such tool exists here) or resolve a
      // different show than the run whose candidates we're re-picking from.
      system: pickSystem(showAt, playlistResolved),
      prompt: JSON.stringify({ candidates: [...seen.values()] }, null, 2)
        + `\n\nYou explored the library and then answered with ${badId ? `the id "${badId}", which matches none of the tracks your tools returned` : 'no usable track id'}. Only ids from the candidates above are real. Choose the best next track from them.`
        + (wantLink
            ? ' Write the "say" link for the track you choose, following the same rules.'
            : ' Set "say" to null.'),
      schema,
      temperature: 0.5,
      kind: 'djAgentRepick',
    });
  } catch {
    return null;
  }
}

async function pickViaAgent(queue, { wantLink, audioWaypoint = null, current = null, showAt = null }: { wantLink: boolean; audioWaypoint?: number[] | null; current?: any; showAt?: Date | null }): Promise<boolean> {
  await library.load();
  const stats = library.stats();
  const windows = recencyWindowsForLibrary(stats.distinctArtists);
  // Scale the track-recency window to the tagged library's artist diversity:
  // dense catalogues keep the long anti-repeat guard, while small-artist
  // libraries don't exclude every real candidate before the picker sees it.
  // Artist-recency is intentionally NOT applied at the agent-tool layer — see
  // the buildPickerTools note (the similarity tools cluster on the just-played
  // artist, so an artist strip starved them).
  const { ids: recentIds, keys: recentKeys } = queue.recentlyPlayed(windows.trackHours);
  // Queued-but-not-yet-aired ids belong in the RELAXABLE set — they're not
  // "recently played", just in-flight, and shouldn't tighten the hard guard.
  for (const id of queue.queuedIds()) recentIds.add(id);

  // Count-based HARD no-repeat guard: the last N distinct plays can't re-air,
  // and (unlike recentIds/recentKeys above) this survives the tool-level
  // starvation cascade. Clamped to library size so a small catalogue never
  // fully blocks; 0 = off, leaving the relaxable window in sole charge.
  const effN = effectiveNoRepeatWindow(settings.get().llm?.noRepeatWindow ?? 0, stats.total);
  const { ids: hardRecentIds, keys: hardRecentKeys } = queue.recentlyPlayedByCount(effN);

  // Show playlist anchor: resolve the union here (async Navidrome fetch) and
  // thread it into the agent's tools. Strict → a hard lock set so every tool's
  // results are intersected with the playlist (the agent can only pick in-set);
  // soft → just the tracks, exposed via showPlaylistTracks for a strong prompt
  // preference, no lock. Null when the show pins no playlists. Resolved at the
  // pick's look-ahead moment (showAt) so the anchored playlist is the show's
  // that will be on air when the pick plays — same clock as pickSystem's brief
  // and buildTools' locks.
  const activeShow = settings.resolveActiveShow(showAt ?? undefined);
  const playlistPool = activeShow ? await resolveShowPlaylistPool(activeShow) : null;
  const playlistLock = playlistPool && activeShow?.playlistStrict ? playlistPool.ids : null;
  const playlistTracks = playlistPool?.tracks ?? null;
  const excludedIds = activeShow ? await resolveExcludedPlaylistIds(activeShow) : null;

  // Strict music locks for the discovery tools (filtersStrict). Resolved HERE,
  // once, off the same show snapshot as the playlist pool — the async work the
  // sync buildTools can't do — then threaded through run() alongside the
  // playlist artifacts so prompt-brief and tool-locks agree across a boundary.
  // Each lock is an any-of list (#929); the locks AND across attributes.
  const strict = !!activeShow?.filtersStrict;
  // Genre: resolve free text → the library's exact tags, dropping any that
  // don't resolve (a misspelled / library-absent genre → no genre lock, not a
  // starved-to-empty tool). This mirrors the pool path (music/picker.ts) so the
  // two paths agree; the removed per-tool never-starve used to mask this.
  let genreLock: string[] | null = null;
  if (strict && activeShow?.genres?.length) {
    const resolved: string[] = [];
    for (const g of activeShow.genres) {
      try { const r = await subsonic.resolveGenreName(g); if (r) resolved.push(r); } catch {}
    }
    genreLock = resolved.length ? resolved : null;
  }
  const eraLock = strict && hasEraBound(activeShow?.eras) ? activeShow!.eras : null;
  // Mood / energy locks only bite when the tagger / analyzer has actually run:
  // an un-tagged / un-analysed library carries no mood / energy on ANY track,
  // so a hard lock would empty every tool for the whole show and trip the
  // breaker with a misleading "model can't handle tools" diagnosis. Gate on
  // library coverage (byMood / byEnergy vocab) — the same spirit as the genre
  // drop-out. With coverage, a specific thin value still filters hard; the pool
  // fallback (never-starve per dimension) is the dead-air backstop behind it.
  const hasMoodCoverage = Object.keys(stats.byMood ?? {}).length > 0;
  const hasEnergyCoverage = Object.keys(stats.byEnergy ?? {}).length > 0;
  const moodLock = strict && activeShow?.moods?.length && hasMoodCoverage ? activeShow.moods : null;
  const energyLock = strict && activeShow?.energies?.length && hasEnergyCoverage ? activeShow.energies : null;
  // A pinned anchor that resolves to nothing (deleted/recreated playlist →
  // stale id, or a Navidrome error — resolveShowPlaylistPool swallows both)
  // silently un-anchors the show: no lock, no showPlaylistTracks tool. Say so,
  // loudly — a strict show playing 100% off-playlist with zero log output is
  // undiagnosable from the operator's side.
  if (activeShow?.playlistIds?.length && !playlistPool) {
    queue.log('picker', `show "${activeShow.name}" pins ${activeShow.playlistIds.length} playlist(s) but none resolved to tracks — anchor ignored${activeShow.playlistStrict ? ' (STRICT toggle has no effect)' : ''}. Stale playlist id (deleted/recreated in Navidrome?) or a Navidrome error; re-select the playlists in the show editor.`);
  }

  const run = await pickerAgent.run({
    messages: session.windowMessages(),
    recentIds,
    recentKeys,
    hardRecentIds,
    hardRecentKeys,
    // Sonic journey (Phase 2): registers the tracksTowardJourney tool, closed
    // over the run's current waypoint, so the agent path drifts the sound the
    // same way the pool path does. The event text tells the agent to use it.
    audioWaypoint,
    genreLock,
    eraLock,
    moodLock,
    energyLock,
    playlistLock,
    playlistTracks,
    excludedIds,
    showAt,
  });
  const { steps, toolCalls, extras } = run;
  let object = run.object;

  let song = object?.id ? extras.seen.get(object.id) : null;

  // The agent returned an id that isn't in the candidate set it was shown.
  // Two-stage salvage before giving up on the run (both observed live):
  //   1. Near-miss repair — the model transcribed a REAL id imperfectly
  //      (glm-5.1 dropped the final character of a 22-char nanoid; small
  //      local models corrupt 2-3 chars at a time, #939). nearestId only
  //      accepts an unambiguous prefix / clear-winner edit-distance match,
  //      so this can't misfire onto a different track. Free — no model call.
  //   2. Corrective re-pick — the model fabricated an id outright (gpt-5-mini
  //      after an empty tool result) while its `seen` map held real
  //      candidates. One djObject call constrained to those ids (grammar-
  //      enforced on local models, Zod-checked everywhere) beats paying the
  //      pool fallback + a breaker increment for a run that DID explore.
  if (!song && object?.id && extras.seen.size) {
    const fixed = nearestId(object.id, extras.seen.keys());
    if (fixed) {
      logEvent('pick.repaired', { agent: 'pick', from: object.id, to: fixed });
      queue.log('picker', `agent id "${object.id}" repaired to near-miss match "${fixed}"`);
      object = { ...object, id: fixed };
      song = extras.seen.get(fixed);
    }
  }
  if (!song && extras.seen.size) {
    const repicked = await repickFromSeen({ seen: extras.seen, badId: object?.id ?? null, wantLink, showAt, playlistResolved: !!playlistTracks?.length });
    if (repicked) {
      logEvent('pick.repicked', { agent: 'pick', from: object?.id ?? null, to: repicked.id, candidates: extras.seen.size });
      queue.log('picker', `agent returned unknown id "${object?.id}" — re-picked "${repicked.id}" from its own candidates`);
      object = repicked;
      song = extras.seen.get(repicked.id);
    }
  }

  if (!song) {
    // Both salvage stages missed (or the run surfaced zero candidates). The
    // trace still ends ok:true (we fall back to the pool and air a track), so
    // without this explicit event the rejection is invisible to /debug and the
    // log analyzer, which then over-report agent health. Emit it inside the
    // live trace so agent-pick reliability is real.
    logEvent('pick.rejected', { agent: 'pick', id: object?.id ?? null, candidates: extras.seen.size, steps, toolCalls });
    throw new Error(`agent returned unknown id ${object?.id}`);
  }

  const rawSay = typeof object.say === 'string' ? object.say.trim() : '';
  // Talk-within-the-intro (feature 3a): enqueuePick re-applies this trim at
  // the chokepoint (idempotent); it runs here too so the session turn below
  // records the line as it will actually air — trimmed, and dropped links as
  // null, never a line the listeners didn't hear.
  const say = trimLinkToIntro(rawSay, song) || '';
  // Transition effects on this pick (persona djMode via settings.effectsActive),
  // independent of whether a link airs.
  const link = (wantLink && say) ? say : null;
  const fxActive = settings.effectsActive();
  // The no-FX schema tells the model to leave transition null, but a model can
  // ignore a field description — say so in the log instead of discarding
  // silently (a "blend" in the LLM log that never airs reads as a broken mixer).
  if (!fxActive && object.transition && object.transition !== 'normal') {
    queue.log('mix', `transition "${object.transition}" ignored (persona not in DJ mode)`);
  }
  const sweep = fxActive && object.transition === 'sweep';
  const washout = fxActive && object.transition === 'washout';
  const blend = fxActive && object.transition === 'blend';
  const dissolve = fxActive && object.transition === 'dissolve';
  const chop = fxActive && object.transition === 'chop';
  const loop = fxActive && object.transition === 'loop';
  // Attach the link to the pick so it airs as the pick starts (back-announcing
  // the track on-air now), instead of immediately over that on-air track (#189).
  // Stamp `current` as the link's back-announce target so the queue can drop the
  // link if a request jumps ahead of this pick before it airs.
  const queued = await enqueuePick(queue, song, object.reason, 'agent', link, current, { sweep, washout, blend, dissolve, chop, loop });
  // Pick was already queued/on-air and got deduped — don't record a session turn
  // for a track that never airs. Returning false lets runTrackEvent fall through
  // to the pool for a fresh pick.
  if (queued === -1) return false;
  session.appendTurn({
    role: 'dj', kind: 'pick',
    text: object.reason || `Selected "${song.title}".`,
    meta: {
      trackId: song.id, title: song.title, artist: song.artist,
      steps, toolCalls, say: say || null,
    },
  });
  return true;
}

async function pickViaPool(queue, ctx, { wantLink, current, showAt = null }: { wantLink: boolean; current?: any; showAt?: Date | null }, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null) {
  // A DJ-mode mini-run (feature 4) anchors the pool re-rank to the run's
  // tempo/key target instead of the current track. null → today's behaviour.
  // A sonic journey (Phase 2) additionally anchors the audio-KNN source to the
  // run's current waypoint vector, drifting the pool toward the destination.
  const result = await picker.pickViaPool(queue, ctx, rankTarget, audioWaypoint);
  if (!result) {
    queue.log('picker', 'pool produced no pick');
    return;
  }
  // Build the between-track link BEFORE enqueueing so it can ride on the queued
  // item and air when the pick starts. It back-announces the track on-air right
  // now (`current`) and leads into the pick — because by the time it airs,
  // `current` will have just ended and the pick will be starting (#189).
  let link: string | null = null;
  if (wantLink && current) {
    try {
      link = await dj.generateLink({
        previous: current, current: result.song, context: ctx,
        // ctx is the queue watcher's look-ahead snapshot exactly when showAt is
        // set, so its clock is the link's air time — the only case the link may
        // speak it (issue #864: generation-time clocks aired a track late).
        clockIsAirTime: !!showAt,
        recap: queue.getDjRecap(),
        recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
      });
    } catch (err) {
      queue.log('error', `DJ link failed: ${err.message}`);
    }
  }
  // Talk-within-the-intro rides enqueuePick's trimLinkToIntro chokepoint —
  // the pool link needs no enforcement of its own here (#962 follow-up).
  // Transition effects ride the pool path too (pickNextTrack only offers the
  // field when settings.effectsActive()), so a DJ-mode persona keeps its craft
  // while picks run through this fallback. Re-check effectsActive at enqueue
  // time like the agent path does — the queue would strip a stale flag anyway
  // (applyMixTransition's dj-mode-off strip), but not stamping it keeps the
  // pick log honest.
  const fxActive = settings.effectsActive();
  const fx = {
    sweep: fxActive && result.transition === 'sweep',
    washout: fxActive && result.transition === 'washout',
    blend: fxActive && result.transition === 'blend',
    dissolve: fxActive && result.transition === 'dissolve',
    chop: fxActive && result.transition === 'chop',
    loop: fxActive && result.transition === 'loop',
  };
  // `current` is the link's back-announce target (passed to generateLink as
  // `previous`); stamp it so the queue drops the link if a request jumps ahead.
  const queued = await enqueuePick(queue, result.song, result.reason, result.source || 'pool', link, current, fx);
  // Even the pool landed on an already-queued track (a tiny library whose pool
  // collapsed to recents). Skip the session turn and let auto.m3u backstop the
  // slot — the next track-start re-triggers runTrackEvent for a fresh pick.
  if (queued === -1) return;
  // The reason text is concise on a successful pool pick and useful context for
  // the next turn — but on a failed pool LLM (picker.js returns the sentinel
  // 'fallback (LLM pick failed)'), recording it as the DJ's session turn primes
  // the next agent run with "you failed before", which derails models that read
  // the window. Substitute a neutral phrasing in that case so the conversation
  // still alternates (avoiding user-message coalescing) without the defeatist
  // signal.
  const sessionText = (result.reason && result.reason !== 'fallback (LLM pick failed)')
    ? result.reason
    : `Selected "${result.song.title}".`;
  session.appendTurn({
    role: 'dj', kind: 'pick',
    text: sessionText,
    meta: { trackId: result.song.id, title: result.song.title, artist: result.song.artist },
  });
}

// Called by the queue watcher when an autonomous track starts and the queue is
// empty. Posts the event to the session, then picks the next track (and an
// optional between-track link) via the agent, falling back to the pool.
// `ctx` is the pick's context — near a show boundary the queue watcher hands
// in a look-ahead snapshot (getFullContext at the pick's expected airtime) plus
// the matching `showAt` clock, so both pick paths follow the show that will
// actually be on air when the pick plays. `showAt` null → resolve at now,
// exactly the pre-look-ahead behaviour.
export async function runTrackEvent(queue, ctx, { wantLink, showAt = null }: { wantLink: boolean; showAt?: Date | null }) {
  return withTrace({ kind: 'track-event', wantLink }, async () => {
    // Daily token cap. At the hard cap we make NO model call: skip the pick and
    // let Liquidsoap fall through to the LLM-free auto playlist (music keeps
    // playing). In the soft tier we still pick — the stream needs a next track —
    // but cheaply: the stateless pool picker, and no link.
    if (!budget.picksAllowed()) {
      queue.log('budget', 'daily LLM token cap reached — coasting on the auto playlist');
      return;
    }
    const cheap = budget.preferCheapPicker();
    wantLink = wantLink && !cheap;

    const current = queue.current?.track || null;
    const previous = queue.history[0]?.track || null;
    const djMode = !!settings.getEffectivePersona()?.djMode;

    // Feature 4 + Phase 2 — advance/maybe-start a mini-run; get the tempo/key
    // re-rank target and (when the audio index supports it) a sonic-journey
    // waypoint for the pool's audio anchor.
    const { rankTarget, audioWaypoint } = advanceRun(djMode, current);
    const inRun = runActive();

    // The link clause differs in DJ mode: a working DJ doesn't just announce the
    // next track, they TEASE it — name the artist or capture its feel so
    // listeners know what's coming. The agent already knows its own pick when
    // it writes `say`, so this costs nothing extra. The link is FORWARD-LOOKING
    // only — it introduces the pick, never back-announces "${current?.title}".
    // The link airs when the pick starts, but a listener request can slip ahead
    // of the pick in the meantime, so naming what "just played" goes stale (it
    // names a track one older than reality); introducing the pick is always
    // correct whatever aired before it.
    // The "nod to it in the link" half only makes sense when a link is actually
    // being written — gate it on wantLink so a silent mid-run pick ("Stay silent
    // — no link this time.") doesn't also get told it may phrase something in a
    // link that won't exist. The energy-direction guidance is pick selection, so
    // it stays unconditional.
    const runClause = inRun
      ? ` You're mid-run — keep the energy moving in the same direction (a touch ${energyForDaypart().speed >= 1 ? 'brisker' : 'mellower'}).`
        + (wantLink ? ' You may nod to it in the link, but never say tempo numbers.' : '')
      : '';
    // Gated on the waypoint itself, not inRun: on a run's final pick the run
    // state is already cleared (advanceRun) but the last waypoint — the
    // destination itself — is still the one to land on.
    const journeyClause = audioWaypoint && audioWaypoint.length
      ? ' A sonic journey is active: call tracksTowardJourney and lean toward one of its tracks — each carries the sound a step toward where this arc is heading. If it comes back thin, pick via the library mood/genre/audio tools and keep the energy heading the same way. Never mention the journey on air.'
      : '';
    // Opener variety for the link. The free-text pool path gets a rotating angle
    // + an anti-repeat opener list via decoratePrompt; the agent `say` path
    // didn't, so its links settled into the same shape ("here's…", "coming
    // up…"). Feed it the same two signals through the event message: one random
    // forward-looking angle to vary the approach, and the recent openers to
    // steer clear of. Only when a link is actually being written.
    const linkAngle = wantLink ? dj.pickAngle('link') : null;
    const recentOpeners = wantLink ? queue.getRecentOpeners() : [];
    // Clock discipline for the link (issue #864). The agent path carries no
    // clock at all — the model extrapolates one from stale stamped lines in
    // its session window, then the link airs a further full track after it's
    // written, so spoken times ran 10-20 minutes behind. When the queue
    // watcher resolved the look-ahead (showAt), ctx's clock IS the link's air
    // time — hand it over as the only time the link may speak; without the
    // look-ahead (unknown duration), ban the clock outright.
    const clockClause = wantLink
      ? (showAt && ctx?.clock?.hhmm
          ? ` The link airs at about ${ctx.clock.display || ctx.clock.hhmm} — if you mention the clock, that is the time to use, never an earlier one.`
          : ` Never state the clock time in the link — you can't know exactly when it airs.`)
      : '';
    const varietyClause = wantLink
      ? ` Approach for this link: ${linkAngle} Vary your first words — don't default to "here's", "this is", or "coming up".`
        + (recentOpeners.length
            ? ` You opened recent lines with ${recentOpeners.slice(0, 6).map(o => `"${o}…"`).join(', ')} — start this one differently.`
            : '')
      : '';
    const linkClause = wantLink
      ? (djMode
          ? ` Also write a short link that airs as your pick starts: introduce what's coming — name the artist or capture the feel of the track you pick so listeners know what's next. Do not back-announce or name the track that just played. If the track you pick shows an intro_ms, keep the link short enough to finish before then, so you land just as the vocals come in.${varietyClause}`
          : ` Also write a short link that airs as your pick starts: lead into the track you pick. Do not back-announce or name the track that just played.${varietyClause}`)
      : ' Stay silent — no link this time.';
    // Surface the current track's real Subsonic id so similarSongs /
    // tracksLikeThis ("pass the currently-playing song id") actually have one
    // to pass. Without it the agent fabricates a slug from the title/artist
    // (e.g. "lost-sultaan-romeo") and Navidrome answers "data not found".
    // Per-pick effects reminder: the system-prompt guidance alone loses to the
    // session history (the model sees ~40 of its own prior picks, almost all
    // transition:"normal", and copies itself — observed on-air: 19 picks, zero
    // washouts). The event turn is the freshest instruction in the window, so
    // the deliberate-choice nudge rides here.
    const recentT = typeof queue.recentTransitionChoices === 'function' ? queue.recentTransitionChoices() : [];
    const historyNote = recentT.length
      ? ` Your recent transition choices, oldest first: ${recentT.join(', ')} — the station strips a third repeat, so vary deliberately.`
      : '';
    const effectClause = settings.effectsActive()
      ? ` Set "transition" by what THIS moment needs — "washout" to dissolve out as it ends, "loop" to catch this pick's last bar in a repeating loop as it ends, "sweep" for a gear-change entry, "dissolve" to melt a clash into ambience, "chop" to cut a beat-driven track out on the beat for an energy jump, "blend" ONLY for an exceptionally locked pair (a plain crossfade already handles ordinary same-lane picks), "normal" for a plain hand-off. Vary your craft: never the same transition three picks running, and if your last pick used an effect, lean "normal" now unless the moment clearly calls again.${historyNote}`
      : '';
    // The turn is split in two: `text` is the factual event (what the booth
    // log on /admin/dash shows the operator), `meta.promptSuffix` carries the
    // model-facing coaching clauses (transition nudge, clock rule, run/journey
    // steering). windowMessages() re-joins them for the agent, so the model
    // sees the same message as before — the operator just stops reading
    // prompt engineering in the booth log.
    const eventText = `Now playing "${current?.title}" by ${current?.artist}`
      + (current?.id ? ` [id: ${current.id}]` : '')
      + (previous ? ` (after "${previous.title}" by ${previous.artist})` : '')
      + '. Pick the track to play next.'
      + linkClause;
    const promptSuffix = `${clockClause}${effectClause}${runClause}${journeyClause}`;
    session.appendTurn({
      role: 'event', kind: 'pick', text: eventText,
      meta: promptSuffix ? { promptSuffix } : {},
    });

    // `!cheap`: in the soft budget tier we skip the multi-step agent tool-loop
    // and go straight to the one-call pool picker below to stretch the budget.
    if (settings.get().llm?.pickerAgent && !cheap && !breakerOpen()) {
      try {
        const queued = await pickViaAgent(queue, { wantLink, audioWaypoint, current, showAt });
        breakerSuccess();
        if (queued) return;
        // The agent produced a valid pick but it was already queued/on-air, so
        // push() dropped it. The agent itself is healthy — don't trip the
        // breaker; fall through to the pool for a fresh pick (auto.m3u backstops
        // if even the pool can only find an already-queued track).
        queue.log('picker', 'agent pick already queued — falling back to pool');
      } catch (err) {
        queue.log('error', `DJ agent pick failed: ${err.message} — falling back to pool`);
        breakerFailure(queue);
      }
    }
    await pickViaPool(queue, ctx, { wantLink, current, showAt }, rankTarget, audioWaypoint);
  });
}

// ---------------------------------------------------------------------------
// Request event — a listener asked for something.
// ---------------------------------------------------------------------------

// Returns { ack, track } on success, or null when the conversational agent is
// disabled or the breaker is open (the caller then runs its own stateless
// matcher cascade). Throws if the agent runs but fails — the caller catches
// and falls back the same way. Agent outcomes here feed the shared breaker:
// the request agent runs the same model through the same done-tool harness,
// so its failures are the same symptom.
// The caller (routes/request.js) owns the request `event` turn — it posts one
// for every request path, so the agent only appends its own `dj` reply here.
export async function runRequest(queue: any, ctx: any, { requester, text }: { requester: string; text: string }) {
  if (!settings.get().llm?.pickerAgent || breakerOpen()) return null;
  // Over the hard token cap the request agent only runs when requests are
  // exempt (llm.exemptRequests, on by default); otherwise return null and let
  // the caller's stateless matcher cascade handle it without a model call.
  if (!budget.requestsAllowed()) return null;

  try {
    const out = await runRequestViaAgent(queue, { requester, text });
    breakerSuccess();
    return out;
  } catch (err) {
    breakerFailure(queue);
    throw err;
  }
}

async function runRequestViaAgent(queue: any, { requester, text }: { requester: string; text: string }) {
  return withTrace({ kind: 'request', requester }, async () => {
    // Requests stay near-unfiltered — listeners must be able to re-request a
    // song from earlier in the day. 2h covers the "don't repeat the song still
    // ringing in their ears" case and nothing more.
    const recentIds = queue.recentlyPlayedIds(2);
    for (const id of queue.queuedIds()) recentIds.add(id);

    // Pin THIS run to THIS request with an explicit tail message instead of
    // trusting the session's last event turn. resolveRequest posts request
    // events into the SHARED session, so with two requests in flight the other
    // listener's event can be the more recent one (agent runs take tens of
    // seconds), and the session append is best-effort — if it failed, the
    // window holds no request at all. Either way the tail is what the system
    // prompt points the agent at ("the final user line"). Coalesced into a
    // trailing user message because some providers require strict alternation;
    // windowMessages() returns fresh copies, so appending in place is safe.
    const cur = queue.current?.track || null;
    const tail = `The request to resolve now — listener "${requester}" asks: "${text}"`
      + (cur ? ` (currently playing "${cur.title}" by ${cur.artist}${cur.id ? ` [id: ${cur.id}]` : ''})` : '');
    const messages = session.windowMessages();
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') last.content += '\n' + tail;
    else messages.push({ role: 'user', content: tail });

    const { object, toolCalls, extras } = await requestAgent.run({
      messages,
      recentIds,
    });

    let song = object?.id ? extras.seen.get(object.id) : null;
    // Near-miss repair, same as the pick path: an unambiguous prefix /
    // clear-winner edit-distance match against the run's own candidates
    // rescues an id the model transcribed imperfectly (#939). No re-pick
    // stage here — a request that
    // can't resolve should fall to the caller's stateless matcher cascade,
    // which understands the listener's actual text.
    if (!song && object?.id && extras.seen.size) {
      const fixed = nearestId(object.id, extras.seen.keys());
      if (fixed) {
        logEvent('pick.repaired', { agent: 'request', from: object.id, to: fixed });
        song = extras.seen.get(fixed);
      }
    }
    if (!song) {
      logEvent('pick.rejected', { agent: 'request', id: object?.id ?? null, candidates: extras.seen.size, toolCalls });
      throw new Error(`request agent returned unknown id ${object?.id}`);
    }

    const intro = typeof object.intro === 'string' ? object.intro.trim() : '';
    const pos = await queue.push({
      track: trackFields(song),
      requestedBy: requester,
      intent: 'listener request',
      introScript: intro || null,
      introKind: 'dj-speak',
    });
    // Never-play blocklist refused the pick — throw so the route's stateless
    // fallback cascade runs; its own resolution is blocklist-filtered, so the
    // listener gets the standard not-found decline rather than a silent drop.
    if (pos === -2) throw new Error('pick refused by never-play blocklist');
    // A concurrent request already queued this exact track — push() deduped it
    // (#619). Acknowledge honestly (no second back-to-back play, no false
    // "coming up", no intro to air) and still append the line as the session
    // reply so the request event isn't left without one.
    if (pos === -1) {
      const ack = queue.dedupAck(song.id);
      session.appendTurn({
        role: 'dj', kind: 'request',
        text: ack,
        meta: { trackId: song.id, requester, toolCalls },
      });
      return { ack, track: { title: song.title, artist: song.artist, id: song.id }, introScript: null };
    }
    session.appendTurn({
      role: 'dj', kind: 'request',
      text: intro || object.ack || `Queued "${song.title}".`,
      meta: { trackId: song.id, requester, toolCalls },
    });

    return {
      ack: object.ack || `Coming up for you, ${requester}.`,
      track: { title: song.title, artist: song.artist, id: song.id },
      introScript: intro || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Persona handoff — a two-voice mic-pass at a show boundary.
// ---------------------------------------------------------------------------
//
// When session.maybeRoll() hard-rolls and the effective PERSONA changed, it
// stamps roll metadata on the fresh session (session.pendingHandoff). This runs
// after the roll — driven by whichever maybeRoll call site fires first (the
// queue's track-start, or the :00 hourly cron) — and, when a handoff is pending,
// airs a sign-off in the OUTGOING persona's voice followed by a greeting in the
// incoming persona's voice. Both go through the serialized say.txt voice chain
// (queue.announce → airVoice), so they play cleanly back to back.
//
// Never throws (callers still need to run the pick after it) and is idempotent:
// it marks the handoff aired up front, so a concurrent second call — or a
// mid-way failure — can't double-air or retry into the middle of the new show.
export async function runPersonaHandoff(queue: any, ctx: any): Promise<void> {
  const pending = session.pendingHandoff();
  if (!pending) return;

  // Nobody listening → the mic-pass moment has passed; don't stack a stale
  // handoff for later. Budget: treated as an optional segment (muted in soft
  // and hard tiers, policy in dj-budget.ts). Either way, mark aired so it
  // doesn't retry — a handoff fires at most ~once an hour and is cheap to loosen.
  if (!djCallsAllowed() || !budget.optionalSegmentsAllowed()) {
    session.markHandoffAired();
    return;
  }

  // Outgoing persona comes from the roll metadata — its clock slot is already
  // over, so getEffectivePersona() no longer returns it. Incoming is the fresh
  // session's persona. A persona deleted mid-shift → nothing to voice; drop it.
  const personaOut = settings.resolvePersonaById(pending.personaId);
  const cur = session.getSession();
  const personaIn = settings.resolvePersonaById(cur?.persona?.id) || settings.getEffectivePersona();
  if (!personaOut || !personaIn) {
    session.markHandoffAired();
    return;
  }
  const showIn = cur?.show?.name || null;

  // Mark aired BEFORE airing (see the idempotency note above).
  session.markHandoffAired();

  await withTrace({ kind: 'handoff', from: personaOut.name, to: personaIn.name }, async () => {
    const recentOpeners = queue.getRecentOpeners();
    let aired = false;

    // 1. Sign-off, in the OUTGOING persona's voice. Tag the session turn with
    //    the outgoing persona's id + name — session.windowMessages() uses the id
    //    to spot a turn spoken by someone other than the session's own persona
    //    and names the real speaker, so the incoming DJ never reads the
    //    sign-off as its own words.
    let signoffText: string | null = null;
    try {
      signoffText = await dj.generateSignoff({
        personaOut, personaIn, showIn,
        context: ctx, recap: queue.getDjRecap(), recentOpeners,
      });
      await queue.announce(signoffText, 'handoff', {
        persona: personaOut, meta: { personaId: personaOut.id, personaName: personaOut.name },
      });
      aired = true;
    } catch (err: any) {
      queue.log('error', `Handoff sign-off failed: ${err.message}`);
      signoffText = null;
    }

    // 2. Greeting, in the INCOMING persona's voice — fed the sign-off text so
    //    it can genuinely respond. Stands alone if the sign-off didn't air.
    //    On a programme show the greeting doubles as the episode's intro, so
    //    the producer's angle (planned before this runs — see the call sites)
    //    rides along; the standalone intro is then skipped (programme.ts).
    try {
      const greeting = await dj.generateHandoffGreeting({
        personaIn, personaOut, signoffText, showIn,
        episodeAngle: session.getProgramme()?.plan?.angle || null,
        context: ctx, recap: queue.getDjRecap(), recentOpeners,
      });
      await queue.announce(greeting, 'handoff', { persona: personaIn });
      aired = true;
    } catch (err: any) {
      queue.log('error', `Handoff greeting failed: ${err.message}`);
    }

    if (aired) {
      logEvent('dj.handoff', { from: personaOut.name, to: personaIn.name, show: showIn });
    }
  });
}
