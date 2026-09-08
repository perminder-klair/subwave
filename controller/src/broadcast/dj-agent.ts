// Session DJ agent — the conversational brain that runs over a stream session.
// Owns the pick and request runs; the pieces they're built from live in
// ./dj-agent/ (runs, schemas, breaker, agents, enqueue) and are re-exported
// below, so `from './dj-agent.js'` still reaches the whole surface.
//
// The system posts events into the session ("a track started, pick the next
// one"; "a listener requested X"); this hands the session chat window to a
// tool-loop agent that explores the library and decides. Its output is enqueued
// and appended back as turns, so the next event sees what the DJ just did.
//
// Gated on `settings.llm.pickerAgent`. Off, or on any agent failure, this falls
// back to the stateless pool picker + link generator so a pick is never missed.
// Either way the session is updated.

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
import { showNoRepeatGuard } from '../music/show-recency.js';
import { EXPLORE_SEED_PROBABILITY } from '../music/airing.js';
import { ARTIST_VARIETY_WINDOW, runArtistGuard } from './dj-agent/artist-guard.js';
import { runAlbumGuard } from './dj-agent/album-guard.js';
import { albumKeyFor } from '../music/album-facts.js';
import { hasEraBound, genreResolutionWarningOnce, type VocalMode } from '../music/show-filter.js';
import type { TransitionEffect } from '../settings/vocab.js';
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
import { buildLinkClause } from './dj-agent/link-clause.js';
import { announceLine } from './announce-line.js';
import { guardIntro, screenAck, isNamedRequester } from '../util/request-guard.js';
import * as likes from './likes.js';
import { classifyPickFailure, type PickFailure } from '../util/pick-seed.js';

// Re-exported so every existing `from './dj-agent.js'` import keeps working,
// including scripts/llm-bench, which sits outside tsconfig's include.
export { runActive } from './dj-agent/runs.js';
export {
  PICK_SCHEMA, PICK_SCHEMA_NO_FX, pickSchema, pickSystem, requestSchema, requestSystem,
} from './dj-agent/schemas.js';
export { pickerAgent, requestAgent } from './dj-agent/agents.js';

// Stage-2 salvage for an agent run whose final id no tool surfaced: one
// djObject call over the run's OWN candidates (`seen`), id constrained to that
// set with z.enum (a decode-time grammar on local models, a Zod reject
// elsewhere). Returns a pick object or null; never throws.
// `reason` replaces the default "you returned a bad id" framing — the artist
// and album guards reuse this re-pick on a VALID pick, where that wording
// would be false.
async function repickFromSeen({ seen, badId, wantLink, showAt = null, playlistResolved = true, reason = null }: { seen: Map<string, any>; badId: string | null; wantLink: boolean; showAt?: Date | null; playlistResolved?: boolean; reason?: string | null }) {
  const ids = [...seen.keys()];
  if (ids.length === 0) return null;
  const schema = modelTolerant(pickSchemaBase().extend({
    id: z.enum(ids as [string, ...string[]]).describe('the exact id of one candidate'),
  }));
  const why = reason
    ?? `You explored the library and then answered with ${badId ? `the id "${badId}", which matches none of the tracks your tools returned` : 'no usable track id'}. Only ids from the candidates above are real. Choose the best next track from them.`;
  try {
    return await djObject({
      // Same show snapshot and playlist-resolved gate as the failed run: a
      // tool-less salvage must not reinstate "call showPlaylistTracks first"
      // when no such tool exists here, nor resolve a different show than the
      // run whose candidates it re-picks from.
      system: pickSystem(showAt, playlistResolved),
      prompt: JSON.stringify({ candidates: [...seen.values()] }, null, 2)
        + `\n\n${why}`
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

// Request-flavoured corrective re-pick (D1): mirrors repickFromSeen, for when
// the request agent returns an id outside its own discovery trail. One djObject
// call constrained to the run's own candidates salvages the run instead of
// discarding it to the caller's stateless matcher cascade, which still runs
// when this misses. Reuses requestSystem()'s wording and the same
// autoVoiceAllowed() gate for `intro`. Never throws.
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
// (#1187) — the same values runTrackEvent hands the ordinary pool fallback, so
// a rescued pick comes from the pool a failed agent run would have produced.
async function pickViaAgent(queue, ctx, { wantLink, audioWaypoint = null, current = null, showAt = null, rankTarget = null, linkAirAt = null }: { wantLink: boolean; audioWaypoint?: number[] | null; current?: any; showAt?: Date | null; rankTarget?: { bpm: number | null; key: string | null } | null; linkAirAt?: Date | null }): Promise<boolean> {
  await library.load();
  const stats = library.stats();
  // Sized off the MIRROR, not `stats.total` (TAGGED tracks only) — see the same
  // note in music/picker.ts. Both paths must agree on how big the library is.
  const librarySize = stats.mirrorTotal || stats.total;
  const windows = recencyWindowsForLibrary(stats.distinctArtists, librarySize);
  // Track-recency window scales to the library's artist diversity. Artist
  // recency is deliberately NOT applied at the agent-tool layer (#618).
  const { ids: recentIds, keys: recentKeys } = queue.recentlyPlayed(windows.trackHours);
  // Queued-but-unaired ids belong in the RELAXABLE set — in-flight, not
  // recently played, so they must not tighten the hard guard.
  for (const id of queue.queuedIds()) recentIds.add(id);

  // Show playlist anchor, resolved at the pick's look-ahead moment (showAt) so
  // the anchor is the show that will be on air — the same clock as pickSystem's
  // brief and buildTools' locks. Strict → a hard lock intersecting every tool's
  // results; soft → tracks exposed via showPlaylistTracks, no lock.
  const activeShow = settings.resolveActiveShow(showAt ?? undefined);
  const playlistPool = activeShow ? await resolveShowPlaylistPool(activeShow) : null;
  const playlistLock = playlistPool && activeShow?.playlistStrict ? playlistPool.ids : null;
  const playlistTracks = playlistPool?.tracks ?? null;
  const excludedIds = activeShow ? await resolveExcludedPlaylistIds(activeShow) : null;

  // Strict music locks for the discovery tools (filtersStrict), resolved here
  // once off the same show snapshot as the playlist pool — async work the sync
  // buildTools can't do — so prompt-brief and tool-locks agree across a
  // boundary. Each lock is an any-of list (#929); locks AND across attributes.
  const strict = !!activeShow?.filtersStrict;
  // Genre free text → the library's exact tags, dropping any that don't resolve
  // (no genre lock rather than a starved-to-empty tool). Mirrors the pool path.
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
  // Mood / energy locks only bite when the tagger / analyzer has run: on an
  // untagged library a hard lock empties every tool for the whole show and
  // trips the breaker with a misleading "model can't handle tools" diagnosis.
  const hasMoodCoverage = Object.keys(stats.byMood ?? {}).length > 0;
  const hasEnergyCoverage = Object.keys(stats.byEnergy ?? {}).length > 0;
  const moodLock = strict && activeShow?.moods?.length && hasMoodCoverage ? activeShow.moods : null;
  const energyLock = strict && activeShow?.energies?.length && hasEnergyCoverage ? activeShow.energies : null;
  // Same coverage gate: vocal ranges come from the OPT-IN heavy analyzer, so
  // "nothing measured" is the norm. Counted lazily, so only a show that pins
  // vocal steering pays for the query.
  const vocalLock = strict && activeShow?.vocals && library.vocalAnalyzedCount() > 0
    ? (activeShow.vocals as VocalMode)
    : null;

  // The show's own minimum track length (#1573), resolved before the no-repeat
  // guard because that guard counts the rotation this floor has thinned.
  const minTrackSec = settings.effectiveMinTrackSec(activeShow);

  // Count-based HARD no-repeat guard: the last N distinct plays can't re-air,
  // and unlike recentIds/recentKeys this survives the tool-level starvation
  // cascade. A resolved strict playlist is its own catalogue, so clamp to its
  // real identity count; 0 leaves the relaxable window in charge.
  const effN = showNoRepeatGuard(
    settings.get().llm?.noRepeatWindow ?? 0,
    librarySize,
    {
      show: activeShow,
      playlistTracks,
      excludedIds,
      resolvedGenres: genreLock ?? [],
      minTrackSec,
    },
  ).window;
  const { ids: hardRecentIds, keys: hardRecentKeys } = queue.recentlyPlayedByCount(effN);
  // A pinned anchor that resolves to nothing (stale id, or a Navidrome error —
  // resolveShowPlaylistPool swallows both) silently un-anchors the show, which
  // is undiagnosable from the operator's side unless it is logged.
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
    // Registers the tracksTowardJourney tool, closed over the run's current
    // waypoint. The event text tells the agent to use it.
    audioWaypoint,
    genreLock,
    eraLock,
    moodLock,
    energyLock,
    vocalLock,
    // NOT gated on `strict`, unlike the five locks above: the twin of the
    // max-track-length cap, which every show gets regardless.
    minTrackSec,
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

  // The agent returned an id outside the candidate set it was shown. Two-stage
  // salvage before giving up on the run:
  //   1. Near-miss repair (#939) — nearestId only accepts an unambiguous
  //      prefix / clear-winner edit-distance match, so it can't misfire onto a
  //      different track. Free, no model call.
  //   2. Corrective re-pick — one djObject call constrained to the run's own
  //      ids, cheaper than the pool fallback plus a breaker increment for a run
  //      that did explore.
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
    // Both salvage stages missed. The trace still ends ok:true (the pool fills
    // the slot), so without this event the rejection is invisible to /debug and
    // agent health reads too high. Emitted inside the live trace.
    //
    // `cause` separates the three ways this lands (#1247); classification lives
    // in util/pick-seed.ts, never inline.
    const failure = classifyPickFailure({
      pickedId: object?.id ?? null,
      seedId: current?.id ?? null,
      candidates: extras.seen.size,
      // Real discovery calls only (the synthetic `done` is dropped), so zero
      // means the model never explored and must NOT ride the no-candidates
      // breaker exemption.
      toolCalls: toolCalls.length,
    });
    logEvent('pick.rejected', {
      agent: 'pick', id: object?.id ?? null, candidates: extras.seen.size, steps, toolCalls,
      cause: failure.kind,
    });
    // The verdict rides ON the error so the caller's catch can tell a model
    // that can't drive the harness (what the breaker catches) from tools that
    // had nothing to answer from.
    throw Object.assign(new Error(failure.message), { pickFailure: failure });
  }

  // Artist variety guard (#1124 / #1187 / #1251 / #1406), enforced at the point
  // of choice because the discovery tools carry no artist filter (#618). Policy
  // lives in dj-agent/artist-guard.ts; this is only the wiring. A run that
  // surfaces one artist is the RUN's view, not the library's, so back-to-back
  // escalates to a pool rescue that hard-blocks the artist before relaxing.
  const varietyWindow = settings.get().llm?.artistVarietyWindow ?? ARTIST_VARIETY_WINDOW;
  // Read once: the album guard below steps around the same neighbours, and two
  // reads of a live queue across two awaits could disagree.
  const neighbourRoots = queue.neighbourArtistRoots(varietyWindow);
  const guarded = await runArtistGuard<any>({
    song, object, current,
    seen: extras.seen,
    // Every queue read stays here; the policy module is handed values only.
    recentRoots: neighbourRoots,
    window: varietyWindow,
    repick: (alt, reason) => repickFromSeen({
      seen: alt, badId: null, wantLink, showAt,
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

  // Album cooldown (#1485 FR 3), at the same point of choice. Must run AFTER
  // the artist guard, on whatever pick it left standing: the artist guard knows
  // nothing about records and would revert an album re-pick straight back onto
  // a recent album. Nothing to do on a 'rescued' slot — that pick came from the
  // pool, which applies this cooldown itself. Skipped outright when off.
  const albumHours = Number(settings.get().picker?.albumHours) || 0;
  if (albumHours > 0) {
    const albumGuarded = await runAlbumGuard<any>({
      song, object,
      seen: extras.seen,
      recentAlbums: queue.recentAlbumKeys(albumHours),
      avoidArtistRoots: neighbourRoots,
      // `seen` values are the MODEL's projection and carry no compilation
      // flags, so the key resolves against the library through the same
      // resolver the pool path's filter uses.
      albumKeyOf: albumKeyFor,
      hours: albumHours,
      repick: (alt, reason) => repickFromSeen({
        seen: alt, badId: null, wantLink, showAt,
        playlistResolved: !!playlistTracks?.length,
        reason,
      }),
      log: (line) => queue.log('picker', line),
      logEvent,
    });
    if (albumGuarded.kind === 'repicked') {
      object = albumGuarded.object;
      song = albumGuarded.song;
    }
  }

  let rawSay = typeof object.say === 'string' ? object.say.trim() : '';
  // Announce mode: the model's `say` only signals "speak"; announce-line.ts
  // composes the wording and its alternation. Silence stays the model's call.
  // Resolved off the ON-AIR persona (whoever enqueuePick pins the line to), not
  // the wall-clock effective one — inside the handoff look-ahead they disagree.
  // An empty compose means no frame fits this persona or artist, and the
  // model's own line stands.
  const linkSpeaker = session.onAirPersona();
  if (rawSay && settings.announceLinks(linkSpeaker)) {
    const composed = announceLine(song.artist, linkSpeaker, { lastLine: queue.getLastLinkText() });
    if (composed) rawSay = composed;
  }
  // Both the trim and the echo guard run again at enqueuePick's chokepoint;
  // they run here so the session turn below records the line as it will air.
  const say = dropEchoedLink(trimLinkToIntro(rawSay, song), queue) || '';
  const link = (wantLink && say) ? say : null;
  const fxActive = settings.effectsActive();
  // A model can ignore the no-FX schema's field description, so log the discard
  // rather than dropping it silently — an effect in the LLM log that never airs
  // reads as a broken mixer.
  if (!fxActive && object.transition && object.transition !== 'normal') {
    queue.log('mix', `transition "${object.transition}" ignored (persona not in DJ mode)`);
  }
  // Per-effect operator switch (#1565). PICK_SCHEMA keeps the full enum
  // whatever the switches say — it is session-anchored, so narrowing it
  // mid-conversation would contradict the history in it — and the prompt names
  // what is off. A switched-off gesture is logged, not silently dropped.
  if (fxActive && object.transition && object.transition !== 'normal'
    && !settings.effectEnabled(object.transition as TransitionEffect)) {
    queue.log('mix', `transition "${object.transition}" ignored (switched off in settings)`);
  }
  const wants = (kind: TransitionEffect) =>
    fxActive && object.transition === kind && settings.effectEnabled(kind);
  const sweep = wants('sweep');
  const washout = wants('washout');
  const blend = wants('blend');
  const dissolve = wants('dissolve');
  const chop = wants('chop');
  const loop = wants('loop');
  // The link rides the pick so it airs as the pick starts, not immediately over
  // the on-air track (#189). `current` is stamped as its back-announce target
  // so the queue can drop the link if a request jumps ahead.
  const queued = await enqueuePick(queue, song, object.reason, 'agent', link, current, { sweep, washout, blend, dissolve, chop, loop }, { linkClockAt: linkAirAt });
  // Deduped: no session turn for a track that never airs. false sends
  // runTrackEvent to the pool for a fresh pick.
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
// link AIRS. ctx resolved at showAt is right for show IDENTITY but its clock
// runs the look-ahead fast (#1282), so show/mood/festival stay on showAt and
// only the clock-derived fields move to air time. `isDark` rides over from ctx.
//
// `airAt` null means the air moment isn't forecastable well enough to speak
// (#1314): ctx comes back untouched and the caller passes clockIsAirTime false,
// withholding the time from the prompt entirely.
function linkAirContext(ctx: any, airAt: Date | null) {
  if (!airAt || !ctx) return ctx;
  const clock: any = getClockContext(airAt);
  if (typeof ctx.clock?.isDark === 'boolean') clock.isDark = ctx.clock.isDark;
  return { ...ctx, at: airAt.toISOString(), date: getDateContext(airAt), clock, time: getTimeContext(airAt) };
}

// Returns 'queued' when a pick was enqueued, 'empty' when the pool produced
// none, 'collision' when its pick deduped. The final fallback ignores the
// answer, but the artist-guard rescue needs the distinction: only 'empty' means
// the pool truly held no other artist (#1187).
async function pickViaPool(queue, ctx, { wantLink, current, showAt = null }: { wantLink: boolean; current?: any; showAt?: Date | null }, rankTarget: { bpm: number | null; key: string | null } | null = null, audioWaypoint: number[] | null = null, opts: { avoidArtist?: string | null } = {}): Promise<'queued' | 'empty' | 'collision'> {
  // A mini-run anchors the re-rank to its tempo/key target instead of the
  // current track; a journey waypoint anchors the audio-KNN source. Both null
  // means anchor to the current track.
  const result = await picker.pickViaPool(queue, ctx, rankTarget, audioWaypoint, opts);
  if (!result) {
    queue.log('picker', 'pool produced no pick');
    return 'empty';
  }
  // Build the link BEFORE enqueueing so it rides the queued item and airs when
  // the pick starts (#189).
  let link: string | null = null;
  // Resolved here, not in runTrackEvent: the pick call above already spent part
  // of the runway, so asking now is the most honest forecast on this path.
  const airAt = linkClockAt(showAt, Date.now());
  if (wantLink && current) {
    try {
      link = await dj.generateLink({
        // ctx with the clock stepped to the link's air moment (#1282). The link
        // may speak a clock only with the look-ahead resolved AND enough runway
        // left for it to hold (#864, #1314).
        previous: current, current: result.song, context: linkAirContext(ctx, airAt),
        clockIsAirTime: !!airAt,
        // Named explicitly: unset, generateLink falls back to the wall-clock
        // persona, which disagrees with the session inside the look-ahead.
        persona: session.onAirPersona(),
        recap: queue.getDjRecap(),
        recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
        // Announce mode alternates against the link that last AIRED.
        lastLink: queue.getLastLinkText(),
      });
    } catch (err) {
      queue.log('error', `DJ link failed: ${err.message}`);
    }
  }
  // The intro budget rides enqueuePick's trimLinkToIntro chokepoint; nothing to
  // enforce here. effectsActive and the per-effect switches (#1565) are
  // re-checked at enqueue time because pickNextTrack narrowed the enum before a
  // model call, and a switch flipped in between must not reach the annotation.
  const fxActive = settings.effectsActive();
  const wants = (kind: TransitionEffect) =>
    fxActive && result.transition === kind && settings.effectEnabled(kind);
  const fx = {
    sweep: wants('sweep'),
    washout: wants('washout'),
    blend: wants('blend'),
    dissolve: wants('dissolve'),
    chop: wants('chop'),
    loop: wants('loop'),
  };
  // `current` is the link's back-announce target; stamp it so the queue drops
  // the link if a request jumps ahead.
  //
  // linkClockDrifted (queue/pure.ts) drops a link when the real seam lands far
  // from the forecast, so the clock stamp must only be set when a clock was
  // actually OFFERED — with the station clock off the line contains no time and
  // a drift drop would cost the whole link for nothing. Gated on the STAMP, not
  // on `airAt`, so linkAirContext still steps the daypart tags to air time.
  const queued = await enqueuePick(queue, result.song, result.reason, result.source || 'pool', link, current, fx, {
    linkClockAt: linkClockStampFor(airAt, speakClockAllowed()),
  });
  // Even the pool landed on an already-queued track. Skip the session turn and
  // let auto.m3u backstop the slot; the next track-start picks again.
  if (queued === -1) return 'collision';
  // On a failed pool LLM picker.js returns the sentinel 'fallback (LLM pick
  // failed)'; recording that as the DJ's turn primes the next agent run with
  // "you failed before". Substitute a neutral line so the conversation still
  // alternates without the defeatist signal.
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
// empty. Posts the event to the session, then picks via the agent, falling back
// to the pool.
// `ctx` is the pick's context; near a show boundary the watcher hands in a
// look-ahead snapshot plus the matching `showAt` clock, so both pick paths
// follow the show that will be on air when the pick plays. `showAt` null →
// resolve at now.
// `predecessor` is the track the pick will FOLLOW when a pair-drain deadline
// fires it — not queue.current, which is one track earlier then; `prior` is the
// track before it. Omitted → queue.current/history.
export async function runTrackEvent(queue, ctx, { wantLink, showAt = null, predecessor = null, prior = null }: {
  wantLink: boolean;
  showAt?: Date | null;
  predecessor?: any | null;
  prior?: any | null;
}) {
  return withTrace({ kind: 'track-event', wantLink }, async () => {
    // Daily token cap. At the hard cap: no model call at all, and Liquidsoap
    // coasts on the auto playlist. In the soft tier: still pick, but cheaply
    // (stateless pool picker, no link).
    if (!budget.picksAllowed()) {
      queue.log('budget', 'daily LLM token cap reached — coasting on the auto playlist');
      return;
    }
    const cheap = budget.preferCheapPicker();
    // Station voice off → still pick, never link. The agent event message then
    // orders silence and a disobedient line is dropped at the `wantLink && say`
    // guard; the pool path skips generateLink outright.
    wantLink = wantLink && !cheap && autoVoiceAllowed();

    const current = predecessor ?? queue.current?.track ?? null;
    const previous = predecessor ? (prior ?? null) : (queue.history[0]?.track ?? null);
    const djMode = !!settings.getEffectivePersona()?.djMode;
    // On-air persona, not the wall-clock effective one: the link belongs to
    // whoever speaks it.
    const announce = settings.announceLinks(session.onAirPersona());

    const { rankTarget, audioWaypoint } = advanceRun(djMode, current);
    const inRun = runActive();

    // The "nod to it in the link" half is gated on wantLink, so a silent
    // mid-run pick isn't told it may phrase something in a link that won't
    // exist. The energy direction is pick selection, so it stays unconditional.
    const runClause = inRun
      ? ` You're mid-run — keep the energy moving in the same direction (a touch ${energyForDaypart().speed >= 1 ? 'brisker' : 'mellower'}).`
        + (wantLink ? ' You may nod to it in the link, but never say tempo numbers.' : '')
      : '';
    // Gated on the waypoint, not inRun: on a run's final pick advanceRun has
    // already cleared the run state but the last waypoint is the destination.
    const journeyClause = audioWaypoint && audioWaypoint.length
      ? ' A sonic journey is active: call tracksTowardJourney and lean toward one of its tracks — each carries the sound a step toward where this arc is heading. If it comes back thin, pick via the library mood/genre/audio tools and keep the energy heading the same way. Never mention the journey on air.'
      : '';
    // Opener variety for the link: one rotating angle plus the recent openers
    // to steer clear of, the same two signals decoratePrompt gives the pool
    // path. Announce mode skips both — alternating between its two fixed forms
    // IS the variety, and an opener blocklist would eventually forbid both.
    const linkAngle = wantLink && !announce ? dj.pickAngle('link') : null;
    const recentOpeners = wantLink && !announce ? queue.getRecentOpeners() : [];
    // Clock discipline for the link (#864). The agent path carries no clock of
    // its own, so without this the model extrapolates one from stale stamped
    // lines in the session window. With the look-ahead resolved, the air moment
    // is stepped back off showAt's padded clock (#1282); without it, or with
    // too little runway left for the forecast to hold (#1314), the clock is
    // banned outright. The station clock switch gets its own clause: off wins
    // over accurate. This clause and the `say` schema description are the ONLY
    // clock the agent path ever sees.
    const clockOff = !speakClockAllowed();
    const airAt = clockOff ? null : linkClockAt(showAt, Date.now());
    const airClock = airAt && ctx?.clock?.hhmm ? getClockContext(airAt) : null;
    const clockClause = wantLink
      ? (clockOff
          ? ` Never state the clock time, the hour, or the time of day in the link.`
          : airClock
            ? ` The link airs at about ${airClock.display || airClock.hhmm} — if you mention the clock, that is the time to use, never an earlier one.`
            : ` Never state the clock time in the link — you can't know exactly when it airs.`)
      : '';
    // The full link contract lives in the "say" schema description
    // (pickSchemaBase), which travels on every call; this clause only TRIGGERS
    // the link and carries the per-pick extras the schema can't know. Restating
    // the contract here doubles it per pick.
    const linkClause = wantLink
      ? buildLinkClause({ djMode, announce, angle: linkAngle, recentOpeners })
      : ' Stay silent — no link this time.';
    // Per-pick effects reminder. The system-prompt guidance alone loses to the
    // session history — the model sees ~40 of its own prior picks, almost all
    // transition:"normal", and copies itself. The event turn is the freshest
    // instruction in the window, so the deliberate-choice nudge rides here.
    const recentT = typeof queue.recentTransitionChoices === 'function' ? queue.recentTransitionChoices() : [];
    const historyNote = recentT.length
      ? ` Your recent transition choices, oldest first: ${recentT.join(', ')} — the station strips a third repeat, so vary deliberately.`
      : '';
    // Compact on purpose: effectsGuidance() in the system prompt carries the
    // full coaching, and re-describing all seven effects here triples it per
    // pick (system + event + schema description).
    const effectClause = settings.effectsActive()
      ? ` Set "transition" by what THIS moment needs, per the TRANSITION EFFECTS guidance — "washout"/"loop" end your pick, "sweep"/"dissolve"/"chop" resolve a clash, "blend" only for an exceptionally locked pair, "normal" otherwise. Vary your craft: never the same transition three picks running, and if your last pick used an effect, lean "normal" now unless the moment clearly calls again.${historyNote}`
      : '';
    // The turn splits in two: `text` is the factual event the booth log shows,
    // `meta.promptSuffix` the model-facing coaching. windowMessages() re-joins
    // them, so the model sees one message and the operator reads no prompt
    // engineering in the log.
    //
    // Listener favourites (#991) ride the EVENT turn, not the system prompt:
    // they change as likes land, and a per-call re-render breaks the
    // byte-stable prefix prompt caching keys on. windowMessages keeps only the
    // latest pick event, so the list never multiplies across the window.
    const favClause = likes.favouritesClause(settings.get()?.likes);
    // Exploration nudge (ε-greedy seed break, music/airing.ts): a fraction of
    // picks steer the round toward the unaired shelf instead of walking the
    // on-air track's similarity cluster. Carries NO track id — a raw id in the
    // event message is the #1247 seed-echo trap; deepCuts is the safe carrier.
    // Skipped mid-run/journey (they own the direction) and on strict-playlist
    // shows (deep cuts are almost surely off-playlist).
    const exploreClause = !inRun && !audioWaypoint && !ctx?.activeShow?.playlistStrict
      && Math.random() < EXPLORE_SEED_PROBABILITY
      ? ' Exploration nudge: include deepCuts in your discovery round this pick — surface something the station has never aired (or hasn\'t in weeks) and give it real consideration when it can fit the moment.'
      : '';
    // The real Subsonic id is surfaced so similarSongs / tracksLikeThis have
    // one to pass; without it the agent fabricates a slug and Navidrome answers
    // "data not found".
    const eventText = `Now playing "${current?.title}" by ${current?.artist}`
      + (current?.id ? ` [id: ${current.id}]` : '')
      + (previous ? ` (after "${previous.title}" by ${previous.artist})` : '')
      + '. Pick the track to play next.'
      + linkClause;
    const promptSuffix = `${clockClause}${favClause}${effectClause}${runClause}${journeyClause}${exploreClause}`;
    session.appendTurn({
      role: 'event', kind: 'pick', text: eventText,
      meta: promptSuffix ? { promptSuffix } : {},
    });

    // `!cheap`: in the soft budget tier we skip the multi-step agent tool-loop
    // and go straight to the one-call pool picker below to stretch the budget.
    if (settings.get().llm?.pickerAgent && !cheap && !breakerOpen()) {
      try {
        // Stamp the item with the air moment the model was TOLD to speak, and
        // only when it was told one — a run given no clock makes no claim that
        // can go stale (#1314). `airClock` covers both reasons it might not
        // have been told: no forecastable moment, and the clock switch.
        const queued = await pickViaAgent(queue, ctx, {
          wantLink, audioWaypoint, current, showAt, rankTarget,
          linkAirAt: linkClockStampFor(airAt, !!airClock),
        });
        breakerSuccess();
        if (queued) return;
        // Valid pick, already queued/on-air, so push() dropped it. The agent is
        // healthy: don't trip the breaker, fall through to the pool.
        queue.log('picker', 'agent pick already queued — falling back to pool');
      } catch (err) {
        // A run the agent DROVE correctly but couldn't answer from (every
        // discovery call empty) is a library-coverage problem, not a model one
        // (#1247), so it must not count against the breaker — the pool fallback
        // below fills the slot either way.
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

// Request event — a listener asked for something.
//
// Returns { ack, track } on success, or null when the agent is disabled or the
// breaker is open (the caller then runs its own stateless matcher cascade).
// Throws if the agent runs but fails — the caller falls back the same way.
// Outcomes feed the shared breaker: same model, same done-tool harness.
// The caller (routes/request.js) owns the request `event` turn; the agent only
// appends its own `dj` reply here.
export async function runRequest(queue: any, ctx: any, { requester, text }: { requester: string; text: string }) {
  if (!settings.get().llm?.pickerAgent || breakerOpen()) return null;
  // Over the hard token cap the agent runs only when requests are exempt
  // (llm.exemptRequests, on by default); otherwise the caller's stateless
  // cascade handles it without a model call.
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
    // Requests stay near-unfiltered: listeners must be able to re-request a
    // song from earlier in the day, so the window is only 2h.
    const recentIds = queue.recentlyPlayedIds(2);
    for (const id of queue.queuedIds()) recentIds.add(id);

    // Pin THIS run to THIS request with an explicit tail message rather than
    // trusting the session's last event turn: request events go into the SHARED
    // session, so with two in flight another listener's event can be the more
    // recent one, and the append is best-effort. The tail is what the system
    // prompt points at ("the final user line"). Coalesced into a trailing user
    // message because some providers require strict alternation;
    // windowMessages() returns fresh copies, so appending in place is safe.
    const cur = queue.current?.track || null;
    // Name the listener ONLY when there is a real name: the prompt greets
    // whoever the tail names, so the ledger stand-in 'anon' would go on air as
    // a name (#1347).
    const tail = (isNamedRequester(requester)
      ? `The request to resolve now — listener "${requester}" asks: "${text}"`
      : `The request to resolve now — an unnamed listener asks: "${text}"`)
      + (cur ? ` (currently playing "${cur.title}" by ${cur.artist}${cur.id ? ` [id: ${cur.id}]` : ''})` : '');
    const messages = session.windowMessages();
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') last.content += '\n' + tail;
    else messages.push({ role: 'user', content: tail });

    // Recency only, no show locks: an explicit listener ask wins over the
    // show's strict filters.
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
