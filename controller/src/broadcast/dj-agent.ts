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
import * as library from '../music/library.js';
import * as mix from '../music/mix.js';
import * as journey from '../music/journey.js';
import * as dj from '../llm/dj.js';
import { energyForDaypart } from '../context.js';
import { defineAgent } from '../llm/agent.js';
import { buildPickerTools } from '../llm/tools.js';
import { recordPick } from '../llm/log.js';
import * as budget from './dj-budget.js';
import { withTrace, logEvent } from '../observability/events.js';
import { recencyWindowsForLibrary, effectiveNoRepeatWindow } from '../music/recency.js';

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

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

// Resolve {bpm, key} for a track via the library DB (queued/agent picks carry
// only id/title/artist).
function analysisOf(track: any): { bpm: number | null; key: string | null } {
  if (!track) return { bpm: null, key: null };
  if (track.bpm != null || track.musicalKey != null) {
    return { bpm: track.bpm ?? null, key: track.musicalKey ?? null };
  }
  const rec = track.id ? library.get(track.id) : null;
  return { bpm: rec?.bpm ?? null, key: rec?.musicalKey ?? null };
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

export const PICK_SCHEMA = z.object({
  id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
  reason: z.string().describe('internal scratchpad only — max 12 words, never shown to the listener; do not justify, just note what makes THIS pick a fresh step (new artist, a shift in energy/era/texture), not a vibe label you would recycle pick after pick (e.g. "new artist, lifts the energy", never a repeated "mellow reflective step")'),
  say: z.string().nullable().describe('when the latest event message says to write a spoken link, set this to one or two natural sentences in the DJ voice (back-announce what just played, ease into what is coming, vary your opener); when the event says stay silent, set this to null'),
  // Transition effects (only honoured when the system prompt offers them — DJ mode + effects on).
  transition: z.enum(['normal', 'sweep', 'washout']).nullable().describe('special transition effect for this pick, used RARELY: "sweep" muffles the music under a lowpass that opens across the crossfade INTO this pick (it surfaces from far away) — for a big mood/energy jump; "washout" dissolves THIS track into a wide ping-pong echo tail as it ENDS, bleeding into the next track — for closing a segment or a dreamy/ambient pick; "normal" or null for an ordinary crossfade'),
});

const REQUEST_SCHEMA = z.object({
  id: z.string().describe('the exact song id returned by one of the discovery tools — never invent or compose ids'),
  ack: z.string().describe('short on-air acknowledgement of the listener, in character — max 20 words; no "thank you for listening" or self-intros'),
  intro: z.string().describe('a natural DJ intro for the track in the DJ voice; weave in what the listener asked for without reading the request back verbatim'),
});

// Ultra-minimal — persona + editorial criteria, nothing else. The AI SDK
// already conveys everything else through its own channels: tool descriptions
// (llm/tools.js), the done-tool description (llm/sdk.js), schema field
// descriptions (PICK_SCHEMA above), and the per-pick event message in the
// session window ("Stay silent — no link this time." vs "Also write a short
// link to speak over this track now."). Duplicating those in prompt text
// competes with the framework's structural signals and derails smaller
// models. PICKER_CRITERIA stays because it's editorial preference (flow,
// context, variety, interest) — that's not in any tool or schema.
// Guidance for the transition effects (PICK_SCHEMA.transition), appended to the
// picker system prompt ONLY when effects are active (global toggle + on-air
// persona djMode). Invisible otherwise, so the model leaves "transition" null.
function effectsGuidance(): string {
  if (!settings.effectsActive()) return '';
  return `\n\nTRANSITION EFFECTS ("transition") — use rarely, at most one in a set, only when it serves the moment:\n- "sweep": the music muffles under a lowpass that opens back up across the crossfade INTO your pick, so the new track surfaces from far away. Choose it on a big mood/energy jump.\n- "washout": this track dissolves into a wide ping-pong echo tail as it ENDS and bleeds into the next track. Choose it to close a segment, or for a dreamy/ambient pick. Otherwise "normal" or null.`;
}

export function pickSystem() {
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
  const activeShow = settings.resolveActiveShow();
  const showLine = activeShow?.topic
    ? `\n\nCurrent show brief — follow this for every pick:\n${activeShow.topic}`
    : '';
  // The same genre/decade/energy steer the pool picker applies — the agent
  // already owns songsByGenre + tracksByMood(energy) tools, so this line is
  // enough to make it reach for them. showMusicLean reflects the show's
  // genreStrict here too: a strict show gets a hard "stay within {genre}" rule
  // instead of a soft lean, so both pick paths honour strict the same way. Lives
  // in the system prompt for the same session-window reason as the show brief.
  const musicLean = dj.showMusicLean(activeShow);
  return `${settings.agentPersonaPreamble(persona, { rules: false })}

You run the station as one continuous shift. The messages above are the live session.${djModeLine}${showLine}${musicLean}

${dj.PICKER_CRITERIA}

Finding candidates: prefer tools backed by the local library — searchLibrary, songsByGenre, tracksByMood, tracksByEnergy, randomSongs, and the audio/embedding similarity tools. similarSongs and topSongsByArtist use external data and often return little, so try them second. If a tool returns nothing, switch tools rather than retrying. If a tool returns only a few tracks (fewer than ~4), make one more discovery call with a different tool before choosing, so you pick from a real range rather than whatever the first call happened to surface.${effectsGuidance()}${settings.agentLanguageReminder(persona, 'the "say" link')}`;
}

function requestSystem() {
  const persona = settings.getEffectivePersona();
  return `${settings.agentPersonaPreamble(persona, { rules: false })}

The messages above are the live session — the last user turn is a listener request.${settings.agentLanguageReminder(persona, 'the "ack" and "intro" lines')}`;
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
// by withDeadline in llm/sdk.ts (main + recovery runs each get the full
// budget, so worst case per agent call is ~2× this). It comes from
// settings.llm.agentTimeoutMs (default 45s, admin-tunable) — slow
// reasoning-heavy cloud models routinely need 20-40s per pick, and a pick has
// a whole track length of slack; the deadline exists to contain the unbounded
// 60s+ stalls (#352), not to demand snappy answers.
function agentDeadline(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}

export const pickerAgent = defineAgent({
  kind: 'djAgentPick',
  schema: PICK_SCHEMA,
  // The done-tool path ends the loop at step 1 (COMMIT_AFTER_STEPS in sdk.js)
  // on every provider now; maxSteps is just the backstop.
  maxSteps: 4,
  timeoutMs: agentDeadline,
  buildSystem: () => pickSystem(),
  buildTools: ({ recentIds, recentKeys, hardRecentIds, hardRecentKeys, audioWaypoint }) => {
    // Resolve the active show live (a show that just came on air takes effect):
    // for a strict show, hard genre + era locks the discovery tools enforce on
    // candidates — not just the prompt. Era rides the same genreStrict flag (no
    // separate era-strict toggle). Track length is enforced as an on-air cut,
    // NOT a pick filter (issue #447), so no length cap is passed here.
    const activeShow = settings.resolveActiveShow();
    const strict = !!(activeShow?.genreStrict);
    const genreLock = strict && activeShow?.genre ? activeShow.genre : null;
    const eraLock = strict && (activeShow?.fromYear != null || activeShow?.toYear != null)
      ? { fromYear: activeShow.fromYear, toYear: activeShow.toYear }
      : null;
    const { tools, seen } = buildPickerTools({ recentIds, recentKeys, hardRecentIds, hardRecentKeys, audioWaypoint, genreLock, eraLock });
    return { tools, extras: { seen } };
  },
});

export const requestAgent = defineAgent({
  kind: 'djAgentRequest',
  schema: REQUEST_SCHEMA,
  maxSteps: 4,
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
});

function trackFields(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    year: song.year,
    genre: song.genre,
  };
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
async function enqueuePick(
  queue, song, reason, source,
  link: string | null = null,
  { sweep = false, washout = false }: { sweep?: boolean; washout?: boolean } = {},
): Promise<number> {
  const track: any = trackFields(song);
  // Flag the transition effects on this pick (DJ mode only). getAnnotatedUri
  // stamps liq_sweep / liq_washout; radio.liq ramps them. sweep muffles the
  // crossfade INTO this pick; washout rings this track out into an echo tail as
  // it ENDS.
  if (sweep) track.sweep = true;
  if (washout) track.washout = true;
  const pos = await queue.push({
    track,
    requestedBy: null,
    intent: reason || 'ai pick',
    introScript: link,
    introKind: 'link',
    aiPicked: true,
  });
  if (pos === -1) return -1;
  queue.log('ai-pick', `${song.title} — ${song.artist}`, { reason, source });
  recordPick({ song, reason, source });
  return pos;
}

// ---------------------------------------------------------------------------
// Track event — a track started; pick the next one and maybe air a link.
// ---------------------------------------------------------------------------

async function pickViaAgent(queue, { wantLink, audioWaypoint = null }: { wantLink: boolean; audioWaypoint?: number[] | null }): Promise<boolean> {
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

  const { object, steps, toolCalls, extras } = await pickerAgent.run({
    messages: session.windowMessages(),
    recentIds,
    recentKeys,
    hardRecentIds,
    hardRecentKeys,
    // Sonic journey (Phase 2): registers the tracksTowardJourney tool, closed
    // over the run's current waypoint, so the agent path drifts the sound the
    // same way the pool path does. The event text tells the agent to use it.
    audioWaypoint,
  });

  const song = object?.id ? extras.seen.get(object.id) : null;
  if (!song) {
    // The agent returned an id that isn't in the candidate set it was shown —
    // it fabricated one. The trace still ends ok:true (we fall back to the pool
    // and air a track), so without this explicit event the rejection is
    // invisible to /debug and the log analyzer, which then over-report agent
    // health. Emit it inside the live trace so agent-pick reliability is real.
    logEvent('pick.rejected', { agent: 'pick', id: object?.id ?? null, candidates: extras.seen.size, steps, toolCalls });
    throw new Error(`agent returned unknown id ${object?.id}`);
  }

  const rawSay = typeof object.say === 'string' ? object.say.trim() : '';
  // Talk-within-the-intro (feature 3a): in DJ mode, hard-trim the link to the
  // pick's measured intro runway so the DJ lands before the vocals instead of
  // talking over them. No-op when the pick is un-analysed or not in DJ mode.
  const djMode = !!settings.getEffectivePersona()?.djMode;
  const say = (djMode && rawSay) ? dj.enforceIntroBudget(rawSay, introMsOf(song)) : rawSay;
  // Music filter sweep on the crossfade into the pick (DJ mode + effects toggle),
  // independent of whether a link airs.
  const link = (wantLink && say) ? say : null;
  const sweep = settings.effectsActive() && object.transition === 'sweep';
  const washout = settings.effectsActive() && object.transition === 'washout';
  // Attach the link to the pick so it airs as the pick starts (back-announcing
  // the track on-air now), instead of immediately over that on-air track (#189).
  const queued = await enqueuePick(queue, song, object.reason, 'agent', link, { sweep, washout });
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

async function pickViaPool(queue, ctx, { wantLink, current }, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null) {
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
        recap: queue.getDjRecap(),
        recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
      });
    } catch (err) {
      queue.log('error', `DJ link failed: ${err.message}`);
    }
  }
  const queued = await enqueuePick(queue, result.song, result.reason, result.source || 'pool', link);
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
export async function runTrackEvent(queue, ctx, { wantLink }) {
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

    // The link clause differs in DJ mode: a working DJ doesn't just ease into
    // the next track, they TEASE it — name the artist or capture its feel so
    // listeners know what's coming. The agent already knows its own pick when
    // it writes `say`, so this costs nothing extra.
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
    const linkClause = wantLink
      ? (djMode
          ? ` Also write a short link that airs as your pick starts: back-announce "${current?.title}", then tease what's next — name the artist or capture the feel of the track you pick so listeners know what's coming. If the track you pick shows an intro_ms, keep the link short enough to finish before then, so you land just as the vocals come in.`
          : ` Also write a short link that airs as your pick starts: back-announce "${current?.title}" and lead into the track you pick.`)
      : ' Stay silent — no link this time.';
    // Surface the current track's real Subsonic id so similarSongs /
    // tracksLikeThis ("pass the currently-playing song id") actually have one
    // to pass. Without it the agent fabricates a slug from the title/artist
    // (e.g. "lost-sultaan-romeo") and Navidrome answers "data not found".
    const eventText = `Now playing "${current?.title}" by ${current?.artist}`
      + (current?.id ? ` [id: ${current.id}]` : '')
      + (previous ? ` (after "${previous.title}" by ${previous.artist})` : '')
      + '. Pick the track to play next.'
      + linkClause
      + runClause
      + journeyClause;
    session.appendTurn({ role: 'event', kind: 'pick', text: eventText });

    // `!cheap`: in the soft budget tier we skip the multi-step agent tool-loop
    // and go straight to the one-call pool picker below to stretch the budget.
    if (settings.get().llm?.pickerAgent && !cheap && !breakerOpen()) {
      try {
        const queued = await pickViaAgent(queue, { wantLink, audioWaypoint });
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
    await pickViaPool(queue, ctx, { wantLink, current }, rankTarget, audioWaypoint);
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
export async function runRequest(queue: any, ctx: any, { requester, text: _text }: { requester: string; text: string }) {
  if (!settings.get().llm?.pickerAgent || breakerOpen()) return null;
  // Over the hard token cap the request agent only runs when requests are
  // exempt (llm.exemptRequests, on by default); otherwise return null and let
  // the caller's stateless matcher cascade handle it without a model call.
  if (!budget.requestsAllowed()) return null;

  try {
    const out = await runRequestViaAgent(queue, { requester });
    breakerSuccess();
    return out;
  } catch (err) {
    breakerFailure(queue);
    throw err;
  }
}

async function runRequestViaAgent(queue: any, { requester }: { requester: string }) {
  return withTrace({ kind: 'request', requester }, async () => {
    // Requests stay near-unfiltered — listeners must be able to re-request a
    // song from earlier in the day. 2h covers the "don't repeat the song still
    // ringing in their ears" case and nothing more.
    const recentIds = queue.recentlyPlayedIds(2);
    for (const id of queue.queuedIds()) recentIds.add(id);

    const { object, toolCalls, extras } = await requestAgent.run({
      messages: session.windowMessages(),
      recentIds,
    });

    const song = object?.id ? extras.seen.get(object.id) : null;
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
