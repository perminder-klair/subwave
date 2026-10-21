// Listener track requests. POST returns a request id immediately; matching, the
// pick cascade, intro generation and enqueue run in the background, and
// GET /request/:id reports the outcome.
import express from 'express';
import { randomUUID } from 'node:crypto';
import * as subsonic from '../music/subsonic.js';
import * as dj from '../llm/dj.js';
import * as library from '../music/library.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';
import * as djAgent from '../broadcast/dj-agent.js';
import * as budget from '../broadcast/dj-budget.js';
import * as session from '../broadcast/session.js';
import * as requestLog from '../broadcast/request-log.js';
import * as listeners from '../broadcast/listeners.js';
import * as likes from '../broadcast/likes.js';
import { generateQueuedRequestIntro } from '../broadcast/request-intro.js';
import * as webhooks from '../broadcast/webhooks.js';
import * as settings from '../settings.js';
import {
  sanitizeRequestText, stripScriptedOpener, cleanRequesterName, cleanMissedArtist, stillInFlight, screenAck,
  isNamedRequester, sorryNoMatch,
} from '../util/request-guard.js';
import {
  checkRateLimit, checkGlobalRateLimit, commitRateLimit, commitGlobalRateLimit, clientIp,
  REQUESTS_DISABLED,
} from '../middleware/ratelimit.js';
import { validatePublicBody } from '../middleware/validate.js';
import { listenerRequestSchema } from '../schemas/request.js';
import { directRequestUnsupported, isRefusedOutcome, modelFreeRequest, nameSearchTerms, repairRequestMatch, requestArtistMatches, resolveDirectRequest } from '../music/request-match.js';
import { requestWaitClause } from '../broadcast/queue/pure.js';
import { matchedRequestLookups, matchedRequestStandIn } from '../util/request-claim.js';
import { ARTIST_VARIETY_WINDOW, drawRequestCandidate } from '../broadcast/dj-agent/artist-guard.js';

export const router = express.Router();

// In-memory request ledger, ephemeral by design: a restart drops in-flight
// requests, and the track is either already queued or it isn't.
const requests = new Map();
const REQUEST_TTL_MS = 10 * 60 * 1000;

// settings.requests.onePendingPerIp: an IP's previous request must resolve AND
// leave the upcoming queue before the next is accepted. pruneRequests() janitors.
const lastByIp = new Map<string, any>();

function pruneRequests() {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [id, entry] of requests) {
    if (entry.createdAt < cutoff) requests.delete(id);
  }
  for (const [ip, entry] of lastByIp) {
    if (entry.createdAt < cutoff) lastByIp.delete(ip);
  }
}

// The shortcut shares identity lookup. Seed/queued tracks are excluded; recent
// plays retain the upstream soft two-hour preference.
async function pickMoreByArtist(artistName: string, recentIds: Set<string>, seedId?: string | null) {
  const result = await resolveDirectRequest({ artist: artistName }, {
    catalog: subsonic, recentIds: new Set<string>(), queuedIds: queue.queuedIds(), currentId: seedId,
    choose: songs => {
      const fresh = songs.filter(song => !recentIds.has(song.id));
      const pool = fresh.length ? fresh : songs;
      return pool[Math.floor(Math.random() * pool.length)] || null;
    },
    moodSongs: async () => [], fallbackSongs: async () => [],
  });
  return result.outcome === 'matched' ? result.track : null;
}

// "more like this" fallback when the playing artist has nothing else in the
// library: prefer the audio-similarity extension, then the Last.fm graph.
// Excludes the seed track and recent plays.
async function pickSimilarToTrack(reference, recentIds: Set<string>) {
  const id = reference?.track?.id;
  if (!id) return null;
  const exclude = new Set(recentIds);
  exclude.add(id);
  const pickFresh = (songs) => {
    const list = (songs || []).filter((s) => s?.id && !exclude.has(s.id));
    if (list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)];
  };
  try {
    if (await subsonic.supportsSonicSimilarity()) {
      const pick = pickFresh(await subsonic.getSonicSimilarTracks(id, { count: 25 }));
      if (pick) return pick;
    }
  } catch (err) { queue.log('error', `more-like-this sonic similar failed: ${err.message}`); }
  try {
    const pick = pickFresh(await subsonic.getSimilarSongs(id, { count: 25 }));
    if (pick) return pick;
  } catch (err) { queue.log('error', `more-like-this similar songs failed: ${err.message}`); }
  return null;
}

// Append the durable debug record once, at a request's terminal state. Best
// effort: a logging hiccup must never affect the listener's outcome. Called from
// resolveRequest's terminal closures and the crash catch below.
function recordOutcome(entry) {
  try {
    requestLog.record({
      t: new Date(entry.createdAt).toISOString(),
      id: String(entry.id).slice(0, 8),
      requester: entry.requester,
      text: entry.text,
      rawText: entry.rawText ?? null,
      injection: entry.injection ?? null,
      status: entry.status,
      ms: entry.startedAt ? Date.now() - entry.startedAt : null,
      path: entry.path || null,
      pickSource: entry.pickSource || null,
      intent: entry.intent ?? null,
      mood: entry.mood ?? null,
      scope: entry.scope ?? null,
      sort: entry.sort ?? null,
      artist: entry.artist ?? null,
      genre: entry.genre ?? null,
      language: entry.language ?? null,
      searchTerms: entry.searchTerms ?? null,
      artistMiss: entry.artistMiss ?? null,
      outcome: entry.outcome ?? null,
      title: entry.title ?? null,
      album: entry.album ?? null,
      lookupErrors: entry.lookupErrors ?? [],
      interpretationFallback: entry.interpretationFallback ?? false,
      unsupported: entry.unsupported ?? [],
      unmetPreferences: entry.unmetPreferences ?? [],
      track: entry.pick
        ? { title: entry.pick.title, artist: entry.pick.artist, id: entry.pick.id }
        : (entry.track || null),
      ack: entry.ack || null,
      introScript: entry.introScript || null,
      message: entry.message || null,
      guard: entry.guard ?? null,
      introFailure: entry.introFailure ?? null,
    });
  } catch (err) {
    queue.log('error', `request-log record failed: ${err.message}`);
  }
}

// Accumulate guard verdicts: one request can trip both the ack and intro guards.
function flagGuard(entry, verdict: string | null | undefined) {
  if (!verdict) return;
  entry.guard = entry.guard ? `${entry.guard}+${verdict}` : verdict;
}

// Append an honest wait to a queued request's acknowledgement (#1622 FR 4).
//
// A request has always joined the back of a FIFO queue, and that queue used to
// be one or two picks deep, so "coming up" was true within a track or two. An
// operator block can now put a whole album in front of it — and it must, since
// `drain-policy.ts` makes FIFO non-negotiable (a request IS the successor
// arriving) and jumping the block would split the record the block exists to
// keep whole. So the listener is told how long instead of being left to
// conclude the station is broken.
//
// Called at the THREE sites that queue a track and report a position (the
// more-like-this shortcut, the agent path, the stateless cascade) — one helper
// rather than three copies of the same walk.
//
// Addressed by TRACK ID rather than by taking the tail of `upcoming`: there are
// awaits between the push and here, so a concurrent request or a pick can have
// appended in the meantime and the tail is not reliably ours. The LAST match
// is, since `allowDuplicate` means the same id can sit in the queue twice and
// the newest copy is the one just pushed.
//
// Says nothing at all when the item is gone (it aired while the acknowledgement
// was being written) or the forecast is unknown or short — which is exactly the
// pre-block behaviour. The phrasing rules live in the pure `requestWaitClause`,
// never inline here.
function withWaitNotice(ack: string | null | undefined, trackId: string | null | undefined): string | null {
  if (!ack) return ack ?? null;
  if (!trackId) return ack;
  const idx = queue.upcoming.map(i => i.track?.id).lastIndexOf(trackId);
  if (idx < 0) return ack;
  // The LAST block ahead of it is the one still playing when this request comes
  // round, so it is the one worth naming.
  const blockLabel = [...queue.upcoming.slice(0, idx)].reverse().find(i => i.block)?.block?.label ?? null;
  return `${ack}${requestWaitClause({ waitSec: queue.airForecastSec(queue.upcoming[idx]), blockLabel })}`;
}

// A comparison ("something like Michael Jackson", "anything like this",
// "similar") opens the similar-to-current rung. Never a bare "like": "I'd
// like X by Y" names X, and Y's catalogue answers a miss better.
const ON_AIR_REFERENCE = /\bsimilar\b|\b(?:something|anything|more|songs?|tracks?|music|stuff|one)\s+like\b|\blike\s+(?:this|that|these|those)\b|\bmatch\s+this\b/i;

const UNSUPPORTED_REFUSAL = `I couldn't reliably check all the conditions in that request. Try naming a song, artist, album, genre or simple mood.`;

// A bounded literal parser for hard-budget or failed interpretation calls.
// The resolver still verifies its title/artist against the actual catalogue.
function modelFreeMatch(text: string): Awaited<ReturnType<typeof dj.matchRequest>> {
  return { ...modelFreeRequest(text), literal: true } as Awaited<ReturnType<typeof dj.matchRequest>>;
}

// Requests accepted but not yet resolved. Their track is not in the upcoming
// queue until resolveRequest() pushes it, which can take the agent's whole
// timeout, so the maxPending gate counts them alongside the queued ones.
function resolvingRequestCount(): number {
  let n = 0;
  for (const entry of requests.values()) if (entry.status === 'pending') n++;
  return n;
}

async function resolveRequest(entry) {
  const { requester, text } = entry;
  entry.startedAt = Date.now();

  const resolved = ({ ack, track, queuePosition }) => {
    entry.outcome ||= entry.refused ? 'already-queued' : track ? 'matched' : 'chat';
    entry.status = 'resolved';
    entry.ack = ack || null;
    entry.track = track || null;
    entry.queuePosition = typeof queuePosition === 'number' ? queuePosition : null;
    recordOutcome(entry);
  };
  const failed = (message) => {
    entry.outcome ||= 'no-match';
    entry.status = 'failed';
    entry.message = message;
    recordOutcome(entry);
  };

  let ctx;
  try {
    ctx = await getFullContext();
  } catch (err) {
    queue.log('error', `getFullContext for request failed: ${err.message}`);
    ctx = {};
  }

  // Roll, then post ONE event turn before any resolution path, so the agent, the
  // more-like-this shortcut and the cascade share it and no orphan event is left.
  try {
    await session.maybeRoll(ctx);
    const cur = queue.current?.track || null;
    session.appendTurn({
      role: 'event', kind: 'request',
      // The pick agent reads this window for hours; an unsigned request must
      // not leave 'anon' in it as if it were a name (#1347).
      text: `${isNamedRequester(requester) ? `Listener "${requester}" requests` : 'An unnamed listener requests'}: "${text}"`
        + (cur ? ` (currently playing "${cur.title}" by ${cur.artist}${cur.id ? ` [id: ${cur.id}]` : ''})` : ''),
      // The bare text, so the echo guards can check every request still in the
      // agents' window without the line's own framing words (not public meta).
      meta: { requestText: text },
    });
  } catch (err) {
    queue.log('error', `Session update for request failed: ${err.message}`);
  }

  // 0. "more like this" is a meta-instruction about the current track, not a
  // query, so it never goes through the generic search path.
  const isMoreLikeThis = /^more\s+like\s+this[.!?]?$/i.test(text);
  if (isMoreLikeThis) {
    entry.path = 'more-like-this';
    entry.pickSource = 'more-like-this';
    const reference = queue.current || queue.history[0];
    const refArtist = reference?.track?.artist;
    if (!refArtist) {
      return failed(`Nothing's playing yet — tell me what you're after instead.`);
    }
    // A two-hour window, not the request cooldown: the artist pick only
    // prefers tracks outside it, and the similarity fallback skips them. The
    // seed and queued tracks are always excluded.
    const recentIds = queue.recentlyPlayedIds(2);
    if (reference?.track?.id) recentIds.add(reference.track.id);
    for (const id of queue.queuedIds()) recentIds.add(id);
    // Same artist first, then real track similarity so a one-off collab credit
    // playing now doesn't dead-end the request.
    let pick = await pickMoreByArtist(refArtist, recentIds, reference?.track?.id);
    if (!pick) {
      pick = await pickSimilarToTrack(reference, recentIds);
      if (pick) entry.pickSource = 'more-like-this:similar';
    }
    if (!pick) {
      return failed(`Couldn't find anything close to "${reference?.track?.title || refArtist}" in the crates.`);
    }
    // The fallback can land on a different artist; phrase the ack from the pick.
    const sameArtist = requestArtistMatches(refArtist, pick);
    const ackLine = sameArtist ? `More from ${refArtist}, coming up.` : `More like that, coming up.`;
    // Station voice off: request still honoured and acked, no spoken intro and
    // no model call to write one.
    const generatedIntro = await generateQueuedRequestIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    }, text);
    if (generatedIntro.failure) {
      entry.introFailure = generatedIntro.failure;
      queue.log('error', 'more-like-this optional intro failed — queueing without speech');
    }
    if (generatedIntro.guard) {
      flagGuard(entry, generatedIntro.guard);
      queue.log('request-guard', `more-like-this intro echoed request text — ${generatedIntro.guard}`);
    }
    const introScript = generatedIntro.introScript;
    const pos = await queue.push({
      track: pick, requestedBy: requester, intent: 'more_like_this', introScript,
      introKind: 'dj-speak',
      // Voice it as whoever wrote it: render and air happen later and would
      // otherwise re-resolve the speaker off the wall clock.
      introPersona: generatedIntro.introPersona,
      introHostSpeech: generatedIntro.introHostSpeech,
    });
    entry.pick = pick;
    if (pos === -2) {
      // Blocklist refused the pick; decline with the standard not-found copy so
      // the block doesn't leak.
      entry.pickSource = `${entry.pickSource}:blocked`;
      return failed(`Couldn't find anything close to "${reference?.track?.title || refArtist}" in the crates.`);
    }
    if (pos === -1) {
      // A concurrent request already queued this track (#619).
      const dupAck = queue.dedupAck(pick.id);
      entry.pickSource = `${entry.pickSource}:already-queued`;
      // Nothing queued for THIS listener, so the one-pending hold must not key
      // on a track they didn't get (stillInFlight).
      entry.refused = true;
      session.appendTurn({ role: 'dj', kind: 'request', text: dupAck, meta: { trackId: pick.id, requester } });
      return resolved({ ack: dupAck, track: { title: pick.title, artist: pick.artist }, queuePosition: null });
    }
    session.appendTurn({
      role: 'dj', kind: 'request',
      text: introScript || ackLine,
      meta: { trackId: pick.id, requester },
    });
    entry.introScript = introScript || null;
    return resolved({
      ack: withWaitNotice(ackLine, pick.id),
      track: { title: pick.title, artist: pick.artist },
      queuePosition: queue.upcoming.length,
    });
  }

  // Conversational DJ agent. On any failure fall through to the stateless
  // cascade below, so a request is never dropped.
  try {
    const agentRes = await djAgent.runRequest(queue, { requester, text });
    if (agentRes) {
      // Thread the agent's own echo-guard verdict into the durable log; the
      // other paths set it inline.
      if (agentRes.guard) flagGuard(entry, agentRes.guard);
      if (!agentRes.track) {
        // Chat escape: the agent answered in persona, nothing to queue. Only an
        // EXPLICIT kind:"chat" lands here; an omitted id falls to the cascade.
        queue.log('request', `agent chat-answered (no track)`);
        entry.path = 'chat';
        entry.pickSource = 'agent-chat';
        return resolved({ ack: agentRes.ack, track: null, queuePosition: null });
      }
      if (agentRes.refused) {
        // The agent declined to queue and returned the track only so the ack and
        // log can name it: no queue position, no one-pending hold.
        queue.log('request', `agent refused (${agentRes.refused}): ${agentRes.track.title} — ${agentRes.track.artist}`);
        entry.path = 'agent';
        entry.pickSource = `agent:${agentRes.refused}`;
        entry.pick = agentRes.track;
        entry.refused = true;
        entry.outcome = agentRes.refused;
        return resolved({ ack: agentRes.ack, track: agentRes.track, queuePosition: null });
      }
      queue.log('request', `agent resolved: ${agentRes.track.title} — ${agentRes.track.artist}`);
      entry.path = 'agent';
      entry.pickSource = 'agent';
      entry.pick = agentRes.track;
      entry.introScript = agentRes.introScript || null;
      return resolved({
        ack: withWaitNotice(agentRes.ack, agentRes.track.id),
        track: agentRes.track,
        queuePosition: queue.upcoming.length,
      });
    }
  } catch (err) {
    queue.log('error', `DJ agent request failed: ${err.message} — falling back`);
  }

  // 1. LLM matches intent; the current track lets vibe queries be read against
  // what is on air. Gated before generation: past the hard token cap with
  // requests not exempt, the model is not called at all.
  const currentTrack = queue.current?.track || null;
  let matched = modelFreeMatch(text);
  if (budget.requestsAllowed()) {
    try {
      matched = repairRequestMatch(await dj.matchRequest(text, { listenerName: requester, nowPlaying: currentTrack }), text) as typeof matched;
    } catch (err) {
      entry.interpretationFallback = true;
      queue.log('error', `request interpretation failed: ${err.message} — trying library search`);
    }
  }
  const unsupported = directRequestUnsupported(text, matched);
  if (unsupported.length) {
    entry.path = 'cascade';
    entry.pickSource = 'unsupported';
    entry.outcome = 'unsupported';
    entry.unsupported = unsupported;
    return failed(UNSUPPORTED_REFUSAL);
  }
  queue.log('intent', `"${text}" → ${matched.intent || '(no intent)'}`, {
    mood: matched.mood,
    scope: matched.scope,
    sort: matched.sort,
    artist: matched.artist,
    language: matched.language,
    searchTerms: matched.search_terms,
  });

  // Conversational message: conversational answer, nothing queued.
  if ((matched as any).kind === 'chat') {
    queue.log('request', `cascade chat-answered (no track)`);
    entry.path = 'chat';
    entry.pickSource = 'chat';
    const screened = screenAck(matched.ack, text, 'Heard you loud and clear.');
    if (screened.guard) {
      flagGuard(entry, screened.guard);
      queue.log('request-guard', `cascade chat ack echoed request text — replaced`);
    }
    session.appendTurn({ role: 'dj', kind: 'request', text: screened.ack, meta: { requester } });
    return resolved({ ack: screened.ack, track: null, queuePosition: null });
  }

  // Matcher breakdown for the debug record; only the stateless cascade gets here.
  entry.path = 'cascade';
  entry.intent = matched.intent || null;
  entry.mood = matched.mood || null;
  entry.scope = matched.scope || null;
  entry.sort = matched.sort || null;
  entry.artist = matched.artist || null;
  entry.title = matched.title || null;
  entry.album = matched.album || null;
  entry.genre = matched.genre || null;
  entry.language = matched.language || null;
  entry.searchTerms = matched.search_terms || null;

  // Preserve upstream stand-in spacing after the resolver applies identity,
  // hard constraints and cooldowns. Named matches remain exempt, and the
  // resolver says which search terms are names.
  const named = matched.literal ? [] : [matched.artist, matched.title, ...nameSearchTerms(matched)];
  const searches: Array<{ term: string; hits: any[] }> = [];
  const varietyWindow = settings.get().llm?.artistVarietyWindow ?? ARTIST_VARIETY_WINDOW;
  const cdMin = Number(settings.get().requests.repeatCooldownMin ?? 120);
  const selection = await resolveDirectRequest(matched, {
    text,
    catalog: {
      ...subsonic,
      searchPage: async (term, options) => {
        const page = await subsonic.searchPage(term, options);
        searches.push({ term, hits: page.songs });
        return page;
      },
    },
    choose: pool => {
      const isStandIn = matchedRequestStandIn(named, {
        requestText: text, lookups: matchedRequestLookups(searches, text), onAir: currentTrack,
      });
      const drawn = drawRequestCandidate(pool, queue.neighbourArtistRoots(varietyWindow), isStandIn);
      if (drawn.withheld) {
        flagGuard(entry, 'artist-spaced');
        queue.log('request-guard', `stand-in by recently-played artist "${drawn.withheld.artist}" set aside — drew "${drawn.pick?.title}" by ${drawn.pick?.artist} instead (${drawn.skipped} recent stand-in(s) passed over, spacing window ${varietyWindow} slots)`);
      } else if (drawn.starved) {
        queue.log('request-guard', `stand-in by recently-played artist "${drawn.pick?.artist}" allowed — every candidate in its pool was one (spacing window ${varietyWindow} slots)`);
      }
      return drawn.pick;
    },
    recentIds: cdMin > 0 ? queue.recentlyPlayedIds(cdMin / 60) : new Set<string>(),
    queuedIds: queue.queuedIds(),
    currentId: queue.current?.track?.id,
    moodSongs: async mood => { await library.load(); return library.songsByMood(mood); },
    fallbackSongs: async () => {
      let moodSongs: any[] = [];
      if (ctx.dominantMood) {
        try { await library.load(); moodSongs = library.songsByMood(ctx.dominantMood); }
        catch (err) { queue.log('error', `request mood fallback failed: ${err.message}`); }
      }
      try {
        const starred = await subsonic.getStarred();
        await likes.load();
        return [...moodSongs, ...likes.operatorStarred(starred, settings.get().likes)];
      } catch (err) {
        queue.log('error', `request starred fallback failed: ${err.message}`);
        return moodSongs;
      }
    },
    ...(currentTrack?.id && ON_AIR_REFERENCE.test(text)
      ? { similarSongs: () => subsonic.getSimilarSongs(currentTrack.id, { count: 20 }) } : {}),
  });
  const pick = selection.track;
  const pickSource = selection.source;
  entry.outcome = selection.outcome;
  entry.lookupErrors = selection.errors;
  entry.unmetPreferences = selection.unmetPreferences || [];
  for (const error of selection.errors) queue.log('error', `request lookup ${error}`);
  if (!pick) {
    entry.pickSource = pickSource;
    if (selection.outcome === 'unsupported') {
      entry.unsupported = selection.unsupported || [];
      return failed(UNSUPPORTED_REFUSAL);
    }
    return failed(selection.required?.length
      ? 'Could not verify a track meeting the requested language or genre requirements. Try simplifying the request.'
      : sorryNoMatch(requester));
  }
  // A search in the listener's own spelling answers in the library's ("Tupac"
  // finds 2Pac). That may be the same act, so the intro is not told it is not.
  if (selection.outcome === 'substituted' && matched.artist && !requestArtistMatches(matched.artist, pick)
    && !matchedRequestLookups(searches, text).some(credit => requestArtistMatches(credit, pick))) {
    entry.artistMiss = matched.artist;
    entry.missedArtist = cleanMissedArtist(matched.artist);
  }
  if (isRefusedOutcome(selection.outcome)) {
    entry.pick = pick;
    entry.pickSource = `${pickSource}:${selection.outcome}`;
    entry.refused = true;
    const ack = selection.outcome === 'cooldown' ? queue.cooldownAck(pick.id, pick.title || '') : queue.dedupAck(pick.id);
    session.appendTurn({ role: 'dj', kind: 'request', text: ack, meta: { trackId: pick.id, requester } });
    return resolved({ ack, track: { title: pick.title, artist: pick.artist }, queuePosition: null });
  }
  queue.log('request', `resolved via ${pickSource} (${selection.outcome}): ${pick.title} — ${pick.artist}`);
  // Substitutions need honest fixed copy. A real match keeps the screened
  // persona-language acknowledgement; optional preference misses stay private.
  let ack = `Couldn't match that request exactly — here's an alternative from the library.`;
  if (selection.outcome === 'matched') {
    const screened = screenAck(matched.ack, text, 'Found a match — your track is on the way.');
    if (screened.guard) flagGuard(entry, screened.guard);
    ack = screened.ack;
  }

  // 3. DJ intro. On a miss, flag it (and pass the cleaned name, when one
  // survived) so the intro owns the substitution. Station voice off means no
  // intro and no model call; the ack still reaches the listener.
  const generatedIntro = await generateQueuedRequestIntro({
    track: pick,
    context: ctx,
    requestedBy: requester,
    artistMiss: !!entry.artistMiss,
    missedArtist: entry.missedArtist ?? null,
    requestSubstitution: selection.outcome === 'substituted',
    recap: queue.getDjRecap(),
    recentTracks: queue.getRecentTracks(),
    recentOpeners: queue.getRecentOpeners(),
  }, text);
  if (generatedIntro.failure) {
    entry.introFailure = generatedIntro.failure;
    queue.log('error', 'request optional intro failed — queueing without speech');
  }
  if (generatedIntro.guard) {
    flagGuard(entry, generatedIntro.guard);
    queue.log('request-guard', `intro echoed request text — ${generatedIntro.guard}`);
  }
  const introScript = generatedIntro.introScript;

  // 4. Enqueue. push() dedups a track a concurrent request already queued (#619).
  const pos = await queue.push({
    track: pick,
    requestedBy: requester,
    intent: matched.intent,
    introScript,
    introKind: 'dj-speak',
    introPersona: generatedIntro.introPersona,
    introHostSpeech: generatedIntro.introHostSpeech,
  });
  entry.pick = pick;
  if (pos === -2) {
    // Blocklist refused the pick; standard not-found copy so it doesn't leak.
    entry.outcome = 'no-match';
    entry.pickSource = `${pickSource}:blocked`;
    return failed(sorryNoMatch(requester));
  }
  if (pos === -1) {
    const dupAck = queue.dedupAck(pick.id);
    entry.outcome = 'already-queued';
    entry.pickSource = `${pickSource}:already-queued`;
    entry.refused = true;
    session.appendTurn({ role: 'dj', kind: 'request', text: dupAck, meta: { trackId: pick.id, requester } });
    return resolved({ ack: dupAck, track: { title: pick.title, artist: pick.artist }, queuePosition: null });
  }
  session.appendTurn({
    role: 'dj', kind: 'request',
    text: introScript || ack || `Queued "${pick.title}".`,
    meta: { trackId: pick.id, requester },
  });

  entry.pickSource = pickSource;
  entry.introScript = introScript || null;
  return resolved({
    ack: withWaitNotice(ack, pick.id),
    track: { title: pick.title, artist: pick.artist },
    queuePosition: queue.upcoming.length,
  });
}

// Validates + rate-limits synchronously, then resolves in the background.
// The shared schema owns the SHAPE and REFUSES over-cap text rather than slicing
// it; the guard pipeline below (sanitize → strip → screen) repairs instead, and
// needs server state the schema can't see.
// validatePublicBody, not validateBody: the one LISTENER-facing form, so the 400
// carries an unprefixed message plus the success/message keys the native app reads.
router.post('/request', validatePublicBody(listenerRequestSchema), async (req, res) => {
  const cfg = (settings.get() as any)?.requests || {};
  if (REQUESTS_DISABLED || cfg.enabled === false) {
    return res.status(503).json({ success: false, message: 'Requests are temporarily closed.' });
  }

  // Zero-listener pause.
  await listeners.refresh();
  if (!listeners.djCallsAllowed()) {
    return res.status(503).json({
      success: false,
      message: "The DJ's on autopilot — requests reopen when someone's tuned in.",
    });
  }

  // req.body is already the parsed shape. Only the cleaned text reaches the
  // session/prompts/air; the raw text is kept on the entry for the operator log.
  // The schema has bounded both the original text and its NFKC expansion.
  const { text: rawText, name: rawName } = req.body as { text: string; name: string };
  const stripped = stripScriptedOpener(sanitizeRequestText(rawText));
  const text = stripped.text;
  if (!text) {
    // Distinguish "typed nothing" from "it was all staging directions", which an
    // ordinary listener can hit via a false positive. Never echo the text back.
    return res.status(400).json({
      error: stripped.injection
        ? "Couldn't read a song request in that — try just the artist, title, or a vibe."
        : 'Empty request',
    });
  }
  const s = settings.get() as any;
  const reservedNames = [
    'dj', 'admin', 'host', 'mod', 'moderator',
    s?.station || '',
    ...(Array.isArray(s?.personas) ? s.personas.map((p: any) => p?.name || '') : []),
  ];
  const requester = cleanRequesterName(rawName, reservedNames);

  const ip = clientIp(req);
  // Janitor runs BEFORE the gates: the one-pending hold returns 429 without
  // reaching the rest of the handler, so pruning later held an IP past the TTL.
  pruneRequests();
  const gate = checkRateLimit(ip);
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({
      success: false,
      message: `Easy there — try again in ${gate.retryAfter}s.`,
      retryAfter: gate.retryAfter,
    });
  }
  const globalGate = checkGlobalRateLimit();
  if (!globalGate.ok) {
    res.setHeader('Retry-After', String(globalGate.retryAfter));
    return res.status(429).json({
      success: false,
      message: 'The request line is busy — try again in a few minutes.',
      retryAfter: globalGate.retryAfter,
    });
  }
  // Both queue-state refusals carry the COOLDOWN as Retry-After: checkRateLimit
  // already stamped it, so the caller genuinely cannot succeed before it expires.
  const retryAfter = Number(cfg.cooldownSec) > 0 ? Number(cfg.cooldownSec) : 60;
  if (cfg.onePendingPerIp !== false && stillInFlight(lastByIp.get(ip), queue.queuedIds())) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      message: 'Your last request is still queued — it airs first.',
      retryAfter,
    });
  }
  // LISTENER requests only — an operator's own studio push carries
  // `requestedBy: 'studio'` for the air-path exemptions and must not consume a
  // slot in the listener queue. See queue.pendingListenerRequests(). Requests
  // still resolving count too: they hold no queue slot yet, so a burst
  // accepted inside one resolution window would otherwise all pass. The brief
  // overlap between a push and its entry settling errs toward refusing.
  const pendingCount = queue.pendingListenerRequests() + resolvingRequestCount();
  if (pendingCount >= (Number(cfg.maxPending) || 6)) {
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      success: false,
      message: "The request queue's full — try again in a few minutes.",
      retryAfter,
    });
  }

  // Spend the hourly budgets only after the queue-state gates: those reject
  // without queueing, and charging them burned the station-wide cap to zero on
  // rejections alone. The per-IP cooldown was already spent by checkRateLimit.
  commitRateLimit(ip);
  commitGlobalRateLimit();

  const id = randomUUID();
  const entry: any = {
    id, status: 'pending', requester, text,
    rawText: sanitizeRequestText(rawText),
    injection: stripped.injection,
    ack: null, track: null, queuePosition: null, message: null,
    createdAt: Date.now(),
  };
  requests.set(id, entry);
  lastByIp.set(ip, entry);
  queue.log('request', `${requester}: "${text}" (id ${id.slice(0, 8)})${stripped.injection ? ` [${stripped.injection} stripped]` : ''}`);
  webhooks.notify('request.received', { requestedBy: requester, text });

  // Hand back a receipt and let go of the connection.
  res.status(202).json({ success: true, requestId: id, status: 'pending' });

  resolveRequest(entry).catch(err => {
    queue.log('error', `Request resolution crashed: ${err.message}`);
    entry.outcome = 'error';
    entry.status = 'failed';
    entry.message = 'Something went wrong in the booth — try again.';
    recordOutcome(entry);
  });
});

// Poll for the outcome of a submitted request.
router.get('/request/:id', (req, res) => {
  const entry = requests.get(req.params.id);
  if (!entry) {
    // Never existed, or pruned / lost to a restart; the UI stops polling.
    return res.status(404).json({ status: 'unknown' });
  }
  res.json({
    status: entry.status,
    success: entry.status === 'resolved',
    ack: entry.ack,
    track: entry.track,
    queuePosition: entry.queuePosition,
    outcome: entry.outcome,
    message: entry.message,
  });
});
