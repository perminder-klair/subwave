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
import { withDeadline } from '../llm/sdk.js';
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
import { classifyListenerRequest, directRequestUnsupported, isFramedTitleOnlyRequest, isRefusedOutcome, isLyricOrFilmDescription, isGreetingLikeRequest, isGenericRequestPhrase, modelFreeRequest, nameSearchTerms, normalizeRequestMatch, pinExplicitRequestMatch, repairRequestMatch, requestArtistMatches, requestName, requestTextSimilarity, requestTitleSimilarity, resolveDirectRequest } from '../music/request-match.js';
import { canonicalLanguage } from '../music/request-normalize.js';
import { requestWaitClause } from '../broadcast/queue/pure.js';
import { matchedRequestLookups, matchedRequestStandIn } from '../util/request-claim.js';
import { ARTIST_VARIETY_WINDOW, drawRequestCandidate } from '../broadcast/dj-agent/artist-guard.js';
import { RequestIdentificationMiss } from '../broadcast/dj-agent/breaker.js';
import { isWebSearchProviderError } from '../skills/web-search.js';
import { resolveSoundtrackCandidates } from '../music/request-soundtrack.js';

export const router = express.Router();

export type ListenerResolutionOutcome =
  | 'matched'
  | 'no-match'
  | 'already-queued'
  | 'cooldown'
  | 'unsupported'
  | 'provider-error'
  | 'timeout';

export interface ListenerRequestResolution {
  outcome: ListenerResolutionOutcome;
  legacyOutcome: string;
  ack: string | null;
  message: string | null;
  track: { title?: string; artist?: string; id?: string } | null;
  queuePosition: number | null;
}

export type ListenerRequestSubmission = {
  accepted: true;
  requestId: string;
  status: 'pending';
} | {
  accepted: false;
  statusCode: number;
  message?: string;
  error?: string;
  retryAfter?: number;
};

type ListenerRequestEntryStatus = 'pending' | 'resolved' | 'failed';
type ListenerRequestTrack = { id?: string; title?: string; artist?: string; [key: string]: unknown };

export interface ListenerRequestEntry {
  id: string;
  status: ListenerRequestEntryStatus;
  requester: string;
  text: string;
  createdAt: number;
  startedAt?: number;
  provider?: string;
  rawText?: string;
  injection?: string | null;
  ack?: string | null;
  track?: ListenerRequestTrack | null;
  pick?: ListenerRequestTrack | null;
  queuePosition?: number | null;
  message?: string | null;
  outcome?: string;
  refused?: boolean;
  path?: string;
  pickSource?: string;
  classification?: string;
  intent?: string | null;
  mood?: string | null;
  scope?: string | null;
  sort?: string | null;
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  genre?: string | null;
  language?: string | null;
  searchTerms?: string[] | null;
  candidateCount?: number;
  confidence?: number | null;
  evidenceSource?: string | null;
  finalReason?: string | null;
  providerFailure?: string | null;
  unsupported?: string[];
  unmetPreferences?: string[];
  lookupErrors?: string[];
  stages?: string[];
  guard?: string | null;
  artistMiss?: string | null;
  missedArtist?: string | null;
  interpretationFallback?: boolean;
  introFailure?: string | null;
  introScript?: string | null;
}

// In-memory request index for fast polling and admission checks. The durable
// request log is appended only at terminal state.
const requests = new Map<string, ListenerRequestEntry>();
const REQUEST_TTL_MS = 10 * 60 * 1000;
// A listener request is accepted asynchronously, but it must still reach a
// terminal state promptly. Provider generation has a much larger safety
// timeout for other call sites; letting that budget govern this route leaves a
// listener receipt pending for minutes when a model accepts a request and then
// stops answering. Keep this route's wall-clock bound independent and shorter.
const REQUEST_RESOLUTION_MAX_MS = 60_000;
const REQUEST_QUEUE_RESERVE_MS = 2_000;
const REQUEST_INTERPRETATION_MAX_MS = 30_000;

function requestResolutionTimeoutMs(): number {
  const providerTimeout = Number((settings.get() as any)?.llm?.requestTimeoutMs);
  return Number.isFinite(providerTimeout) && providerTimeout > 0
    ? Math.min(REQUEST_RESOLUTION_MAX_MS, providerTimeout)
    : REQUEST_RESOLUTION_MAX_MS;
}

function requestIntroTimeoutMs(entry: ListenerRequestEntry): number {
  const elapsed = entry.startedAt ? Date.now() - entry.startedAt : 0;
  return Math.max(0, requestResolutionTimeoutMs() - elapsed - REQUEST_QUEUE_RESERVE_MS);
}

function throwIfRequestResolutionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? signal.reason : new Error('request resolution aborted');
  throw reason;
}

// settings.requests.onePendingPerIp: an IP's previous request must resolve AND
// leave the upcoming queue before the next is accepted. A request currently on
// air has already left the waiting line and does not block the next request.
// pruneRequests() janitors.
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
      provider: entry.provider ?? null,
      providerFailure: entry.providerFailure ?? null,
      classification: entry.classification ?? null,
      stages: entry.stages ?? [],
      candidateCount: entry.candidateCount ?? 0,
      confidence: entry.confidence ?? null,
      evidenceSource: entry.evidenceSource ?? null,
      finalReason: entry.finalReason ?? entry.pickSource ?? entry.outcome ?? null,
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
const EVIDENCE_MISS_REFUSAL = `I couldn't identify that song from the description. Try naming the title or artist.`;

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

async function resolveRequestCore(entry: ListenerRequestEntry, signal?: AbortSignal) {
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
  throwIfRequestResolutionAborted(signal);

  // Roll, then post ONE event turn before any resolution path, so the agent, the
  // more-like-this shortcut and the cascade share it and no orphan event is left.
  try {
    await session.maybeRoll(ctx);
    throwIfRequestResolutionAborted(signal);
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
    throwIfRequestResolutionAborted(signal);
    if (!pick) {
      pick = await pickSimilarToTrack(reference, recentIds);
      throwIfRequestResolutionAborted(signal);
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
    }, text, undefined, { timeoutMs: requestIntroTimeoutMs(entry), signal });
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

  // The literal parser is the authority for an explicit title+artist pair.
  // Such a request is an identity claim, so it bypasses the conversational
  // agent and uses the bounded catalogue resolver below. This is both faster
  // for voice clients and prevents an agent from turning "title by artist"
  // into a popular song by that artist. Vague, mood, similarity and lyric
  // requests still use the agent, including its existing web-search tool.
  const literal = modelFreeMatch(text);
  const lyricLike = isLyricOrFilmDescription(text);
  // A framed request with a concrete, attribute-free name is still a named
  // recording even when the lyric heuristic sees four or more free-form
  // words. Without this distinction, `play qzxv impossible recording 918273`
  // was sent to the evidence agent, whose empty search could be replaced by a
  // generic vibe candidate. Explicit lyric cues retain the evidence lane.
  const framedTitleOnly = isFramedTitleOnlyRequest(text, literal);
  entry.classification = framedTitleOnly ? 'named-song-or-artist' : classifyListenerRequest(text, literal);
  entry.stages = ['classified', 'local-literal'];
  // Long lyric/prose input can contain commas or "by" and look like an
  // artist-title pair to the literal parser. It is not an identity claim: the
  // web-aware request agent must get first chance to identify it. This keeps a
  // pasted verse from bypassing lyric search and selecting a random track by a
  // parser-invented artist.
  const explicitNamedRequest = !lyricLike && Boolean(literal.title?.trim() && literal.artist?.trim());
  // An explicit artist-only request is an identity claim too. It may choose
  // any eligible recording from that artist, but it must not fall through to
  // an unrelated mood, search, or starred-track substitute when the artist is
  // absent from the library.
  const artistPoolRequest = Boolean(literal.artist?.trim() && !literal.title?.trim() && !literal.album?.trim()
    && !literal.soundtrackContext && !literal.genre && !literal.language && !literal.mood);
  const explicitArtistOnlyRequest = artistPoolRequest && /\b(?:by|from)\b/iu.test(text);
  // A bare title+artist pair is already a complete identity plan. Keep it on
  // the local-first path instead of waiting on the optional interpreter; the
  // interpreter is still useful when the same named request carries an
  // explicit language, genre, or mood constraint that needs parsing.
  const bareExplicitNamedRequest = explicitNamedRequest
    && !literal.album && !literal.genre && !literal.language && !literal.mood;
  // A short, attribute-free request is more likely to be a title than a
  // conversational instruction. Resolve it against the local catalogue first
  // so a provider stall cannot delay a straightforward named request. It is an
  // identity claim: a miss must remain a miss rather than becoming an
  // unrelated fallback track.
  const likelyShortTitle = !lyricLike
    && literal.kind === 'track'
    && Boolean(literal.title?.trim())
    && !literal.artist && !literal.album
    && !literal.genre && !literal.language && !literal.mood
    && !(isGreetingLikeRequest(literal.title!) || isGenericRequestPhrase(literal.title!))
    // One-word asks are the high-confidence local-first case. Multi-word
    // text can be an unseparated artist+title ("Queen Bohemian Rhapsody") or
    // a broad instruction ("surprise me"), so a local miss must still reach
    // interpretation instead of being frozen into the wrong identity.
    && literal.title!.trim().split(/\s+/u).length === 1;
  // A multi-word title-only request is still an identity claim once the
  // literal parser has ruled out attributes and conversational frames. It may
  // use interpretation for repair, but a miss must never become an unrelated
  // fallback track.
  const broadUnresolvedFrame = /^(?:some|something|anything)\s+(?:from|in)\b/iu.test(literal.title || '')
    || /^some\s+.+\s+(?:for|with|in|and)\b/iu.test(literal.title || '');
  const titleOnlyNamedRequest = (framedTitleOnly || !lyricLike)
    && literal.kind === 'track'
    && Boolean(literal.title?.trim())
    && !literal.artist && !literal.album
    && !literal.genre && !literal.language && !literal.mood
    && !broadUnresolvedFrame
    && !(isGreetingLikeRequest(literal.title!) || isGenericRequestPhrase(literal.title!));
  // These forms already carry all the identity/attribute information the
  // deterministic resolver needs. Calling the interpreter first only adds a
  // failure point (and used to leave album/mood requests waiting on a slow
  // model even though the local parser had a complete plan).
  const deterministicLiteralRequest = (!lyricLike || Boolean(literal.album))
    && !explicitNamedRequest
    && (Boolean(literal.album?.trim())
      || Boolean(literal.genre?.trim())
      || Boolean(literal.language?.trim())
      || Boolean(literal.unresolvedLanguage?.trim())
      || Boolean(literal.mood?.trim()));
  const explicitNoMatchCue = /\b(?:no\s+such|doesn['’]?t\s+exist|does\s+not\s+exist|not\s+in\s+(?:the\s+)?(?:library|catalog(?:ue)?))\b/iu.test(literal.title || '');
  // A framed, unquoted multi-word name is still an identity claim when no
  // artist/attribute is present. Keep a miss honest instead of letting a model
  // omission turn "play qzxv no such recording" into an unrelated fallback.
  // Quoted title-only requests are recording identities too. Quotes strengthen
  // the no-substitution rule and must not open the alternative pool.
  const forcedNamedTitle = explicitNoMatchCue
    && literal.kind === 'track'
    && Boolean(literal.title?.trim())
    && !literal.artist && !literal.album
    && /^(?:please\s+)?(?:play|queue|request|put\s+on)\b/iu.test(text)
    && !/["'“‘]/u.test(text);
  const literalIdentityFrame = !/^\s*(?:please\s+)?(?:play|queue|request|put\s+on)\s+(?:anything|something|some|music|songs?|tracks?|a\s+song|a\s+track)\b/iu.test(text);

  // Conversational DJ agent. On any failure fall through to the stateless
  // cascade below, so a request is never dropped.
  // The agent is reserved for evidence-heavy identification. Named, mood,
  // genre and language requests must use the shared deterministic
  // resolver so every listener request follows the same deterministic path. Lyric and film
  // descriptions still use the existing web-aware agent path.
  // A generic "song from ..." remains eligible for web-backed film/lyric
  // identification, but an album/record relation is already a deterministic
  // local catalogue request. Sending it to the broad agent first lets a
  // stand-in tool queue an unrelated track before the album resolver can
  // verify the requested release.
  const soundtrackOnlineEnabled = settings.get().llm?.requestWebResolve === true;
  const needsEvidenceIdentification = isLyricOrFilmDescription(text)
    && !framedTitleOnly
    && !explicitArtistOnlyRequest
    && !literal.genre && !literal.language && !literal.unresolvedLanguage && !literal.mood
    && !literal.album
    // If structured soundtrack lookup is disabled, retain the existing
    // evidence-only agent fallback for agent-assisted stations. Direct mode
    // still ends safely as unsupported rather than selecting a substitute.
    && (!literal.soundtrackContext || !soundtrackOnlineEnabled);
  if (!explicitNamedRequest && !artistPoolRequest && !likelyShortTitle && !forcedNamedTitle && !titleOnlyNamedRequest && needsEvidenceIdentification && djAgent.requestMatchingEnabled()) {
    entry.stages.push('web-evidence');
    entry.evidenceSource = settings.get().search?.provider || 'duckduckgo';
    try {
      const agentRes = await djAgent.runRequest(queue, {
        requester,
        text,
        signal,
        evidenceOnly: true,
        introBudgetMs: () => requestIntroTimeoutMs(entry),
      });
      throwIfRequestResolutionAborted(signal);
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
          entry.candidateCount = agentRes.candidateCount || 0;
          entry.confidence = agentRes.confidence ?? null;
          return resolved({ ack: agentRes.ack, track: null, queuePosition: null });
        }
        if (agentRes.refused) {
          // The agent declined to queue and returned the track only so the ack and
          // log can name it: no queue position, no one-pending hold.
          queue.log('request', `agent refused (${agentRes.refused}): ${agentRes.track.title} — ${agentRes.track.artist}`);
          entry.path = 'agent';
          entry.pickSource = `agent:${agentRes.refused}`;
          entry.pick = agentRes.track;
          entry.candidateCount = agentRes.candidateCount || 1;
          entry.confidence = agentRes.confidence ?? 1;
          entry.refused = true;
          entry.outcome = agentRes.refused;
          return resolved({ ack: agentRes.ack, track: agentRes.track, queuePosition: null });
        }
        queue.log('request', `agent resolved: ${agentRes.track.title} — ${agentRes.track.artist}`);
        entry.path = 'agent';
        entry.pickSource = 'agent';
        entry.pick = agentRes.track;
        entry.candidateCount = agentRes.candidateCount || 1;
        entry.confidence = agentRes.confidence ?? 1;
        entry.introScript = agentRes.introScript || null;
        return resolved({
          ack: withWaitNotice(agentRes.ack, agentRes.track.id),
          track: agentRes.track,
          queuePosition: queue.upcoming.length,
        });
      }
    } catch (err) {
      if (err instanceof RequestIdentificationMiss) {
        entry.path = 'agent';
        entry.pickSource = 'agent:evidence-miss';
        entry.outcome = 'no-match';
        return failed(EVIDENCE_MISS_REFUSAL);
      }
      if (isWebSearchProviderError(err)) {
        entry.path = 'agent';
        entry.pickSource = 'agent:provider-error';
        entry.outcome = 'provider-error';
        entry.provider = err.provider;
        entry.providerFailure = err.reason;
        return failed('The configured search provider could not resolve that request. Try again shortly.');
      }
      // Provider, tool, timeout, and malformed-response failures retain the
      // stateless cascade. They are infrastructure failures, not evidence
      // misses, and should not be hidden behind a no-match response.
      queue.log('error', `DJ agent request failed — using stateless fallback: ${err.message}`);
    }
  }

  // 1. LLM matches intent; the current track lets vibe queries be read against
  // what is on air. Gated before generation: past the hard token cap with
  // requests not exempt, the model is not called at all.
  const currentTrack = queue.current?.track || null;
  // `modelFreeRequest` marks a one-word literal as `literal` so legacy
  // artist-only handling can consider it an artist. Once the local title-first
  // classifier has identified it as a short title candidate, keep the title
  // identity intact for the catalogue resolver instead.
  let matched = likelyShortTitle ? { ...literal, literal: false, titleOnly: true } : literal;
  const deicticSimilarityRequest = literal.intent === 'Wants more like the current track.';
  if (!artistPoolRequest && !likelyShortTitle && !forcedNamedTitle && !literal.similarTo && !deicticSimilarityRequest
    && !deterministicLiteralRequest && !literal.soundtrackContext && budget.requestsAllowed()) {
    try {
      // A title-only phrase may still benefit from model repair (for example,
      // an unseparated artist and title), but it must not spend the complete
      // request deadline before the local fuzzy catalogue gets a chance.
      const interpretationSignal = (titleOnlyNamedRequest || bareExplicitNamedRequest)
        ? signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_INTERPRETATION_MAX_MS)]) : AbortSignal.timeout(REQUEST_INTERPRETATION_MAX_MS)
        : signal;
      const interpreted = await dj.matchRequest(text, { listenerName: requester, nowPlaying: currentTrack }, interpretationSignal);
      throwIfRequestResolutionAborted(signal);
      if (explicitNamedRequest) {
        // Keep useful explicit attributes from the interpreter, but let the
        // request-match module pin title and artist identity to the listener's
        // literal pair.
        matched = (pinExplicitRequestMatch(interpreted, text) || literal) as typeof matched;
      } else {
        matched = repairRequestMatch(interpreted, text) as typeof matched;
      }
    } catch (err) {
      entry.interpretationFallback = true;
      queue.log('error', `request interpretation failed: ${err.message} — trying library search`);
    }
  }
  // Once a concrete track has been selected, the optional intro must not be
  // allowed to turn a successful request into a timeout. The intro helper has
  // its own bounded budget; queue admission below is the terminal handoff.
  matched = normalizeRequestMatch(matched, { moods: settings.moodVocab() });
  if (literal.releaseContext && literal.title?.trim()) {
    // Preserve the complete literal wording. The resolver will try the whole
    // title first, then the bounded title-plus-release-context hypothesis.
    matched = {
      ...matched,
      kind: 'track', title: literal.title, artist: literal.artist || null,
      album: null, releaseContext: literal.releaseContext, scope: 'song',
      literal: false, titleOnly: true,
      unsupported: literalIdentityFrame ? literal.unsupported || [] : matched.unsupported || literal.unsupported || [],
    };
  }
  if (forcedNamedTitle && literal.title?.trim()) {
    // Preserve the listener's literal title and do not let an interpreter
    // invent an artist that would widen the lookup.
    matched = {
      ...matched, kind: 'track', title: literal.title, artist: null, album: null,
      scope: 'song', literal: false, titleOnly: true,
    };
  }
  const quotedTitleFrame = /^\s*(?:please\s+)?(?:play|queue|request|put\s+on)\s+["'“‘]/iu.test(text);
  const conversationalTitleFrame = /^\s*(?:please\s+)?(?:i(?:['’]d|\s+would)?\s+(?:like|love|want|wanna|need)(?:\s+to)?|let\s+me)\s+(?:hear|listen\s+to)\s+/iu.test(text);
  const dedicationAfterQuote = quotedTitleFrame && /["'”’]\s*(?:for|to)\s+(?:my|the|a|an)\b/iu.test(text);
  if (literal.title?.trim() && (framedTitleOnly || quotedTitleFrame || conversationalTitleFrame
    || (titleOnlyNamedRequest && !matched.title && !matched.artist && !matched.album))) {
    // A quoted or conversational title is the listener's identity claim. A
    // model-invented relation is also unsafe for an unquoted title, so restore
    // the literal title while leaving soft model preferences available for an
    // honest preference acknowledgement.
    matched = {
      ...matched,
      kind: 'track', title: literal.title, artist: null, album: null,
      language: null,
      ...(dedicationAfterQuote ? { genre: null, mood: null } : {}),
      scope: 'song', literal: false, titleOnly: true,
    };
  }
  // The literal wording is the identity claim. If the interpreter repairs a
  // title-only request by adding an artist (for example, "Queen Bohemian
  // Rhapsody"), that artist must not reopen the unrelated alternative pool.
  // Named and unquoted title-only misses remain no-match even after repair.
  const exactTitleOnlyRequest = framedTitleOnly || titleOnlyNamedRequest;
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
  const named = matched.similarTo
    ? [matched.similarTo.raw]
    : matched.literal ? [] : [
      matched.artist,
      matched.title,
      ...nameSearchTerms(matched),
    ];
  const searches: Array<{ term: string; hits: any[] }> = [];
  const varietyWindow = settings.get().llm?.artistVarietyWindow ?? ARTIST_VARIETY_WINDOW;
  const cdMin = Number(settings.get().requests.repeatCooldownMin ?? 120);
  if (matched.language) {
    // Language-constrained requests use the local language projection. Older
    // databases without that optional migration return an empty pool and keep
    // the pre-existing no-match behaviour.
    try { await library.load(); } catch { /* the resolver reports no rows */ }
  }
  const decorateLanguages = (songs: any[]) => {
    const tags = library.languagesByIds(songs.map(song => String(song?.id || '')).filter(Boolean));
    return songs.map(song => {
      const tag = tags.get(String(song?.id || ''));
      return tag ? { ...song, language: tag.language || undefined, languages: tag.languages } : song;
    });
  };
  const requestSongs = (songs: any[]) => songs.map(song => ({
    ...song,
    title: song.title ?? undefined,
    artist: song.artist ?? undefined,
    album: song.album ?? undefined,
    year: song.year ?? undefined,
    genre: song.genre ?? undefined,
    language: song.language ?? undefined,
    languages: Array.isArray(song.languages) ? song.languages : undefined,
  }));
  const selection = await resolveDirectRequest(matched, {
    text,
    catalog: {
      ...subsonic,
      searchPage: async (term, options) => {
        const page = await subsonic.searchPage(term, options);
        const songs = decorateLanguages(page.songs);
        searches.push({ term, hits: songs });
        return { ...page, songs };
      },
      getAlbum: async id => decorateLanguages(await subsonic.getAlbum(id)),
      getTopSongs: async (name, options) => decorateLanguages(await subsonic.getTopSongs(name, options)),
      getSongsByGenreSampled: async (genre, options) => decorateLanguages(await subsonic.getSongsByGenreSampled(genre, options)),
      fuzzySearch: async (term, options = {}) => {
        await library.load();
        throwIfRequestResolutionAborted(options.signal);
        // Keep the database walk local and bounded. Candidate ranking remains
        // in request-match; this prefilter only avoids handing the resolver
        // the entire library and excludes blocked rows at the source.
        return library.candidateFilterTracks()
          .filter(row => row.title)
          .map(row => ({
            row,
            // Album-context recovery uses the same bounded local index as
            // title recovery. The resolver still verifies the album name and
            // artist before selecting anything, so this broadens discovery
            // without broadening identity acceptance.
            score: Math.max(
              requestTitleSimilarity(term, row.title),
              requestTextSimilarity(term, row.album),
              requestTextSimilarity(term, row.artist),
            ),
          }))
          .filter(candidate => candidate.score >= 0.60)
          .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id))
          .slice(0, 250)
          .filter(({ row }) => !library.isBlockedId(row.id))
          .slice(0, 100)
          .map(({ row }) => ({
            id: row.id,
            title: row.title ?? undefined,
            artist: row.artist ?? undefined,
            album: row.album ?? undefined,
            genres: row.genres,
            genre: row.genre ?? undefined,
            moods: row.moods,
          }));
      },
    },
    soundtrackCandidates: async context => {
      await library.load();
      throwIfRequestResolutionAborted(signal);
      const local = library.candidateFilterTracks()
        .filter(row => row.title && !library.isBlockedId(row.id))
        .map(row => {
          const metadata = library.get(row.id);
          return {
            id: row.id,
            title: row.title,
            artist: row.artist,
            album: metadata?.album,
            genres: row.genres,
            genre: row.genre,
            year: row.year,
          };
        });
      return resolveSoundtrackCandidates(context, local, {
        enabled: settings.get().llm?.requestWebResolve === true,
        signal,
      });
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
    exactOnly: explicitNamedRequest || explicitArtistOnlyRequest || likelyShortTitle || exactTitleOnlyRequest || forcedNamedTitle
      || Boolean(matched.album) || Boolean(matched.releaseContext) || Boolean(matched.similarTo)
      || Boolean(matched.unresolvedLanguage),
    signal,
    moodSongs: async mood => { await library.load(); return library.songsByMood(mood); },
    languageSongs: async language => {
      await library.load();
      return requestSongs(library.songsByLanguage(canonicalLanguage(language) || language));
    },
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
    ...(matched.similarTo
      ? {
        similarSeedSongs: async (seedId: string) => {
          await library.load();
          const excluded = new Set([...queue.queuedIds(), ...queue.recentlyPlayedIds(cdMin / 60), seedId]);
          const merged: any[] = [];
          const seen = new Set<string>();
          const add = (songs: any[], fallbackSimilarity: number) => {
            for (const [index, song] of (songs || []).entries()) {
              if (!song?.id || excluded.has(song.id) || seen.has(song.id)) continue;
              seen.add(song.id);
              merged.push({ ...song, _similarity: typeof song._similarity === 'number'
                ? song._similarity : Math.max(0, fallbackSimilarity - index / 100) });
            }
          };
          try { add(library.tracksLikeThisAudio(seedId, 60, { excludeIds: excluded }), 0.92); } catch (err) {
            queue.log('error', `named similarity audio lookup failed: ${err.message}`);
          }
          try {
            if (await subsonic.supportsSonicSimilarity()) {
              add(await subsonic.getSonicSimilarTracks(seedId, { count: 40 }), 0.78);
            }
          } catch (err) { queue.log('error', `named similarity sonic lookup failed: ${err.message}`); }
          try { add(await subsonic.getSimilarSongs(seedId, { count: 40 }), 0.62); } catch (err) {
            queue.log('error', `named similarity catalogue lookup failed: ${err.message}`);
          }
          // Metadata is a bounded last resort when the seed has no available
          // vector or Navidrome similarity extension. It never outranks a
          // real similarity source.
          if (!merged.length) {
            const seed = library.get(seedId);
            if (seed) {
              const seedGenres = new Set((seed.genres || []).map((value: string) => requestName(value)));
              const seedMoods = new Set((seed.moods || []).map((value: string) => requestName(value)));
              add(library.candidateFilterTracks()
                .filter(row => !excluded.has(row.id))
                .filter(row => row.genres.some(value => seedGenres.has(requestName(value)))
                  || row.moods.some(value => seedMoods.has(requestName(value)))
                  || (() => {
                    const candidate = library.get(row.id);
                    return !!(seed.bpm && candidate?.bpm && Math.abs(seed.bpm - candidate.bpm) <= 12);
                  })()), 0.35);
            }
          }
          return merged;
        },
      }
      : {}),
  });
  throwIfRequestResolutionAborted(signal);
  const pick = selection.track;
  const pickSource = selection.source;
  entry.stages.push('local-candidate-ranking');
  entry.candidateCount = new Set([
    ...searches.flatMap(search => search.hits.map(hit => hit?.id).filter(Boolean)),
    ...(selection.alternatives || []).map(candidate => candidate.id),
    ...(selection.track?.id ? [selection.track.id] : []),
  ]).size;
  entry.confidence = selection.confidence ?? (selection.track ? 1 : null);
  entry.outcome = selection.outcome;
  entry.lookupErrors = selection.errors;
  entry.unmetPreferences = selection.unmetPreferences || [];
  for (const error of selection.errors) queue.log('error', `request lookup ${error}`);
  if (!pick) {
    entry.pickSource = pickSource;
    if (selection.outcome === 'unsupported') {
      entry.unsupported = selection.unsupported || [];
      if (selection.unsupported?.includes('soundtrack identification')) {
        return failed('I need online soundtrack lookup enabled to identify a song from that movie or soundtrack.');
      }
      return failed(UNSUPPORTED_REFUSAL);
    }
    if (selection.outcome === 'provider-error') {
      return failed('The soundtrack lookup provider could not resolve that request. Please try again shortly.');
    }
    if (selection.outcome === 'timeout') {
      return failed('The soundtrack lookup took too long. Please try again shortly.');
    }
    if (selection.required?.length) {
      return failed('Could not verify a track meeting the requested language or genre requirements. Try simplifying the request.');
    }
    if (selection.alternatives?.length) {
      const choices = selection.alternatives
        .map(candidate => `"${candidate.title}" by ${candidate.artist}`)
        .join('; ');
      return failed(`I found a few close matches: ${choices}. Please request the title and artist again.`);
    }
    return failed(sorryNoMatch(requester));
  }
  // A search in the listener's own spelling answers in the library's ("Tupac"
  // finds 2Pac). That may be the same act, so the intro is not told it is not.
  const requestedArtist = matched.artist || (
    selection.source === 'similar-to-current' && matched.similarTo && !matched.similarTo.releaseContext
      ? matched.similarTo.artist || matched.similarTo.title
      : null
  );
  if (selection.outcome === 'substituted' && requestedArtist && !requestArtistMatches(requestedArtist, pick)
    && !matchedRequestLookups(searches, text).some(credit => requestArtistMatches(credit, pick))) {
    entry.artistMiss = requestedArtist;
    entry.missedArtist = cleanMissedArtist(requestedArtist);
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
  }, text, undefined, { timeoutMs: requestIntroTimeoutMs(entry), signal });
  // Once a concrete track has been selected, the optional intro must not be
  // allowed to turn a successful request into a timeout. The intro helper has
  // its own bounded budget; queue admission below is the terminal handoff.
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

// The HTTP handler returns the receipt before resolution starts, so this
// wrapper owns the lifecycle guarantee: every accepted request either reaches
// a normal terminal closure in resolveRequestCore or is failed here when the
// bounded wall-clock budget expires. A stalled provider must never leave the
// durable receipt pending forever.
function typedResolution(entry: ListenerRequestEntry): ListenerRequestResolution {
  const legacyOutcome = String(entry.outcome || 'no-match');
  const outcome: ListenerResolutionOutcome = legacyOutcome === 'already-queued' || legacyOutcome === 'cooldown'
    ? legacyOutcome
    : legacyOutcome === 'unsupported' || legacyOutcome === 'chat'
        ? 'unsupported'
        : legacyOutcome === 'timeout'
          ? 'timeout'
          : legacyOutcome === 'provider-error' || legacyOutcome === 'error'
            ? 'provider-error'
            : entry.status === 'resolved' && (entry.track || entry.pick)
              ? 'matched'
              : 'no-match';
  const track = entry.pick || entry.track || null;
  return {
    outcome,
    legacyOutcome,
    ack: entry.ack || null,
    message: entry.message || null,
    track: track ? { title: track.title, artist: track.artist, ...(track.id ? { id: track.id } : {}) } : null,
    queuePosition: typeof entry.queuePosition === 'number' ? entry.queuePosition : null,
  };
}

export async function resolveListenerRequest(entry: ListenerRequestEntry): Promise<ListenerRequestResolution> {
  try {
    await withDeadline(requestResolutionTimeoutMs(), 'request resolution', signal => resolveRequestCore(entry, signal));
  } catch (err) {
    if (entry.status === 'resolved' || entry.status === 'failed') return typedResolution(entry);
    const timedOut = err?.name === 'AgentDeadlineError'
      || /request resolution.*deadline|request resolution.*aborted/i.test(String(err?.message || ''));
    entry.outcome = timedOut ? 'timeout' : 'error';
    entry.status = 'failed';
    entry.message = timedOut
      ? 'The request took too long to resolve — try naming the title and artist.'
      : 'Something went wrong in the booth — try again.';
    queue.log('error', `Request resolution ${timedOut ? 'timed out' : 'failed'}: ${err?.message || err}`);
    recordOutcome(entry);
  }
  return typedResolution(entry);
}

// Validates + rate-limits synchronously, then resolves in the background.
// The shared schema owns the SHAPE and REFUSES over-cap text rather than slicing
// it; the guard pipeline below (sanitize → strip → screen) repairs instead, and
// needs server state the schema can't see.
// validatePublicBody, not validateBody: the one LISTENER-facing form, so the 400
// carries an unprefixed message plus the success/message keys the native app reads.
export async function submitListenerRequest(input: {
  text: string;
  name?: string;
  ip: string;
}): Promise<ListenerRequestSubmission> {
  // Keep every caller behind the same shape/size boundary. The browser
  // middleware already parsed this schema, but callers entering through this
  // shared function still need the same shape and size boundary.
  const parsed = listenerRequestSchema.safeParse({ text: input.text, name: input.name });
  if (!parsed.success) {
    return {
      accepted: false,
      statusCode: 400,
      error: parsed.error.issues[0]?.message || 'Invalid request',
    };
  }
  const cfg = (settings.get() as any)?.requests || {};
  if (REQUESTS_DISABLED || cfg.enabled === false) {
    return { accepted: false, statusCode: 503, message: 'Requests are temporarily closed.' };
  }

  // Zero-listener pause.
  await listeners.refresh();
  if (!listeners.djCallsAllowed()) {
    return {
      accepted: false,
      statusCode: 503,
      message: "The DJ's on autopilot — requests reopen when someone's tuned in.",
    };
  }

  // req.body is already the parsed shape. Only the cleaned text reaches the
  // session/prompts/air; the raw text is kept on the entry for the operator log.
  // The schema has bounded both the original text and its NFKC expansion.
  const rawText = parsed.data.text;
  const rawName = parsed.data.name;
  const stripped = stripScriptedOpener(sanitizeRequestText(rawText));
  const text = stripped.text;
  if (!text) {
    // Distinguish "typed nothing" from "it was all staging directions", which an
    // ordinary listener can hit via a false positive. Never echo the text back.
    return {
      accepted: false,
      statusCode: 400,
      error: stripped.injection
        ? "Couldn't read a song request in that — try just the artist, title, or a vibe."
        : 'Empty request',
    };
  }
  const s = settings.get() as any;
  const reservedNames = [
    'dj', 'admin', 'host', 'mod', 'moderator',
    s?.station || '',
    ...(Array.isArray(s?.personas) ? s.personas.map((p: any) => p?.name || '') : []),
  ];
  const requester = cleanRequesterName(rawName, reservedNames);

  const ip = input.ip;
  let entry: ListenerRequestEntry;
  {
    // Janitor runs BEFORE the gates: the one-pending hold returns 429 without
    // reaching the rest of the handler, so pruning later held an IP past the TTL.
    pruneRequests();
    const gate = checkRateLimit(ip);
    if (!gate.ok) {
      return {
        accepted: false,
        statusCode: 429,
        message: `Easy there — try again in ${gate.retryAfter}s.`,
        retryAfter: gate.retryAfter,
      };
    }
    const globalGate = checkGlobalRateLimit();
    if (!globalGate.ok) {
      return {
        accepted: false,
        statusCode: 429,
        message: 'The request line is busy — try again in a few minutes.',
        retryAfter: globalGate.retryAfter,
      };
    }
    // Both queue-state refusals carry the COOLDOWN as Retry-After: checkRateLimit
    // already stamped it, so the caller genuinely cannot succeed before it expires.
    const retryAfter = Number(cfg.cooldownSec) > 0 ? Number(cfg.cooldownSec) : 60;
    if (cfg.onePendingPerIp !== false && stillInFlight(lastByIp.get(ip), queue.queuedIds())) {
      return {
        accepted: false,
        statusCode: 429,
        message: 'Your last request is still queued — it airs first.',
        retryAfter,
      };
    }
    // LISTENER requests only — an operator's own studio push carries
    // `requestedBy: 'studio'` for the air-path exemptions and must not consume a
    // slot in the listener queue. See queue.pendingListenerRequests(). Requests
    // still resolving count too: they hold no queue slot yet, so a burst
    // accepted inside one resolution window would otherwise all pass. The brief
    // overlap between a push and its entry settling errs toward refusing.
    const pendingCount = queue.pendingListenerRequests() + resolvingRequestCount();
    if (pendingCount >= (Number(cfg.maxPending) || 6)) {
      return {
        accepted: false,
        statusCode: 429,
        message: "The request queue's full — try again in a few minutes.",
        retryAfter,
      };
    }

    // Spend the hourly budgets only after the queue-state gates: those reject
    // without queueing, and charging them burned the station-wide cap to zero on
    // rejections alone. The per-IP cooldown was already spent by checkRateLimit.
    commitRateLimit(ip);
    commitGlobalRateLimit();

    const id = randomUUID();
    entry = {
      id, status: 'pending', requester, text,
      provider: settings.get().search?.provider || 'duckduckgo',
      rawText: sanitizeRequestText(rawText),
      injection: stripped.injection,
      ack: null, track: null, queuePosition: null, message: null,
      createdAt: Date.now(),
    };
    requests.set(id, entry);
    lastByIp.set(ip, entry);
  }

  queue.log('request', `${requester}: "${text}" (id ${entry.id.slice(0, 8)})${stripped.injection ? ` [${stripped.injection} stripped]` : ''}`);
  webhooks.notify('request.received', { requestedBy: requester, text });
  void resolveListenerRequest(entry);
  return { accepted: true, requestId: entry.id, status: 'pending' };
}

router.post('/request', validatePublicBody(listenerRequestSchema), async (req, res) => {
  const { text, name } = req.body as { text: string; name: string };
  const submission = await submitListenerRequest({
    text,
    name,
    ip: clientIp(req),
  });
  if (!submission.accepted) {
    if (submission.retryAfter) res.setHeader('Retry-After', String(submission.retryAfter));
    if (submission.error) return res.status(submission.statusCode).json({ error: submission.error });
    return res.status(submission.statusCode).json({ success: false, message: submission.message });
  }

  // Hand back a receipt and let the browser poll the existing endpoint.
  res.status(202).json({ success: true, requestId: submission.requestId, status: submission.status });
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
