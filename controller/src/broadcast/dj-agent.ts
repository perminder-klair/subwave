// Session DJ agent — the conversational brain that runs over a stream session.
//
// This module owns the pick and request runs; the pieces they're built from
// live in ./dj-agent/ and are re-exported below, so `from './dj-agent.js'`
// still reaches the whole surface:
//
//   runs.ts      DJ-mode mini-runs (a short arc of picks heading somewhere)
//   schemas.ts   the pick/request output schemas and system prompts
//   breaker.ts   the circuit breaker that drops to the pool picker
//   agents.ts    the two tool-loop agent definitions
//   enqueue.ts   turning a chosen song into a queued track
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
import * as dj from '../llm/dj.js';
import { energyForDaypart, getClockContext, getDateContext, getTimeContext } from '../context.js';
import { linkClockAt, linkClockStampFor } from './queue/pure.js';
import { djObject, nearestId, modelTolerant } from '../llm/sdk.js';
import * as budget from './dj-budget.js';
import { withTrace, logEvent } from '../observability/events.js';
import { recencyWindowsForLibrary } from '../music/recency.js';
import { effectiveShowNoRepeatWindow } from '../music/show-recency.js';
import { EXPLORE_SEED_PROBABILITY } from '../music/airing.js';
import { ARTIST_VARIETY_WINDOW, runArtistGuard } from './dj-agent/artist-guard.js';
import { hasEraBound, genreResolutionWarningOnce, type VocalMode } from '../music/show-filter.js';
import { djCallsAllowed } from './listeners.js';
import { autoVoiceAllowed } from './voice-policy.js';
import { speakClockAllowed } from './clock-policy.js';
import { pickerAgent, requestAgent } from './dj-agent/agents.js';
import { pickerScope } from '../llm/tools.js';
import {
  HANDOFF_MAX_AGE_MS,
  breakerFailure,
  breakerOpen,
  breakerSuccess,
} from './dj-agent/breaker.js';
import { dropEchoedLink, enqueuePick, trackFields, trimLinkToIntro } from './dj-agent/enqueue.js';
import { advanceRun, runActive } from './dj-agent/runs.js';
import { pickSchemaBase, pickSystem, requestSystem } from './dj-agent/schemas.js';
import { guardIntro, screenAck, isNamedRequester } from '../util/request-guard.js';
import * as likes from './likes.js';
import { classifyPickFailure, type PickFailure } from '../util/pick-seed.js';

// Re-exported so every existing `from './dj-agent.js'` import keeps working —
// including scripts/llm-bench, which sits outside tsconfig's include and so
// wouldn't have surfaced here as a type error.
export { runActive } from './dj-agent/runs.js';
export {
  PICK_SCHEMA, PICK_SCHEMA_NO_FX, pickSchema, pickSystem, requestSchema, requestSystem,
} from './dj-agent/schemas.js';
export { pickerAgent, requestAgent } from './dj-agent/agents.js';

// ---------------------------------------------------------------------------
// Track event — a track started; pick the next one and maybe air a link.
// ---------------------------------------------------------------------------

// Stage-2 salvage for an agent run whose final id no tool surfaced (see the
// cascade in pickViaAgent): one djObject call over the run's OWN accumulated
// candidates (`seen`), with the id constrained to that exact set — z.enum
// becomes a decode-time grammar on local models and a Zod reject elsewhere,
// the same closing move pickNextTrack already uses. Returns a full pick object
// (id/reason/transition) or null; never throws, so a salvage failure falls
// through to the caller's pick.rejected path unchanged.
// `reason`, when given, replaces the default "you returned a bad id" framing —
// the back-to-back artist guard (#1124) reuses this same constrained re-pick
// but for a valid pick it wants to swap off the on-air artist, so the bad-id
// wording would be false and confuse the model.
async function repickFromSeen({ seen, badId, showAt = null, playlistResolved = true, reason = null }: { seen: Map<string, any>; badId: string | null; showAt?: Date | null; playlistResolved?: boolean; reason?: string | null }) {
  const ids = [...seen.keys()];
  if (ids.length === 0) return null;
  const schema = modelTolerant(pickSchemaBase().extend({
    id: z.enum(ids as [string, ...string[]]).describe('the exact id of one candidate'),
  }));
  const why = reason
    ?? `You explored the library and then answered with ${badId ? `the id "${badId}", which matches none of the tracks your tools returned` : 'no usable track id'}. Only ids from the candidates above are real. Choose the best next track from them.`;
  try {
    return await djObject({
      // Same show snapshot as the failed run (showAt) and the same playlist-
      // resolved gate — a tool-less salvage call must NOT reinstate "call
      // showPlaylistTracks first / every pick MUST come from the playlist" when
      // the anchor never resolved (no such tool exists here) or resolve a
      // different show than the run whose candidates we're re-picking from.
      // Two knowing mismatches with the real pick call: pickSystem's discovery
      // paragraph talks tools this tool-less call doesn't have (the "only ids
      // from the candidates" framing below overrides it), and the listener
      // favourites clause is absent (it rides the pick EVENT turn, not this
      // system prompt) — acceptable because `seen` was discovered under the
      // favourites-aware run this salvages.
      system: pickSystem(showAt, playlistResolved),
      prompt: JSON.stringify({ candidates: [...seen.values()] }, null, 2)
        + `\n\n${why}`,
      schema,
      temperature: 0.5,
      kind: 'djAgentRepick',
    });
  } catch {
    return null;
  }
}

// Request-flavoured corrective re-pick (D1): mirrors repickFromSeen above, for
// when the request agent returns an id outside its own discovery trail. Seen
// live as the SAME hallucinated id recurring across independent requests hours
// apart, which looks like the model copying an id out of a session event turn
// (every pick event tags the current track `[id: …]`) rather than fabricating
// one — the idInSessionWindow diagnostic on the pick.rejected event is what
// turns that hunch into a number.
//
// One djObject call constrained to the run's own candidates (z.enum — a
// decode-time grammar on local models, a Zod reject elsewhere) salvages the run
// instead of discarding it to the caller's stateless matcher cascade, which
// still runs when this misses too. Reuses requestSystem()/requestSchema()'s own
// wording and the same autoVoiceAllowed() gate for `intro`, so a re-picked
// request is consistent with a first-try one. Never throws.
async function repickRequestFromSeen({ seen, badId, requester, text }:
  { seen: Map<string, any>; badId: string | null; requester: string; text: string }) {
  const ids = [...seen.keys()];
  if (ids.length === 0) return null;
  const wantIntro = autoVoiceAllowed();
  const schema = modelTolerant(z.object({
    id: z.enum(ids as [string, ...string[]]).describe('the exact id of one candidate'),
    ack: z.string().describe('short on-air acknowledgement of the listener, in character — max 20 words; no "thank you for listening" or self-intros'),
    ...(wantIntro ? {
      intro: z.string().describe(`a natural DJ intro for the track in the DJ voice; weave in what the listener asked for without reading the request back verbatim. It airs over the track's opening seconds, so write it in the present tense — never "next" or "coming up". ${dj.lengthPhrase('intro')}`),
    } : {}),
  }));
  try {
    return await djObject({
      system: requestSystem(),
      prompt: JSON.stringify({ candidates: [...seen.values()] }, null, 2)
        + `\n\n${isNamedRequester(requester) ? `Listener "${requester}" asked` : 'An unnamed listener asked'}: "${text}". The id you returned (${badId ?? 'none'}) matches none of the candidates above. Choose the best candidate id from the list for this request, and write "ack"${wantIntro ? ' and "intro"' : ''} to match.`,
      schema,
      temperature: 0.3,
      kind: 'djAgentRequestRepick',
    });
  } catch {
    return null;
  }
}

// `ctx` / `rankTarget` are carried only for the artist-guard's pool rescue
// (#1187) — the agent's own run needs neither. They're the same values
// runTrackEvent hands the ordinary pool fallback, so a rescued pick is built
// from exactly the pool a failed agent run would have produced.
async function pickViaAgent(queue, ctx, { wantLink, audioWaypoint = null, current = null, showAt = null, rankTarget = null, linkAirAt = null }: { wantLink: boolean; audioWaypoint?: number[] | null; current?: any; showAt?: Date | null; rankTarget?: { bpm: number | null; key: string | null } | null; linkAirAt?: Date | null }): Promise<boolean> {
  await library.load();
  const stats = library.stats();
  // Sized off the MIRROR, not `stats.total` (TAGGED tracks only) — see the same
  // note in music/picker.ts. Both paths must agree on how big the library is.
  const librarySize = stats.mirrorTotal || stats.total;
  const windows = recencyWindowsForLibrary(stats.distinctArtists, librarySize);
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
      try {
        const r = await subsonic.resolveGenreName(g);
        const warning = genreResolutionWarningOnce(g, r);
        if (warning) queue.log('picker', `Show "${activeShow?.name ?? 'auto'}": ${warning}`);
        if (r) resolved.push(r);
      } catch {}
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
  // Same coverage gate, one dimension further out: vocal ranges come from the
  // OPT-IN heavy analyzer, so "no track has been measured" is the norm rather
  // than the exception, and a hard lock would empty every tool for the whole
  // show. Counted lazily — only a show that actually pins vocal steering pays
  // for the query.
  const vocalLock = strict && activeShow?.vocals && library.vocalAnalyzedCount() > 0
    ? (activeShow.vocals as VocalMode)
    : null;

  // Count-based HARD no-repeat guard: the last N distinct plays can't re-air,
  // and (unlike recentIds/recentKeys above) this survives the tool-level
  // starvation cascade. A resolved strict playlist is its own catalogue, so
  // clamp to its real identity count using the same resolved genre lock as the
  // tools; 0 leaves the relaxable window in charge.
  const effN = effectiveShowNoRepeatWindow(
    settings.get().llm?.noRepeatWindow ?? 0,
    librarySize,
    {
      show: activeShow,
      playlistTracks,
      excludedIds,
      resolvedGenres: genreLock ?? [],
    },
  );
  const { ids: hardRecentIds, keys: hardRecentKeys } = queue.recentlyPlayedByCount(effN);
  // A pinned anchor that resolves to nothing (deleted/recreated playlist →
  // stale id, or a Navidrome error — resolveShowPlaylistPool swallows both)
  // silently un-anchors the show: no lock, no showPlaylistTracks tool. Say so,
  // loudly — a strict show playing 100% off-playlist with zero log output is
  // undiagnosable from the operator's side.
  if (activeShow?.playlistIds?.length && !playlistPool) {
    queue.log('picker', `show "${activeShow.name}" pins ${activeShow.playlistIds.length} playlist(s) but none resolved to tracks — anchor ignored${activeShow.playlistStrict ? ' (STRICT toggle has no effect)' : ''}. Stale playlist id (deleted/recreated in Navidrome?) or a Navidrome error; re-select the playlists in the show editor.`);
  }

  // One scope value carries every constraint this pick runs under, and travels
  // to the discovery tools without being unpacked on the way (see PickerRunArgs
  // in dj-agent/agents.ts for why that matters).
  const scope = pickerScope({
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
    vocalLock,
    playlistLock,
    playlistTracks,
    excludedIds,
  });

  const run = await pickerAgent.run({
    messages: session.windowMessages(),
    scope,
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
    const repicked = await repickFromSeen({ seen: extras.seen, badId: object?.id ?? null, showAt, playlistResolved: !!playlistTracks?.length });
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
    //
    // `cause` separates the three ways this lands (#1247) — most usefully the
    // zero-candidate run, where the model's answer is a symptom of an index that
    // couldn't answer rather than a model that couldn't choose. Classification
    // lives in util/pick-seed.ts, never inline.
    const failure = classifyPickFailure({
      pickedId: object?.id ?? null,
      seedId: current?.id ?? null,
      candidates: extras.seen.size,
      // Real discovery calls only (flattenToolCalls drops the synthetic
      // `done`), so a zero here means the model never explored — which must
      // NOT ride the no-candidates breaker exemption.
      toolCalls: toolCalls.length,
    });
    logEvent('pick.rejected', {
      agent: 'pick', id: object?.id ?? null, candidates: extras.seen.size, steps, toolCalls,
      cause: failure.kind,
    });
    // The verdict rides ON the error so the caller's catch can tell a model that
    // can't drive the harness from tools that had nothing to answer from —
    // only the first is what the circuit breaker exists to catch.
    throw Object.assign(new Error(failure.message), { pickFailure: failure });
  }

  // Back-to-back artist guard (#1124). The discovery tools return a tight
  // cluster around the current track — frequently a run of the SAME artist — and
  // the agent path carries no recentArtists/maxPerArtist filter, because an
  // artist strip inside the tools gutted the similarity pool to ~1 survivor on
  // niche catalogues (#618). So variety is enforced at the point of choice: if
  // the pick repeats the on-air artist and the run surfaced any other-artist
  // candidate, re-pick from just those (a constrained djObject over the run's
  // own `seen`, so it still reasons about flow and writes a coherent link).
  //
  // When that isn't possible, do NOT relax yet (#1187). `seen` is the RUN's view,
  // not the library's — tracksLikeThis answering with eight tracks by the on-air
  // artist while no other tool contributed leaves it single-artist on a 50k
  // catalogue, and reading that as "no alternative exists" is the false negative
  // that put the repeats back on air. Ask the fallback pool for a pick that hard-
  // blocks this artist (so it can't never-starve back to the one we're avoiding)
  // and allow the repeat only if even that comes back empty — logged with the
  // candidate count so "no alternative existed" stays distinguishable from a bug.
  //
  // Both sides of the comparison, and the alternative set, are keyed on the LEAD
  // artist (#1251), so "Marvin Gaye & Tammi Terrell" can't walk past a guard on
  // "Marvin Gaye". The alternatives also step around the artists of the last few
  // plays, because a re-pick that knows only the on-air artist keeps returning to
  // whoever ranks next-highest — the every-other-slot repeat this guard exists
  // to prevent.
  //
  // #1406 widened the ENTRY condition to that same window. Until then it only
  // narrowed the re-pick pool, so the guard never fired on a pick three slots
  // after the same artist and the window was never consulted — every occurrence
  // legal, and the same artist across a whole morning show. The two causes are
  // escalated differently on purpose (see below): back-to-back is a fault worth
  // a pool rescue, spacing is a preference that yields to the run.
  const varietyWindow = settings.get().llm?.artistVarietyWindow ?? ARTIST_VARIETY_WINDOW;
  const guarded = await runArtistGuard<any>({
    song, object, current,
    seen: extras.seen,
    // Every queue read stays here; the policy module is handed values only.
    recentRoots: queue.neighbourArtistRoots(varietyWindow),
    window: varietyWindow,
    repick: (alt, reason) => repickFromSeen({
      seen: alt, badId: null, showAt,
      playlistResolved: !!playlistTracks?.length,
      reason,
    }),
    poolRescue: (avoidArtist) => pickViaPool(
      queue, ctx, { wantLink, current, showAt }, rankTarget, audioWaypoint,
      { avoidArtist },
    ),
    log: (line) => queue.log('picker', line),
    logEvent,
  });
  // The pool rescue enqueues, links and records its own session turn, so a
  // rescued slot is a filled slot — runTrackEvent must treat it as done.
  if (guarded.kind === 'rescued') return true;
  if (guarded.kind === 'repicked') {
    object = guarded.object;
    song = guarded.song;
  }

  // The picker has seen private selection context. Only after its final choice
  // do we invoke the isolated listener-facing writer with safe prompt data.
  let rawLink = '';
  if (wantLink && current) {
    try {
      rawLink = await dj.generateLink({
        previous: current, current: song, context: linkAirContext(ctx, linkAirAt),
        clockIsAirTime: !!linkAirAt, persona: session.onAirPersona(),
        recap: queue.getDjRecap(), recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
        lastLink: queue.getLastLinkText(),
      });
    } catch (err: any) {
      queue.log('error', `DJ link failed: ${err.message}`);
    }
  }
  const say = dropEchoedLink(trimLinkToIntro(rawLink, song), queue) || '';
  const link = say || null;
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
  const queued = await enqueuePick(queue, song, object.reason, 'agent', link, current, { sweep, washout, blend, dissolve, chop, loop }, { linkClockAt: linkAirAt });
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

// The link's context with the clock stepped forward to `airAt`, the moment the
// link actually AIRS. ctx resolved at showAt is right for show IDENTITY but its
// clock runs PICK_SHOW_LOOKAHEAD_SEC fast, and every pick-attached link spoke
// that padded time — "Local time eight fifty" logged at 08:48 (#1282). So the
// same identity/clock split runPickCycle's handoff makes: show/mood/festival
// stay on showAt, only the clock-derived fields move to air time. `isDark` rides
// over from ctx — it comes from the weather fetch, and a two-minute shift can't
// flip it.
//
// `airAt` null means the air moment isn't forecastable well enough to speak (no
// look-ahead, or too little runway — #1314): ctx comes back untouched and the
// caller passes clockIsAirTime false, withholding the "Local time" line from the
// prompt entirely rather than showing a time the model must be trusted not to
// use.
function linkAirContext(ctx: any, airAt: Date | null) {
  if (!airAt || !ctx) return ctx;
  const clock: any = getClockContext(airAt);
  if (typeof ctx.clock?.isDark === 'boolean') clock.isDark = ctx.clock.isDark;
  return { ...ctx, at: airAt.toISOString(), date: getDateContext(airAt), clock, time: getTimeContext(airAt) };
}

// Returns 'queued' when a pick was actually enqueued, 'empty' when the pool
// produced none, 'collision' when its pick deduped against something already
// queued. The final fallback ignores the answer (nothing is left to try), but
// the artist-guard rescue in pickViaAgent needs the distinction: any non-queued
// answer sends the guard back to its own same-artist pick, and only 'empty'
// means the pool truly held no other artist — the relaxation event says which
// (#1187).
async function pickViaPool(queue, ctx, { wantLink, current, showAt = null }: { wantLink: boolean; current?: any; showAt?: Date | null }, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, opts: { avoidArtist?: string | null } = {}): Promise<'queued' | 'empty' | 'collision'> {
  // A DJ-mode mini-run (feature 4) anchors the pool re-rank to the run's
  // tempo/key target instead of the current track. null → today's behaviour.
  // A sonic journey (Phase 2) additionally anchors the audio-KNN source to the
  // run's current waypoint vector, drifting the pool toward the destination.
  const result = await picker.pickViaPool(queue, ctx, rankTarget, audioWaypoint, opts);
  if (!result) {
    queue.log('picker', 'pool produced no pick');
    return 'empty';
  }
  // Build the between-track link BEFORE enqueueing so it can ride on the queued
  // item and air when the pick starts. It back-announces the track on-air right
  // now (`current`) and leads into the pick — because by the time it airs,
  // `current` will have just ended and the pick will be starting (#189).
  let link: string | null = null;
  // Resolved HERE rather than up in runTrackEvent: the pick call above has
  // already spent part of the runway, and linkClockAt reads the live clock, so
  // asking now is the most honest the forecast can be on this path (#1314).
  const airAt = linkClockAt(showAt, Date.now());
  if (wantLink && current) {
    try {
      link = await dj.generateLink({
        // ctx with the clock stepped to the link's air moment — showAt's own
        // clock carries the show-attribution padding and ran two minutes fast
        // on air (#1282). Only with the look-ahead resolved AND enough runway
        // left for it to hold may the link speak the clock at all (issue #864:
        // generation-time clocks aired a track late; #1314: forecast clocks
        // aired a filler track early).
        previous: current, current: result.song, context: linkAirContext(ctx, airAt),
        clockIsAirTime: !!airAt,
        // Name the speaker explicitly. Left unset, scripts.generateLink falls
        // back to getEffectivePersona() on the wall clock, which disagrees with
        // the session inside the look-ahead window — the incoming DJ's line
        // written in the outgoing DJ's voice.
        persona: session.onAirPersona(),
        recap: queue.getDjRecap(),
        recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
        lastLink: queue.getLastLinkText(),
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
  //
  // The clock stamp is what linkClockDrifted (queue/pure.ts) drops a link on
  // when the real seam lands far from the forecast — so it must only be set
  // when a clock was actually OFFERED. With the station clock off
  // (broadcast/clock-policy.ts) generateLink wrote this line under a flat ban
  // and it cannot contain a time, so a drift drop would cost the operator the
  // whole link to protect a clock that isn't in it. Gated on the STAMP rather
  // than on `airAt` itself, so linkAirContext still steps the daypart tags to
  // air time — "after dark" stays accurate even when the numerals are withheld.
  const queued = await enqueuePick(queue, result.song, result.reason, result.source || 'pool', link, current, fx, {
    linkClockAt: linkClockStampFor(airAt, speakClockAllowed()),
  });
  // Even the pool landed on an already-queued track (a tiny library whose pool
  // collapsed to recents). Skip the session turn and let auto.m3u backstop the
  // slot — the next track-start re-triggers runTrackEvent for a fresh pick.
  if (queued === -1) return 'collision';
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
  return 'queued';
}

// Called by the queue watcher when an autonomous track starts and the queue is
// empty. Posts the event to the session, then picks the next track (and an
// optional between-track link) via the agent, falling back to the pool.
// `ctx` is the pick's context — near a show boundary the queue watcher hands
// in a look-ahead snapshot (getFullContext at the pick's expected airtime) plus
// the matching `showAt` clock, so both pick paths follow the show that will
// actually be on air when the pick plays. `showAt` null → resolve at now,
// exactly the pre-look-ahead behaviour.
// `predecessor`/`prior` (feature: pair-aware transitions): when the pick is
// fired by the pair-drain deadline, the track it will FOLLOW is the held
// queue item — not queue.current, which is one track earlier at that moment.
// The override flows everywhere the predecessor matters: the event text, the
// mini-run anchor, the pool re-rank, and the link's back-announce target
// (linkPrev). `prior` is the track before the predecessor (the on-air track
// at deadline time). Omitted → queue.current/history, today's behaviour.
export async function runTrackEvent(queue, ctx, { wantLink, showAt = null, predecessor = null, prior = null }: {
  wantLink: boolean;
  showAt?: Date | null;
  predecessor?: any | null;
  prior?: any | null;
}) {
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
    // Station voice off (settings.tts.enabled) → still pick, never link. The
    // agent path's event message then orders silence (`say` stays in the
    // schema but nullable, and a disobedient line is dropped at the
    // `wantLink && say` guard), and the pool path skips its generateLink call
    // outright — so no link is written, rendered or aired, and the pick costs
    // exactly what a "stay silent" pick has always cost.
    wantLink = wantLink && !cheap && autoVoiceAllowed();

    const current = predecessor ?? queue.current?.track ?? null;
    const previous = predecessor ? (prior ?? null) : (queue.history[0]?.track ?? null);
    const djMode = !!settings.getEffectivePersona()?.djMode;

    // Feature 4 + Phase 2 — advance/maybe-start a mini-run; get the tempo/key
    // re-rank target and (when the audio index supports it) a sonic-journey
    // waypoint for the pool's audio anchor.
    const { rankTarget, audioWaypoint } = advanceRun(djMode, current);
    const inRun = runActive();

    // Selection steering stays in this prompt, but it no longer shares a
    // response schema with listener speech.
    const runClause = inRun
      ? ` You're mid-run — keep the energy moving in the same direction (a touch ${energyForDaypart().speed >= 1 ? 'brisker' : 'mellower'}).`
      : '';
    // Gated on the waypoint itself, not inRun: on a run's final pick the run
    // state is already cleared (advanceRun) but the last waypoint — the
    // destination itself — is still the one to land on.
    const journeyClause = audioWaypoint && audioWaypoint.length
      ? ' A sonic journey is active: call tracksTowardJourney and lean toward one of its tracks — each carries the sound a step toward where this arc is heading. If it comes back thin, pick via the library mood/genre/audio tools and keep the energy heading the same way. Never mention the journey on air.'
      : '';
    // Resolve the expected air moment after selection uses part of the runway.
    // It travels only to the isolated writer after a track is final.
    const linkAirAt = speakClockAllowed() ? linkClockAt(showAt, Date.now()) : null;
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
    // Compact on purpose: the full per-effect coaching is effectsGuidance()
    // in the system prompt — this nudge only keeps the vocabulary and the
    // deliberate-choice reminder fresh in the newest turn. Re-describing all
    // seven effects here tripled the coaching per pick (system + event +
    // schema description).
    const effectClause = settings.effectsActive()
      ? ` Set "transition" by what THIS moment needs, per the TRANSITION EFFECTS guidance — "washout"/"loop" end your pick, "sweep"/"dissolve"/"chop" resolve a clash, "blend" only for an exceptionally locked pair, "normal" otherwise. Vary your craft: never the same transition three picks running, and if your last pick used an effect, lean "normal" now unless the moment clearly calls again.${historyNote}`
      : '';
    // The turn is split in two: `text` is the factual event the booth log shows
    // the operator, `meta.promptSuffix` carries the model-facing coaching
    // clauses. windowMessages() re-joins them, so the model sees one message and
    // the operator stops reading prompt engineering in the booth log.
    //
    // Listener favourites (#991) ride the EVENT turn, not the system prompt:
    // they change as likes land, and a system prompt that re-renders per call
    // breaks the byte-stable prefix automatic prompt caching keys on.
    // windowMessages keeps only the latest pick event, so the list never
    // multiplies across the window. Mirrored by the pool picker's listener-liked
    // source so both paths lean the same way — a lean, never a lock.
    const favClause = likes.favouritesClause(settings.get()?.likes);
    // Exploration nudge (ε-greedy seed break, music/airing.ts): every pick
    // seeding discovery from the on-air track is a random walk that never
    // leaves its similarity cluster, so a fraction of picks steer the round
    // toward the unaired shelf instead. Deliberately carries NO track id — a
    // raw id in the event message is the #1247 seed-echo trap (an id no tool
    // returned can only be a discarded pick); the deepCuts tool is the safe
    // carrier of concrete candidates. Skipped mid-run/journey (they own the
    // direction) and on strict-playlist shows (deep cuts are almost surely
    // off-playlist, so the call would be spent on an emptyResult).
    const exploreClause = !inRun && !audioWaypoint && !ctx?.activeShow?.playlistStrict
      && Math.random() < EXPLORE_SEED_PROBABILITY
      ? ' Exploration nudge: include deepCuts in your discovery round this pick — surface something the station has never aired (or hasn\'t in weeks) and give it real consideration when it can fit the moment.'
      : '';
    const eventText = `Now playing "${current?.title}" by ${current?.artist}`
      + (current?.id ? ` [id: ${current.id}]` : '')
      + (previous ? ` (after "${previous.title}" by ${previous.artist})` : '')
      + '. Pick the track to play next.';
    const promptSuffix = `${favClause}${effectClause}${runClause}${journeyClause}${exploreClause}`;
    session.appendTurn({
      role: 'event', kind: 'pick', text: eventText,
      meta: promptSuffix ? { promptSuffix } : {},
    });

    // `!cheap`: in the soft budget tier we skip the multi-step agent tool-loop
    // and go straight to the one-call pool picker below to stretch the budget.
    if (settings.get().llm?.pickerAgent && !cheap && !breakerOpen()) {
      try {
        // Passed only to the post-selection writer, and only when the station
        // clock policy permits it.
        const queued = await pickViaAgent(queue, ctx, {
          wantLink, audioWaypoint, current, showAt, rankTarget,
          linkAirAt,
        });
        breakerSuccess();
        if (queued) return;
        // The agent produced a valid pick but it was already queued/on-air, so
        // push() dropped it. The agent itself is healthy — don't trip the
        // breaker; fall through to the pool for a fresh pick (auto.m3u backstops
        // if even the pool can only find an already-queued track).
        queue.log('picker', 'agent pick already queued — falling back to pool');
      } catch (err) {
        // A run the agent DROVE correctly but couldn't answer from — every
        // discovery call came back empty — is a library-coverage problem, not a
        // model one (#1247). Counting it would open the breaker after three
        // tracks, disable the session-aware picker for 10 minutes, and point the
        // operator at "switch model", which repairs nothing. Same carve-out, and
        // same reasoning, as the already-queued case just above; the pool
        // fallback below still fills the slot either way.
        const failure = (err as any)?.pickFailure as PickFailure | undefined;
        if (failure && !failure.countsAgainstBreaker) {
          queue.log('picker', `${failure.message} — falling back to pool`);
        } else {
          queue.log('error', `DJ agent pick failed: ${err.message} — falling back to pool`);
          breakerFailure(queue);
        }
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
    // Name the listener in the tail ONLY when there is a real name. The
    // system prompt now tells the agent to greet whoever the tail names
    // (REQUESTER_GREETING_CLAUSE), so handing it the ledger stand-in 'anon'
    // would put that word on air as a name (#1347).
    const tail = (isNamedRequester(requester)
      ? `The request to resolve now — listener "${requester}" asks: "${text}"`
      : `The request to resolve now — an unnamed listener asks: "${text}"`)
      + (cur ? ` (currently playing "${cur.title}" by ${cur.artist}${cur.id ? ` [id: ${cur.id}]` : ''})` : '');
    const messages = session.windowMessages();
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') last.content += '\n' + tail;
    else messages.push({ role: 'user', content: tail });

    // A request runs with recency only — no show locks. An explicit listener
    // ask wins over the show's strict filters, which is why the scope stops
    // here rather than being built from the active show.
    const run = await requestAgent.run({
      messages,
      scope: pickerScope({ recentIds }),
    });
    const { toolCalls, extras } = run;
    // Reassigned when the unknown-id salvage below (repickRequestFromSeen)
    // lands a corrective re-pick — same let-after-destructure shape
    // pickViaAgent uses for the identical reason.
    let object = run.object;

    // Chat escape (C1): an explicit kind:"chat" WITH a null id means this
    // wasn't a music request — answer in persona, queue nothing, skip the
    // cascade. The `kind` half is load-bearing: a null id ALONE is also what an
    // omitted id looks like once coerceModelPayload is done with it, so a weak
    // model forgetting the field would otherwise turn a real music request into
    // "nothing plays". Without kind:"chat" this falls through to the repick
    // salvage and the stateless cascade, so the listener still gets music.
    //
    // Echo guard (A2): the ack is the model's own free text, generated from a
    // message that may carry an injected script, so it is guarded like the
    // cascade's chat branch. Not just display — this text becomes a `dj`-role
    // session turn later `windowMessages()` calls condition on, so an unguarded
    // echo poisons future generations even though it never reaches tts.speak.
    if (object?.kind === 'chat' && !object?.id && typeof object?.ack === 'string' && object.ack.trim()) {
      const screened = screenAck(object.ack, text, 'Heard you loud and clear.');
      if (screened.guard) queue.log('request-guard', `agent chat ack echoed request text — replaced`);
      session.appendTurn({ role: 'dj', kind: 'request', text: screened.ack, meta: { requester, toolCalls } });
      return { ack: screened.ack, track: null, introScript: null, guard: screened.guard };
    }

    let song = object?.id ? extras.seen.get(object.id) : null;
    // Near-miss repair, same as the pick path: an unambiguous prefix /
    // clear-winner edit-distance match against the run's own candidates
    // rescues an id the model transcribed imperfectly (#939).
    if (!song && object?.id && extras.seen.size) {
      const fixed = nearestId(object.id, extras.seen.keys());
      if (fixed) {
        logEvent('pick.repaired', { agent: 'request', from: object.id, to: fixed });
        song = extras.seen.get(fixed);
      }
    }
    // Corrective re-pick (D1), same as the pick path's stage 2: the model
    // fabricated an id outright while its `seen` map held real candidates.
    // One djObject call constrained to that set (repickRequestFromSeen,
    // above) salvages the run instead of discarding it wholesale — the
    // caller's stateless matcher cascade is still the fallback when this
    // misses too (empty seen, or the re-pick call itself fails).
    if (!song && extras.seen.size) {
      const repicked = await repickRequestFromSeen({ seen: extras.seen, badId: object?.id ?? null, requester, text });
      if (repicked) {
        logEvent('pick.repicked', { agent: 'request', from: object?.id ?? null, to: repicked.id, candidates: extras.seen.size });
        queue.log('request', `agent returned unknown id "${object?.id}" — re-picked "${repicked.id}" from its own candidates`);
        object = repicked;
        song = extras.seen.get(repicked.id);
      }
    }
    if (!song) {
      // idInSessionWindow (D2 telemetry): does the bad id appear verbatim
      // anywhere in the EXACT window this run saw (the local `messages` array
      // built above, not a fresh session.windowMessages() call — a concurrent
      // request's session turn can shift the window between this run and now,
      // which would corrupt the diagnostic in either direction)? A hit
      // corroborates the copy-not-fabricate hypothesis behind
      // repickRequestFromSeen (the same hallucinated id recurring hours apart,
      // live — see its comment); a miss doesn't rule that out, it just narrows
      // what's worth chasing next.
      const windowText = messages.map((m: any) => String(m.content ?? '')).join('\n');
      logEvent('pick.rejected', {
        agent: 'request', id: object?.id ?? null, candidates: extras.seen.size, toolCalls,
        idInSessionWindow: !!(object?.id && windowText.includes(object.id)),
      });
      throw new Error(`request agent returned unknown id ${object?.id}`);
    }

    // Repeat cooldown (B6) — mirrors the cascade path. `refused` is what tells
    // the caller nothing was queued: it returns a track (the one it declined,
    // so the ack and the operator log can name it), and without the flag the
    // route reported a queue position for a play that will never happen.
    const cdMin = Number((settings.get() as any)?.requests?.repeatCooldownMin ?? 120);
    if (cdMin > 0 && queue.recentlyPlayedIds(cdMin / 60).has(song.id)) {
      const cdAck = queue.cooldownAck(song.id, song.title);
      session.appendTurn({ role: 'dj', kind: 'request', text: cdAck, meta: { trackId: song.id, requester, toolCalls } });
      return { ack: cdAck, track: { title: song.title, artist: song.artist, id: song.id }, introScript: null, guard: null, refused: 'cooldown' };
    }

    // Station voice off (settings.tts.enabled) → no intro. requestSchema()
    // already dropped the field from the agent's contract, so normally there
    // is nothing here to discard — this guard covers the switch flipping
    // mid-run (the schema resolved before the flip) and a model inventing the
    // field anyway. Every read below keys off this one binding, and the
    // session then records the ack rather than a line that never aired.
    // Echo guard (A2): a script that reads the request back is regenerated
    // with the request text withheld — it can't echo what it never saw.
    const rawIntro = autoVoiceAllowed() && typeof object.intro === 'string' ? object.intro.trim() : '';
    const guarded = await guardIntro(rawIntro || null, text, () => dj.generateIntro({
      track: trackFields(song), context: null, requestedBy: requester,
    }));
    if (guarded.guard) queue.log('request-guard', `agent intro echoed request text — ${guarded.guard}`);
    const intro = guarded.script || '';
    // The personalised line is screenAck's FALLBACK rather than a `||` on the
    // return below: screenAck already substitutes for an empty ack, so `ack`
    // is never falsy and a downstream `||` is unreachable. Threading it in here
    // means the listener gets the named line in both cases the fallback covers
    // — the model wrote nothing, and the model echoed their own text back.
    const screened = screenAck(object.ack, text, isNamedRequester(requester)
      ? `Coming up for you, ${requester}.`
      : 'Coming up for you.');
    if (screened.guard) queue.log('request-guard', `agent ack echoed request text — replaced`);
    const ack = screened.ack;
    // Both guards can fire on one request (the model echoed in the ack AND in
    // the intro) — join rather than let one verdict hide the other.
    const guardVerdict = [guarded.guard, screened.guard].filter(Boolean).join('+') || null;
    const pos = await queue.push({
      track: trackFields(song),
      requestedBy: requester,
      intent: 'listener request',
      introScript: intro || null,
      introKind: 'dj-speak',
      // Voice the intro as whoever wrote it (see the pool-pick push above).
      introPersona: session.onAirPersona(),
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
      const dupAck = queue.dedupAck(song.id);
      session.appendTurn({
        role: 'dj', kind: 'request',
        text: dupAck,
        meta: { trackId: song.id, requester, toolCalls },
      });
      // The echo guards already ran above even though this pick turned out to
      // be a duplicate — surface the verdict rather than losing it. `refused`
      // for the same reason as the cooldown branch: nothing was queued here.
      return { ack: dupAck, track: { title: song.title, artist: song.artist, id: song.id }, introScript: null, guard: guardVerdict, refused: 'already-queued' };
    }
    session.appendTurn({
      role: 'dj', kind: 'request',
      // `ack` is guaranteed non-empty (screenAck substitutes), so it always
      // wins over the title fallback when there's no intro — the fallback is
      // kept only as a guard against a future edit making `ack` optional.
      text: intro || ack || `Queued "${song.title}".`,
      meta: { trackId: song.id, requester, toolCalls },
    });

    return {
      ack,
      track: { title: song.title, artist: song.artist, id: song.id },
      introScript: intro || null,
      guard: guardVerdict,
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
// The two model calls are injectable for the same reason artist-guard's are:
// the thing worth pinning here is the WIRING — which memory each side of the
// mic-pass is handed — and that is only observable at the generator boundary.
// Production passes nothing and gets the real ones.
export interface HandoffDeps {
  generateSignoff?: typeof dj.generateSignoff;
  generateHandoffGreeting?: typeof dj.generateHandoffGreeting;
}

export async function runPersonaHandoff(queue: any, ctx: any, deps: HandoffDeps = {}): Promise<void> {
  const generateSignoff = deps.generateSignoff ?? dj.generateSignoff;
  const generateHandoffGreeting = deps.generateHandoffGreeting ?? dj.generateHandoffGreeting;
  const pending = session.pendingHandoff();
  if (!pending) return;

  // Nobody listening → the mic-pass moment has passed; don't stack a stale
  // handoff for later. Budget: treated as an optional segment (muted in soft
  // and hard tiers, policy in dj-budget.ts). Either way, mark aired so it
  // doesn't retry — a handoff fires at most ~once an hour and is cheap to loosen.
  // Station voice off (settings.tts.enabled) is treated the same way: mark it
  // aired so a stale mic-pass isn't queued up waiting for the switch to flip.
  if (!autoVoiceAllowed() || !djCallsAllowed() || !budget.optionalSegmentsAllowed()) {
    session.markHandoffAired();
    return;
  }

  // Expired: the roll happened, but no track boundary came along in time to
  // air it. The hourly cron rolls without airing (scheduler.rollSessionNow's
  // airHandoff=false), so with nobody listening — or across one very long
  // track — a pending mic-pass can outlive the moment it describes. A sign-off
  // names the show that just ended and a greeting opens the one that started;
  // airing that an hour late is worse than staying quiet, the same call
  // airPendingVoice makes for a stale ident.
  if (session.handoffIsStale(pending.at, Date.now(), HANDOFF_MAX_AGE_MS)) {
    queue.log('scheduler', `Dropped pending mic-pass from ${pending.personaName || 'the previous DJ'} — no track boundary in time`);
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
    // The sign-off closes the show that just ENDED, but maybeRoll has already
    // hard-rolled by the time this runs — the live session holds nothing but its
    // own scenario turn, so reading it would strip the outgoing DJ of the hour
    // it is signing off from. Its memory is the ARCHIVED session's
    // (session.priorPromptMemory). The greeting keeps the fresh session's empty
    // memory on purpose: not inheriting the outgoing topic is the point of #1479.
    const outgoingRecap = queue.getDjRecap({ prior: true });
    const outgoingOpeners = queue.getRecentOpeners(6, { prior: true });
    const recentOpeners = queue.getRecentOpeners();
    let aired = false;

    // 1. Sign-off, in the OUTGOING persona's voice. Tag the session turn with
    //    the outgoing persona's id + name — that id is what keeps the line out
    //    of the new session's prompt memory (broadcast/prompt-memory.ts) and
    //    what makes session.windowMessages() name the real speaker, so the
    //    incoming DJ never reads the sign-off as its own words.
    let signoffText: string | null = null;
    try {
      signoffText = await generateSignoff({
        personaOut, personaIn, showIn,
        context: ctx, recap: outgoingRecap, recentOpeners: outgoingOpeners,
      });
      await queue.announce(signoffText, 'handoff', {
        persona: personaOut, meta: { personaId: personaOut.id, personaName: personaOut.name },
      });
      aired = true;
    } catch (err: any) {
      queue.log('error', `Handoff sign-off failed: ${err.message}`);
      signoffText = null;
    }

    // 2. Greeting, in the INCOMING persona's voice. It acknowledges the
    //    outgoing presenter by name but does not ingest their raw sign-off:
    //    that line is an unbounded topic bridge across the session boundary.
    //    Stands alone if the sign-off didn't air.
    //    On a programme show the greeting doubles as the episode's intro, so
    //    the producer's angle (planned before this runs — see the call sites)
    //    rides along; the standalone intro is then skipped (programme.ts).
    try {
      const greeting = await generateHandoffGreeting({
        personaIn, personaOut, showIn,
        episodeAngle: session.getProgramme()?.plan?.angle || null,
        context: ctx, recap: queue.getDjRecap(), recentOpeners,
      });
      await queue.announce(greeting, 'handoff', {
        persona: personaIn, meta: { personaId: personaIn.id, personaName: personaIn.name },
      });
      aired = true;
    } catch (err: any) {
      queue.log('error', `Handoff greeting failed: ${err.message}`);
    }

    if (aired) {
      logEvent('dj.handoff', { from: personaOut.name, to: personaIn.name, show: showIn });
    }
  });
}
