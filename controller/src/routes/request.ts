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
import { autoVoiceAllowed } from '../broadcast/voice-policy.js';
import * as webhooks from '../broadcast/webhooks.js';
import * as settings from '../settings.js';
import { withDeadline } from '../llm/internal/core/retry.js';
import {
  sanitizeRequestText, stripScriptedOpener, cleanRequesterName, cleanDedicationTarget, cleanMissedArtist, stillInFlight, screenAck,
  isNamedRequester, sorryNoMatch,
} from '../util/request-guard.js';
import {
  checkRateLimit, checkGlobalRateLimit, commitRateLimit, commitGlobalRateLimit, clientIp,
  REQUESTS_DISABLED,
} from '../middleware/ratelimit.js';
import { validatePublicBody } from '../middleware/validate.js';
import { listenerDedicationSchema, listenerRequestSchema } from '../schemas/request.js';
import { classifyListenerRequest, directRequestUnsupported, isRefusedOutcome, looksLikeLyricRequest, modelFreeRequest, nameSearchTerms, normalizeRequestMatch, pinExplicitRequestMatch, rankAliasCandidates, repairRequestMatch, requestArtistMatches, resolveDirectRequest } from '../music/request-match.js';
import { requestWaitClause } from '../broadcast/queue/pure.js';
import { matchedRequestLookups, matchedRequestStandIn } from '../util/request-claim.js';
import { ARTIST_VARIETY_WINDOW, drawRequestCandidate } from '../broadcast/dj-agent/artist-guard.js';
import { RequestIdentificationMiss } from '../broadcast/dj-agent/breaker.js';
import { isWebSearchProviderError, searchReady, searchWeb } from '../skills/web-search.js';
import * as requestLedger from '../broadcast/request-ledger.js';
import type { AlexaVerifiedCandidate } from '../alexa/listener-features.js';
import type { RequestDedication, RequestReminder, RequestReminderConsent } from '../broadcast/request-ledger.js';

export const router = express.Router();

export function verifiedCandidateMatches(
  pick: { id?: unknown } | null | undefined,
  candidate: AlexaVerifiedCandidate | null | undefined,
): boolean {
  return !candidate || String(pick?.id || '') === candidate.id;
}

export type ListenerRequestSource = 'browser' | 'alexa';
export type ListenerResolutionOutcome =
  | 'matched'
  | 'no-match'
  | 'already-queued'
  | 'cooldown'
  | 'unsupported'
  | 'provider-error';

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
  completion: Promise<ListenerRequestResolution>;
} | {
  accepted: false;
  statusCode: number;
  message?: string;
  error?: string;
  retryAfter?: number;
};

// In-memory request index for fast polling and admission checks. The durable
const requests = new Map();
const REQUEST_TTL_MS = 10 * 60 * 1000;
// A listener request is accepted asynchronously, but it must still reach a
// terminal state promptly. Provider generation has a much larger safety
// timeout for other call sites; letting that budget govern this route leaves a
// listener receipt pending for minutes when a model accepts a request and then
// stops answering. Keep this route's wall-clock bound independent and shorter.
const REQUEST_RESOLUTION_MAX_MS = 60_000;

function requestResolutionTimeoutMs(): number {
  const providerTimeout = Number((settings.get() as any)?.llm?.requestTimeoutMs);
  return Number.isFinite(providerTimeout) && providerTimeout > 0
    ? Math.min(REQUEST_RESOLUTION_MAX_MS, providerTimeout)
    : REQUEST_RESOLUTION_MAX_MS;
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

// Admission checks and their durable receipt/budget commit must be serialized.
// The ledger write is asynchronous, so without this short mutex concurrent
// callers could all observe the same global and pending-request counts before
// any of them committed its reservation.
let admissionTail = Promise.resolve();

async function acquireAdmissionLock(): Promise<() => void> {
  const previous = admissionTail;
  let release!: () => void;
  admissionTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return release;
}

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
      source: entry.source || 'browser',
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
      dedication: entry.dedication || null,
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

async function resolveNamedAlias(
  title: string,
  artistName: string,
  signal?: AbortSignal,
): Promise<{ track: any; provider: string } | null> {
  if (!searchReady()) return null;
  const provider = settings.get().search?.provider || 'duckduckgo';
  const web = await searchWeb(`"${title}" "${artistName}" alternate title song`, { signal });
  const evidence = [web.answer, ...(web.results || []).map(result => `${result.title}: ${result.content}`)]
    .filter(Boolean).join('\n').slice(0, 8000);
  if (!evidence) return null;
  const artist = await subsonic.resolveArtist(artistName, { signal });
  if (!artist?.id) return null;
  const full = await subsonic.getArtist(artist.id);
  const albums = (full?.album || []).slice(0, 20);
  const candidates: any[] = [];
  for (const album of albums) {
    throwIfRequestResolutionAborted(signal);
    candidates.push(...await subsonic.getAlbum(album.id, { signal }));
    if (candidates.length >= 300) break;
  }
  const track = rankAliasCandidates(title, artistName, candidates, evidence);
  return track ? { track, provider } : null;
}

// Requests accepted but not yet resolved. Their track is not in the upcoming
// queue until resolveRequest() pushes it, which can take the agent's whole
// timeout, so the maxPending gate counts them alongside the queued ones.
function resolvingRequestCount(): number {
  let n = 0;
  for (const entry of requests.values()) if (entry.status === 'pending') n++;
  return n;
}

async function resolveRequestCore(entry, signal?: AbortSignal) {
  const { requester, text } = entry;
  entry.startedAt = Date.now();

  const resolved = ({ ack, track, queuePosition }) => {
    if (entry.status === 'cancelled') return;
    entry.outcome ||= entry.refused ? 'already-queued' : track ? 'matched' : 'chat';
    entry.status = 'resolved';
    entry.ack = ack || null;
    entry.track = track || null;
    entry.queuePosition = typeof queuePosition === 'number' ? queuePosition : null;
    recordOutcome(entry);
    void requestLedger.update(entry.id, {
      status: 'resolved',
      ack: entry.ack,
      outcome: entry.outcome,
      track: entry.pick
        ? { id: entry.pick.id, title: entry.pick.title, artist: entry.pick.artist }
        : entry.track,
      queuePosition: entry.queuePosition,
      message: entry.message || null,
    }).catch(err => queue.log('error', `request ledger update failed: ${err.message}`));
  };
  const failed = (message) => {
    if (entry.status === 'cancelled') return;
    entry.outcome ||= 'no-match';
    entry.status = 'failed';
    entry.message = message;
    recordOutcome(entry);
    void requestLedger.update(entry.id, {
      status: 'failed',
      outcome: entry.outcome,
      message,
      track: entry.pick
        ? { id: entry.pick.id, title: entry.pick.title, artist: entry.pick.artist }
        : null,
      queuePosition: null,
    }).catch(err => queue.log('error', `request ledger update failed: ${err.message}`));
  };

  if (entry.status === 'cancelled') return;

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
      dedication: entry.dedication || null,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    }, text);
    throwIfRequestResolutionAborted(signal);
    if (generatedIntro.failure) {
      entry.introFailure = generatedIntro.failure;
      queue.log('error', 'more-like-this optional intro failed — queueing without speech');
    }
    if (generatedIntro.guard) {
      flagGuard(entry, generatedIntro.guard);
      queue.log('request-guard', `more-like-this intro echoed request text — ${generatedIntro.guard}`);
    }
    const introScript = generatedIntro.introScript;
    if (entry.status === 'cancelled') return;
    const pos = await queue.push({
      track: pick, requestId: entry.id, requestedBy: requester, dedication: entry.dedication || null, intent: 'more_like_this', introScript,
      introKind: 'dj-speak',
      // Voice it as whoever wrote it: render and air happen later and would
      // otherwise re-resolve the speaker off the wall clock.
      introPersona: generatedIntro.introPersona,
      introHostSpeech: generatedIntro.introHostSpeech,
    });
    if (entry.status === 'cancelled' || signal?.aborted) {
      if (pos >= 0) await queue.removeUpcomingRequest(entry.id).catch(() => undefined);
      throwIfRequestResolutionAborted(signal);
      return;
    }
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
  const lyricLike = looksLikeLyricRequest(text);
  entry.classification = classifyListenerRequest(text, literal);
  entry.stages = ['classified', 'local-literal'];
  // Long lyric/prose input can contain commas or "by" and look like an
  // artist-title pair to the literal parser. It is not an identity claim: the
  // web-aware request agent must get first chance to identify it. This keeps a
  // pasted verse from bypassing lyric search and selecting a random track by a
  // parser-invented artist.
  const explicitNamedRequest = !lyricLike && Boolean(literal.title?.trim() && literal.artist?.trim());
  // A short, attribute-free request is more likely to be a title than a
  // conversational instruction. Resolve it against the local catalogue first
  // so a provider stall cannot delay a straightforward named request. It is an
  // identity claim: a miss must remain a miss rather than becoming an
  // unrelated fallback track.
  const likelyShortTitle = !lyricLike
    && literal.kind === 'track'
    && Boolean(literal.title?.trim())
    && !literal.artist && !literal.album
    && !literal.genre && !literal.language && !literal.mood && !literal.energy
    && !/^(?:hello|hi|hey|surprise|anything|something|music)(?:\s+(?:me|dj|radio|there|subwave|chill\s+zone))?[.!?]*$/iu.test(literal.title!.trim())
    // One-word asks are the high-confidence local-first case. Multi-word
    // text can be an unseparated artist+title ("Queen Bohemian Rhapsody") or
    // a broad instruction ("surprise me"), so a local miss must still reach
    // interpretation instead of being frozen into the wrong identity.
    && literal.title!.trim().split(/\s+/u).length === 1;
  const explicitNoMatchCue = /\b(?:no\s+such|doesn['’]?t\s+exist|does\s+not\s+exist|not\s+in\s+(?:the\s+)?(?:library|catalog(?:ue)?))\b/iu.test(literal.title || '');
  // A framed, unquoted multi-word name is still an identity claim when no
  // artist/attribute is present. Keep a miss honest instead of letting a model
  // omission turn "play qzxv no such recording" into an unrelated fallback.
  // Quoted title-only requests retain the existing alternative policy.
  const forcedNamedTitle = explicitNoMatchCue
    && literal.kind === 'track'
    && Boolean(literal.title?.trim())
    && !literal.artist && !literal.album
    && /^(?:please\s+)?(?:play|queue|request|put\s+on)\b/iu.test(text)
    && !/["'“‘]/u.test(text);

  // Conversational DJ agent. On any failure fall through to the stateless
  // cascade below, so a request is never dropped.
  // The agent is reserved for evidence-heavy identification. Named, mood,
  // energy, genre, and language requests must use the shared deterministic
  // resolver so every listener request follows the same deterministic path. Lyric and film
  // descriptions still use the existing web-aware agent path.
  const needsEvidenceIdentification = lyricLike
    || /\b(?:song|track|music)\s+(?:from|in)\b.{0,60}\b(?:film|movie|show|advert|commercial)\b/iu.test(text);
  if (!explicitNamedRequest && !likelyShortTitle && !forcedNamedTitle && needsEvidenceIdentification && djAgent.requestMatchingEnabled()) {
    entry.stages.push('web-evidence');
    entry.evidenceSource = settings.get().search?.provider || 'duckduckgo';
    try {
      const agentRes = await djAgent.runRequest(queue, { requester, text, signal });
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
        if (entry.status === 'cancelled') return;
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
  if (!likelyShortTitle && !forcedNamedTitle && budget.requestsAllowed()) {
    try {
      const interpreted = await dj.matchRequest(text, { listenerName: requester, nowPlaying: currentTrack }, signal);
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
  throwIfRequestResolutionAborted(signal);
  matched = normalizeRequestMatch(matched, { moods: settings.moodVocab() });
  if (forcedNamedTitle && literal.title?.trim()) {
    // Preserve the listener's literal title and do not let an interpreter
    // invent an artist that would widen the lookup.
    matched = { ...matched, kind: 'track', title: literal.title, artist: null, album: null, scope: 'song', literal: false, titleOnly: true };
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
  let selection = await resolveDirectRequest(matched, {
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
    exactOnly: explicitNamedRequest || likelyShortTitle || forcedNamedTitle,
    moodSongs: async mood => { await library.load(); return library.songsByMood(mood); },
    energySongs: async energy => { await library.load(); return library.songsByEnergy(energy); },
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
  throwIfRequestResolutionAborted(signal);
  let pick = selection.track;
  let pickSource = selection.source;
  entry.stages.push('local-candidate-ranking');
  entry.candidateCount = new Set([
    ...searches.flatMap(search => search.hits.map(hit => hit?.id).filter(Boolean)),
    ...(selection.alternatives || []).map(candidate => candidate.id),
    ...(selection.track?.id ? [selection.track.id] : []),
  ]).size;
  entry.confidence = selection.confidence ?? (selection.track ? 1 : null);
  if (!selection.track && explicitNamedRequest && literal.title && literal.artist && selection.outcome !== 'unsupported') {
    entry.stages.push('web-alias-verification');
    try {
      const alias = await resolveNamedAlias(literal.title, literal.artist, signal);
      if (alias) {
        selection = {
          ...selection,
          track: alias.track,
          source: 'web-alias',
          outcome: 'matched',
          confidence: 0.95,
          alternatives: [],
        };
        pick = selection.track;
        pickSource = selection.source;
        entry.evidenceSource = alias.provider;
        entry.candidateCount = Math.max(entry.candidateCount, 1);
        entry.confidence = selection.confidence;
      }
    } catch (err) {
      if (isWebSearchProviderError(err)) {
        entry.provider = err.provider;
        entry.providerFailure = err.reason;
        // Alternate-title verification is an optional enrichment after the
        // local identity lanes. A station using the built-in DDG default may
        // be offline while still handling named requests deterministically;
        // keep that miss honest instead of turning every explicit typo into a
        // provider outage. Explicitly configured providers remain typed errors.
        if (err.provider === 'duckduckgo') {
          entry.finalReason = `web-alias-${err.reason}`;
          entry.pickSource = 'no-match';
          entry.outcome = 'no-match';
          return failed(EVIDENCE_MISS_REFUSAL);
        }
        entry.outcome = 'provider-error';
        return failed('The configured search provider could not verify that alternate title. Try again shortly.');
      }
      if (signal?.aborted) throw err;
      queue.log('error', `request alias verification failed: ${err.message}`);
    }
  }
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
  // Generated listener features already selected a concrete library track.
  // Keep the shared resolver's safety checks, but do not let its substitution
  // policy silently replace that selection with a different song when the
  // catalogue changed between feature lookup and request resolution.
  if (!verifiedCandidateMatches(pick, entry.verifiedCandidate)) {
    entry.pickSource = `${pickSource}:verified-candidate-mismatch`;
    entry.outcome = 'no-match';
    return failed('The selected track could not be verified in the library. Please try that request again.');
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
    dedication: entry.dedication || null,
    artistMiss: !!entry.artistMiss,
    missedArtist: entry.missedArtist ?? null,
    requestSubstitution: selection.outcome === 'substituted',
    recap: queue.getDjRecap(),
    recentTracks: queue.getRecentTracks(),
    recentOpeners: queue.getRecentOpeners(),
  }, text);
  throwIfRequestResolutionAborted(signal);
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
  if (entry.status === 'cancelled') return;
  throwIfRequestResolutionAborted(signal);
  const pos = await queue.push({
    track: pick,
    requestId: entry.id,
    requestedBy: requester,
    dedication: entry.dedication || null,
    intent: matched.intent,
    introScript,
    introKind: 'dj-speak',
    introPersona: generatedIntro.introPersona,
    introHostSpeech: generatedIntro.introHostSpeech,
  });
  if (entry.status === 'cancelled' || signal?.aborted) {
    if (pos >= 0) await queue.removeUpcomingRequest(entry.id).catch(() => undefined);
    throwIfRequestResolutionAborted(signal);
    return;
  }
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
function typedResolution(entry): ListenerRequestResolution {
  const legacyOutcome = String(entry.outcome || 'no-match');
  const outcome: ListenerResolutionOutcome = legacyOutcome === 'already-queued' || legacyOutcome === 'cooldown'
    ? legacyOutcome
    : legacyOutcome === 'unsupported' || legacyOutcome === 'chat'
      ? 'unsupported'
      : legacyOutcome === 'provider-error' || legacyOutcome === 'timeout' || legacyOutcome === 'error'
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

export async function resolveListenerRequest(entry): Promise<ListenerRequestResolution> {
  try {
    await withDeadline(requestResolutionTimeoutMs(), 'request resolution', signal => resolveRequestCore(entry, signal));
  } catch (err) {
    if (entry.status === 'cancelled' || entry.status === 'resolved' || entry.status === 'failed') return typedResolution(entry);
    const timedOut = err?.name === 'AgentDeadlineError'
      || /request resolution.*deadline|request resolution.*aborted/i.test(String(err?.message || ''));
    entry.outcome = timedOut ? 'timeout' : 'error';
    entry.status = 'failed';
    entry.message = timedOut
      ? 'The request took too long to resolve — try naming the title and artist.'
      : 'Something went wrong in the booth — try again.';
    queue.log('error', `Request resolution ${timedOut ? 'timed out' : 'failed'}: ${err?.message || err}`);
    recordOutcome(entry);
    await requestLedger.update(entry.id, {
      status: 'failed',
      outcome: entry.outcome,
      message: entry.message,
    }).catch(updateError => queue.log('error', `request ledger failure update failed: ${updateError.message}`));
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
  source: ListenerRequestSource;
  alexaIdentity?: string;
  /**
   * A catalogue selection made by a typed listener feature. The normal
   * resolver still performs all admission, blocklist and cooldown checks, but
   * it may not turn this exact selection into an unrelated substitution.
   */
  verifiedCandidate?: AlexaVerifiedCandidate;
  dedication?: { target: string; locale?: 'en-US' | 'en-IN' | 'hi-IN' };
}): Promise<ListenerRequestSubmission> {
  // Keep every caller behind the same shape/size boundary. The browser
  // middleware already parsed this schema, but Alexa and future voice clients
  // enter through this function directly.
  const parsed = listenerRequestSchema.safeParse({ text: input.text, name: input.name });
  if (!parsed.success) {
    return {
      accepted: false,
      statusCode: 400,
      error: parsed.error.issues[0]?.message || 'Invalid request',
    };
  }
  let dedication: RequestDedication | null = null;
  if (input.dedication) {
    const dedicationParsed = listenerDedicationSchema.safeParse(input.dedication);
    const target = cleanDedicationTarget(dedicationParsed.success ? dedicationParsed.data.target : input.dedication.target);
    if (!dedicationParsed.success || !target) {
      return { accepted: false, statusCode: 400, error: 'Tell me who the dedication is for.' };
    }
    if (!autoVoiceAllowed()) {
      return { accepted: false, statusCode: 503, message: 'Dedications are unavailable while station voice is off.' };
    }
    dedication = { target, locale: dedicationParsed.data.locale };
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
  let entry: any;
  const releaseAdmission = await acquireAdmissionLock();
  try {
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

    const id = randomUUID();
    entry = {
      id, status: 'pending', requester, text, source: input.source,
      clientKey: ip,
      alexaIdentity: input.alexaIdentity,
      verifiedCandidate: input.verifiedCandidate,
      dedication,
      provider: settings.get().search?.provider || 'duckduckgo',
      rawText: sanitizeRequestText(rawText),
      injection: stripped.injection,
      ack: null, track: null, queuePosition: null, message: null,
      createdAt: Date.now(),
    };
    requests.set(id, entry);
    lastByIp.set(ip, entry);

    // Persist the receipt while admission is still serialized. An accepted
    // request must never be returned without a durable status for Alexa to
    // query after a restart.
    try {
      await requestLedger.createPending({
        id,
        createdAt: entry.createdAt,
        source: input.source === 'browser' ? 'web' : 'alexa',
        requester,
        text,
        alexaIdentity: input.alexaIdentity,
        dedication,
      });
    } catch (error) {
      requests.delete(id);
      if (lastByIp.get(ip) === entry) lastByIp.delete(ip);
      queue.log('error', `request ledger create failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return { accepted: false, statusCode: 500, message: 'Unable to record the request right now.' };
    }

    // Spend the hourly budgets only after the queue-state gates and durable
    // receipt. Rejected or unrecorded requests do not consume a station slot.
    commitRateLimit(ip);
    commitGlobalRateLimit();
  } finally {
    // Resolution can spend tens of seconds in the model and web search. It must
    // never hold the admission mutex while doing that slow work.
    releaseAdmission();
  }

  queue.log('request', `${requester}: "${text}" (id ${entry.id.slice(0, 8)})${stripped.injection ? ` [${stripped.injection} stripped]` : ''}`);
  webhooks.notify('request.received', { requestedBy: requester, text, source: input.source });
  const completion = Promise.resolve().then(() => resolveListenerRequest(entry));
  return { accepted: true, requestId: entry.id, status: 'pending', completion };
}

router.post('/request', validatePublicBody(listenerRequestSchema), async (req, res) => {
  const { text, name } = req.body as { text: string; name: string };
  const submission = await submitListenerRequest({
    text,
    name,
    ip: clientIp(req),
    source: 'browser',
  });
  if (!submission.accepted) {
    if (submission.retryAfter) res.setHeader('Retry-After', String(submission.retryAfter));
    if (submission.error) return res.status(submission.statusCode).json({ error: submission.error });
    return res.status(submission.statusCode).json({ success: false, message: submission.message });
  }

  // Hand back a receipt and let go of the connection. The completion promise
  // is retained by voice clients; browser clients poll the existing endpoint.
  res.status(202).json({ success: true, requestId: submission.requestId, status: submission.status });
});

export type RequestPhase = 'pending' | 'queued' | 'playing' | 'finished' | 'interrupted' | 'cancelled' | 'resolved' | 'failed';

export interface ListenerRequestStatus {
  status: 'pending' | 'resolved' | 'failed' | 'cancelled' | 'unknown';
  success: boolean;
  requestId?: string;
  phase?: RequestPhase;
  ack?: string | null;
  track?: { title?: string | null; artist?: string | null } | null;
  queuePosition?: number | null;
  etaSeconds?: number | null;
  outcome?: string | null;
  message?: string | null;
  dedication?: RequestDedication | null;
  reminder?: RequestReminder | null;
}

export type PublicListenerRequestStatus = Omit<ListenerRequestStatus, 'reminder'> & {
  reminder?: Omit<RequestReminder, 'alertToken'> | null;
};

export function publicListenerRequestStatus(status: ListenerRequestStatus): PublicListenerRequestStatus {
  const { reminder, ...withoutReminder } = status;
  return {
    ...withoutReminder,
    reminder: reminder
      ? {
          createdAt: reminder.createdAt,
          triggerAt: reminder.triggerAt,
          forecastSeconds: reminder.forecastSeconds,
          leadSeconds: reminder.leadSeconds,
        }
      : reminder,
  };
}

function queueStatusFor(id: string): { phase: RequestPhase; queuePosition?: number; etaSeconds?: number | null } | null {
  const upcomingIndex = queue.upcoming.findIndex(item => item.requestId === id);
  if (upcomingIndex >= 0) {
    return {
      phase: 'queued',
      queuePosition: upcomingIndex + 1,
      etaSeconds: queue.airForecastSec(queue.upcoming[upcomingIndex]),
    };
  }
  if (queue.current?.requestId === id) return { phase: 'playing' };
  if (queue.history.some(item => item.requestId === id)) return { phase: 'finished' };
  return null;
}

function statusFromRecord(record: requestLedger.RequestLedgerRecord): ListenerRequestStatus {
  const queueState = queueStatusFor(record.id);
  const phase: RequestPhase = queueState?.phase
    || (record.status === 'pending' ? 'pending' : record.status);
  return {
    status: record.status === 'interrupted' ? 'failed' : record.status,
    success: record.status === 'resolved',
    requestId: record.id,
    phase,
    ack: record.ack ?? null,
    track: record.track ?? null,
    queuePosition: queueState?.queuePosition ?? record.queuePosition ?? null,
    etaSeconds: queueState?.etaSeconds ?? null,
    outcome: record.outcome ?? null,
    message: record.message ?? null,
    dedication: record.dedication ?? null,
    reminder: record.reminder ?? null,
  };
}

export function getListenerRequestStatus(id: string): ListenerRequestStatus {
  const entry = requests.get(id);
  if (entry) {
    const queueState = queueStatusFor(id);
    return {
      status: entry.status,
      success: entry.status === 'resolved',
      requestId: id,
      phase: queueState?.phase || (entry.status === 'pending' ? 'pending' : entry.status),
      ack: entry.ack,
      track: entry.track,
      queuePosition: queueState?.queuePosition ?? entry.queuePosition,
      etaSeconds: queueState?.etaSeconds ?? null,
      outcome: entry.outcome,
      message: entry.message,
      dedication: entry.dedication ?? null,
      reminder: entry.reminder ?? null,
    };
  }
  const record = requestLedger.get(id);
  return record ? statusFromRecord(record) : { status: 'unknown', success: false };
}

export async function getLatestAlexaRequestStatus(identity: string): Promise<ListenerRequestStatus | null> {
  const record = requestLedger.latestForAlexa(identity);
  return record ? getListenerRequestStatus(record.id) : null;
}

export async function getAlexaRequestStatus(identity: string, id: string): Promise<ListenerRequestStatus | null> {
  const record = requestLedger.get(id);
  if (!record || record.source !== 'alexa' || record.alexaIdentity !== identity) return null;
  return getListenerRequestStatus(id);
}

export async function saveAlexaRequestReminder(
  identity: string,
  id: string,
  reminder: RequestReminder,
): Promise<ListenerRequestStatus | null> {
  const record = requestLedger.get(id);
  if (!record || record.source !== 'alexa' || record.alexaIdentity !== identity) return null;
  const before = getListenerRequestStatus(id);
  if (before.phase !== 'queued' || before.reminder?.alertToken) return null;
  const updated = await requestLedger.setReminder(id, reminder);
  if (!updated) return null;
  const entry = requests.get(id);
  if (entry) entry.reminder = reminder;
  const after = getListenerRequestStatus(id);
  if (after.phase !== 'queued') {
    await requestLedger.clearReminder(id);
    if (entry) entry.reminder = null;
    return null;
  }
  return after;
}

export async function clearAlexaRequestReminder(identity: string, id: string): Promise<boolean> {
  const record = requestLedger.get(id);
  if (!record || record.source !== 'alexa' || record.alexaIdentity !== identity || !record.reminder?.alertToken) {
    return false;
  }
  const updated = await requestLedger.clearReminder(id);
  if (!updated) return false;
  const entry = requests.get(id);
  if (entry) entry.reminder = null;
  return true;
}

export async function saveAlexaReminderConsent(
  identity: string,
  id: string,
  consent: RequestReminderConsent,
): Promise<boolean> {
  const record = requestLedger.get(id);
  if (!record || record.source !== 'alexa' || record.alexaIdentity !== identity) return false;
  const before = getListenerRequestStatus(id);
  if (before.phase !== 'queued' || before.reminder?.alertToken) return false;
  return Boolean(await requestLedger.setReminderConsent(id, consent));
}

export async function getAlexaReminderConsent(
  identity: string,
  permissionToken: string,
): Promise<{
  requestId: string;
  identity: string;
  locale: RequestReminderConsent['locale'];
  permissionToken: string;
} | null> {
  return requestLedger.findReminderConsent(identity, permissionToken);
}

export async function clearAlexaReminderConsent(identity: string, id: string): Promise<boolean> {
  const record = requestLedger.get(id);
  if (!record || record.source !== 'alexa' || record.alexaIdentity !== identity) return false;
  return Boolean(await requestLedger.clearReminderConsent(id));
}

type RequestCancellationDecision = 'cancelled' | 'cancelable' | 'too-late' | 'unknown';

function requestCancellationDecision(status: ListenerRequestStatus): RequestCancellationDecision {
  if (status.phase === 'cancelled') return 'cancelled';
  if (status.phase === 'pending' || status.phase === 'queued') return 'cancelable';
  if (status.phase === 'playing' || status.phase === 'finished') return 'too-late';
  return 'unknown';
}

async function cancelRequestById(id: string): Promise<ListenerRequestStatus | null> {
  const entry = requests.get(id);
  if (entry?.status === 'cancelled') {
    entry.reminder = null;
    return getListenerRequestStatus(id);
  }

  if (entry?.status === 'pending') {
    entry.status = 'cancelled';
    entry.outcome = 'cancelled';
    entry.message = 'Cancelled by listener.';
    entry.reminder = null;
    if (lastByIp.get(entry.clientKey) === entry) lastByIp.delete(entry.clientKey);
    recordOutcome(entry);
    await requestLedger.update(id, {
      status: 'cancelled',
      outcome: entry.outcome,
      message: entry.message,
      reminder: null,
    });
    return getListenerRequestStatus(id);
  }

  const current = getListenerRequestStatus(id);
  const decision = requestCancellationDecision(current);
  if (decision === 'cancelled' || decision === 'too-late') return current;
  if (decision !== 'cancelable') return null;
  const removed = await queue.removeUpcomingRequest(id);
  if (!removed.ok) return removed.reason === 'already-playing' ? getListenerRequestStatus(id) : null;

  if (entry) {
    entry.status = 'cancelled';
    entry.outcome = 'cancelled';
    entry.message = 'Cancelled by listener.';
    entry.reminder = null;
    recordOutcome(entry);
  }
  await requestLedger.update(id, {
    status: 'cancelled',
    outcome: 'cancelled',
    message: 'Cancelled by listener.',
    reminder: null,
  });
  return getListenerRequestStatus(id);
}

export async function cancelLatestAlexaRequest(identity: string): Promise<ListenerRequestStatus | null> {
  const record = requestLedger.latestForAlexa(identity);
  return record ? cancelRequestById(record.id) : null;
}

export async function replaceLatestAlexaRequest(identity: string, text: string): Promise<ListenerRequestSubmission> {
  const current = requestLedger.latestForAlexa(identity);
  if (current) {
    const status = getListenerRequestStatus(current.id);
    const decision = requestCancellationDecision(status);
    if (decision === 'too-late') {
      return { accepted: false, statusCode: 429, message: 'Your previous request is already playing or has finished.' };
    }
    if (decision === 'cancelable') {
      const cancelled = await cancelRequestById(current.id);
      if (cancelled?.phase !== 'cancelled') {
        return { accepted: false, statusCode: 429, message: 'Your previous request could not be replaced because it has reached the player.' };
      }
    }
  }
  const identityKey = `alexa:${identity}`;
  return submitListenerRequest({
    text,
    name: '',
    ip: identityKey,
    source: 'alexa',
    alexaIdentity: identity,
  });
}

/** Reconcile durable receipts with queue.json after queue.recover(). */
export async function reconcileRequestLedger(): Promise<void> {
  const known = new Set<string>();
  for (const item of [...queue.upcoming, queue.current, ...queue.history]) {
    if (item?.requestId) known.add(item.requestId);
  }
  await requestLedger.interruptUnresolved(known);
}

// Poll for the outcome of a submitted request.
router.get('/request/:id', (req, res) => {
  const status = getListenerRequestStatus(req.params.id);
  if (status.status === 'unknown') {
    // Never existed, or pruned / lost to a restart; the UI stops polling.
    return res.status(404).json({ status: 'unknown' });
  }
  return res.json(publicListenerRequestStatus(status));
});
