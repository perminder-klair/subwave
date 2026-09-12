// Listener track requests. POST returns a request id immediately; matching, the
// pick cascade, intro generation and enqueue run in the background, and
// GET /request/:id reports the outcome.
import express from 'express';
import { randomUUID } from 'node:crypto';
import * as subsonic from '../music/subsonic.js';
import * as dj from '../llm/dj.js';
import * as library from '../music/library.js';
import { exactTitleByArtist } from '../music/request-match.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';
import * as session from '../broadcast/session.js';
import * as requestLog from '../broadcast/request-log.js';
import * as listeners from '../broadcast/listeners.js';
import { autoVoiceAllowed } from '../broadcast/voice-policy.js';
import * as webhooks from '../broadcast/webhooks.js';
import * as settings from '../settings.js';
import { stripScriptedOpener, cleanRequesterName, stillInFlight, screenAck, guardIntro, isNamedRequester, sorryNoMatch } from '../util/request-guard.js';
import {
  checkRateLimit, checkGlobalRateLimit, commitRateLimit, commitGlobalRateLimit, clientIp,
  REQUESTS_DISABLED,
} from '../middleware/ratelimit.js';
import { validatePublicBody } from '../middleware/validate.js';
import { listenerRequestSchema } from '../schemas/request.js';
import { shuffle } from '../util/shuffle.js';
import { requestWaitClause } from '../broadcast/queue/pure.js';

export const router = express.Router();

// Strip prompt-injection markup from listener text before it is stored, logged,
// displayed or fed to the LLM. A belt over the prompt framing, not the only layer.
function sanitizeRequestText(raw: string): string {
  return String(raw ?? '')
    // chat/template role + instruction tokens
    .replace(/\[\/?INST\]|<<\/?SYS>>|<\|[^|>]*\|>/gi, ' ')
    // any HTML/XML-ish tag
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    // leading role markers that fake a new turn
    .replace(/^[ \t]*(system|assistant|developer)\s*:/gim, ' ')
    // the "ignore the previous instructions" family
    .replace(/\b(ignore|disregard|forget|override)\b[^.!?\n]*\b(previous|prior|above|earlier|all)\b[^.!?\n]*\binstructions?\b/gi, ' ')
    // double quotes would break out of the "${text}" framing
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

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

// "latest album by X" style requests: resolve artist, sort albums, pick a song.
async function pickByArtistAndSort({ artistName, sort, scope: _scope, recentIds }: { artistName: string; sort: string | null; scope: string; recentIds: Set<string> }) {
  try {
    // Fuzzy so a transliteration variance or typo still lands on the artist.
    const matchedArtist = await subsonic.resolveArtist(artistName);
    if (!matchedArtist) return null;
    const artist = await subsonic.getArtist(matchedArtist.id);
    let albums = artist?.album || [];
    if (albums.length === 0) return null;

    if (sort === 'latest') {
      albums = [...albums].sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (sort === 'oldest') {
      albums = [...albums].sort((a, b) => (a.year || 9999) - (b.year || 9999));
    } else if (!sort) {
      // Bare "play <artist>": shuffle so picks spread across the catalogue
      // instead of always hitting the first album Subsonic returns.
      albums = shuffle(albums);
    }
    // sort=popular leaves Subsonic's order. Walk down the list when the
    // top album's tracks are all recently played.
    for (const album of albums.slice(0, 5)) {
      const songs = await subsonic.getAlbum(album.id);
      if (songs.length === 0) continue;
      const fresh = songs.filter(s => !recentIds.has(s.id));
      const pool = fresh.length > 0 ? fresh : songs;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  } catch (err) {
    queue.log('error', `pickByArtistAndSort failed: ${err.message}`);
  }
  return null;
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

// search3 can't query the genre tag, so genre requests need an exact genre name
// for getSongsByGenre. Returns the matched name or null.
async function resolveGenre(name) {
  try {
    return await subsonic.resolveGenreName(name);
  } catch (err) {
    queue.log('error', `resolveGenre failed: ${err.message}`);
    return null;
  }
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
      track: entry.pick
        ? { title: entry.pick.title, artist: entry.pick.artist, id: entry.pick.id }
        : (entry.track || null),
      ack: entry.ack || null,
      introScript: entry.introScript || null,
      message: entry.message || null,
      guard: entry.guard ?? null,
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

async function resolveRequest(entry) {
  const { requester, text } = entry;
  entry.startedAt = Date.now();

  const resolved = ({ ack, track, queuePosition }) => {
    entry.status = 'resolved';
    entry.ack = ack || null;
    entry.track = track || null;
    entry.queuePosition = typeof queuePosition === 'number' ? queuePosition : null;
    recordOutcome(entry);
  };
  const failed = (message) => {
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
    // Requests stay near-unfiltered: 2h skips the song still ringing in their
    // ears without blocking a re-request from earlier today.
    const recentIds = queue.recentlyPlayedIds(2);
    for (const id of queue.queuedIds()) recentIds.add(id);
    // Same artist first, then real track similarity so a one-off collab credit
    // playing now doesn't dead-end the request.
    let pick = await pickByArtistAndSort({
      artistName: refArtist, sort: null, scope: 'song', recentIds,
    });
    if (!pick) {
      pick = await pickSimilarToTrack(reference, recentIds);
      if (pick) entry.pickSource = 'more-like-this:similar';
    }
    if (!pick) {
      return failed(`Couldn't find anything close to "${reference?.track?.title || refArtist}" in the crates.`);
    }
    // The fallback can land on a different artist; phrase the ack from the pick.
    const sameArtist = !!pick.artist && pick.artist === refArtist;
    const ackLine = sameArtist ? `More from ${refArtist}, coming up.` : `More like that, coming up.`;
    // Station voice off: request still honoured and acked, no spoken intro and
    // no model call to write one.
    let introScript = autoVoiceAllowed()
      ? await dj.generateIntro({
        track: pick,
        context: ctx,
        requestedBy: requester,
        requestText: text,
        recap: queue.getDjRecap(),
        recentTracks: queue.getRecentTracks(),
        recentOpeners: queue.getRecentOpeners(),
      })
      : null;
    // Echo guard: a script that reads the request back is regenerated with the
    // request text withheld.
    const guardedMlt = await guardIntro(introScript, text, () => dj.generateIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    }));
    if (guardedMlt.guard) {
      flagGuard(entry, guardedMlt.guard);
      queue.log('request-guard', `more-like-this intro echoed request text — ${guardedMlt.guard}`);
    }
    introScript = guardedMlt.script;
    const pos = await queue.push({
      track: pick, requestedBy: requester, intent: 'more_like_this', introScript,
      introKind: 'dj-speak',
      // Voice it as whoever wrote it: render and air happen later and would
      // otherwise re-resolve the speaker off the wall clock.
      introPersona: session.onAirPersona(),
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

  // 1. A single no-tool LLM call normalises intent; the controller executes the
  // entire discovery cascade below. This is intentionally not conditional on
  // the Agentic Picker setting: listener requests remain available to models
  // without a tool interface.
  const currentTrack = queue.current?.track || null;
  let matched;
  try {
    matched = await dj.matchRequest(text, {
      listenerName: requester,
      nowPlaying: currentTrack,
    });
  } catch (err) {
    // A matcher outage or malformed plain-JSON reply must not fail a genuine
    // listener request. Search the original request locally; this keeps the
    // public receipt/poll lifecycle intact without reintroducing an agent or
    // any tool-capable fallback.
    matched = dj.fallbackRequestMatch(text);
    entry.matcherFallback = true;
    queue.log('error', `Request matcher failed; using direct library search: ${err.message}`);
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
  entry.path = entry.matcherFallback ? 'cascade-direct-search' : 'cascade';
  entry.intent = matched.intent || null;
  entry.mood = matched.mood || null;
  entry.scope = matched.scope || null;
  entry.sort = matched.sort || null;
  entry.artist = matched.artist || null;
  entry.genre = matched.genre || null;
  entry.language = matched.language || null;
  entry.searchTerms = matched.search_terms || null;

  // Requests stay near-unfiltered; see the more-like-this path above.
  const recentIds = queue.recentlyPlayedIds(2);
  for (const id of queue.queuedIds()) recentIds.add(id);
  await library.load();

  const randomFresh = (pool: any[]) => {
    if (!pool || pool.length === 0) return null;
    const fresh = pool.filter((s: any) => s?.id && !recentIds.has(s.id));
    const choose = fresh.length > 0 ? fresh : pool;
    return choose[Math.floor(Math.random() * choose.length)] || null;
  };

  let pick: any = null;
  let pickSource: string | null = null;

  // A search term differing from the artist name means a song title was named.
  const artistLc = (matched.artist || '').toLowerCase().trim();
  const namedSongTitle = (matched.search_terms || []).some((t: string) =>
    t && typeof t === 'string' && t.toLowerCase().trim() && t.toLowerCase().trim() !== artistLc
  );

  // 2a. Artist path. Also takes bare "play <artist>": walking artist → albums →
  // songs reaches the whole catalogue, where flat search3 sees only ~25 hits.
  if (!pick && matched.artist && (matched.sort || matched.scope === 'album' || !namedSongTitle)) {
    pick = await pickByArtistAndSort({
      artistName: matched.artist,
      sort: matched.sort,
      scope: matched.scope,
      recentIds,
    });
    if (pick) pickSource = 'artist-sort';
  }

  // 2b. Genre path via getSongsByGenre (search3 can't query genre).
  if (!pick && matched.genre) {
    const genre = await resolveGenre(matched.genre);
    if (genre) {
      try {
        const songs = await subsonic.getSongsByGenreSampled(genre, { count: 100 });
        pick = randomFresh(songs);
        if (pick) pickSource = `genre:${genre}`;
      } catch (err) {
        queue.log('error', `genre pick failed: ${err.message}`);
      }
    }
  }

  // 2b-bis. Language path (#349). Not a Subsonic field, so try it as a genre tag
  // first, then as a plain search term; misses fall through like every step.
  if (!pick && matched.language) {
    const genre = await resolveGenre(matched.language);
    if (genre) {
      try {
        const songs = await subsonic.getSongsByGenreSampled(genre, { count: 100 });
        pick = randomFresh(songs);
        if (pick) pickSource = `language-genre:${genre}`;
      } catch (err) {
        queue.log('error', `language genre pick failed: ${err.message}`);
      }
    }
    if (!pick) {
      try {
        const r = await subsonic.search(matched.language, { songCount: 25 });
        // Strict-fresh: with a tiny text-match pool, falling back to recently
        // played candidates just dedup-dies downstream, so treat it as a miss.
        const fresh = (r || []).filter((s: any) => s?.id && !recentIds.has(s.id));
        pick = fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : null;
        if (pick) pickSource = `language-search:${matched.language}`;
      } catch (err) {
        queue.log('error', `language search pick failed: ${err.message}`);
      }
    }
  }

  // 2c. Search by terms: artist names / song titles only. A random page offset
  // keeps repeat requests off the same top-25 search3 hits.
  if (!pick) {
    const terms = (matched.search_terms || []).filter((t: string) => {
      if (!t || typeof t !== 'string') return false;
      if (matched.mood && t.toLowerCase() === matched.mood.toLowerCase()) return false;
      if (matched.genre && t.toLowerCase() === matched.genre.toLowerCase()) return false;
      if (matched.language && t.toLowerCase() === matched.language.toLowerCase()) return false;
      return true;
    });
    if (terms.length > 0) {
      // An explicit "title by artist" request must not be reduced to the
      // ordinary broad search pool. That pool intentionally includes both the
      // title and artist result sets and is randomly spread for open-ended
      // requests — which let another song by the named artist beat an exact
      // title already in the library. Query title terms' first page once,
      // then accept only an exact normalised title + artist pair. All misses
      // continue through the unchanged forgiving cascade below.
      const titleTerms = terms.filter((term: string) => term.toLowerCase().trim() !== artistLc);
      if (matched.artist && titleTerms.length > 0) {
        const exactCandidates: any[] = [];
        for (const title of titleTerms) {
          try {
            exactCandidates.push(...await subsonic.search(title, { songCount: 25 }));
          } catch (err) {
            queue.log('error', `exact request search failed: ${err.message}`);
          }
        }
        pick = exactTitleByArtist(exactCandidates, { titles: titleTerms, artist: matched.artist });
        if (pick) pickSource = 'search:exact-title-artist';
      }

      if (pick) {
        // The exact result above is intentionally deterministic. Do not feed
        // it into the randomized broad pool below.
      } else {
      let candidates: any[] = [];
      for (const term of terms) {
        const songOffset = Math.floor(Math.random() * 3) * 25;
        let r = await subsonic.search(term, { songCount: 25, songOffset });
        // A deep offset can land past the end; fall back to the first page.
        if (r.length === 0 && songOffset > 0) {
          r = await subsonic.search(term, { songCount: 25 });
        }
        candidates = [...candidates, ...r];
      }
      const seen = new Set();
      const unique = candidates.filter((s: any) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
      pick = randomFresh(unique);
      if (pick) pickSource = 'search';
      }
    }
  }

  // 2d. Mood-tagged library; matchRequest's "mood" shares the tagger vocabulary.
  if (!pick && matched.mood) {
    const moodPool = library.songsByMood(matched.mood);
    pick = randomFresh(moodPool);
    if (pick) pickSource = `library-mood:${matched.mood}`;
  }

  // 2e. Similar songs to the current track: Subsonic can surface adjacency the
  // local mood tags missed.
  if (!pick && currentTrack?.id && (matched.mood || /similar|like|match/i.test(text))) {
    try {
      const similar = await subsonic.getSimilarSongs(currentTrack.id, { count: 20 });
      pick = randomFresh(similar);
      if (pick) pickSource = 'similar-to-current';
    } catch {}
  }

  // 2f. Dominant-mood fallback: fit the room rather than refuse.
  if (!pick && ctx.dominantMood) {
    const moodPool = library.songsByMood(ctx.dominantMood);
    pick = randomFresh(moodPool);
    if (pick) pickSource = `library-mood:${ctx.dominantMood}(context)`;
  }

  // 2g. Starred: the operator's favourites are always a safe pick.
  if (!pick) {
    try {
      const starred = await subsonic.getStarred();
      pick = randomFresh(starred);
      if (pick) pickSource = 'starred';
    } catch {}
  }

  if (!pick) {
    queue.log('miss', `Nothing matched "${text}"`);
    return failed(sorryNoMatch(requester));
  }

  // Near-miss flag: artist named but the airing track isn't by them. The filler
  // is still queued; recording it keeps the degrade visible in the request log.
  if (matched.artist) {
    const want = matched.artist.toLowerCase().trim();
    const got = String(pick.artist || '').toLowerCase();
    const hit = got.includes(want) || want.includes(got)
      || want.split(/\s+/).some(t => t.length >= 3 && got.includes(t));
    if (!hit) {
      entry.artistMiss = matched.artist;
      queue.log('miss', `Requested artist "${matched.artist}" not in library — airing ${pick.artist} instead`);
    }
  }

  // Repeat cooldown. Checked before intro generation so a hit spends no model
  // call; the listener gets an honest ack (`resolved`, not `failed`).
  const cdMin = Number((settings.get() as any)?.requests?.repeatCooldownMin ?? 120);
  if (cdMin > 0 && queue.recentlyPlayedIds(cdMin / 60).has(pick.id)) {
    entry.pick = pick;
    entry.pickSource = `${pickSource}:cooldown`;
    // Refused, not queued; see the more-like-this dedup branch above.
    entry.refused = true;
    const cdAck = queue.cooldownAck(pick.id, pick.title);
    session.appendTurn({ role: 'dj', kind: 'request', text: cdAck, meta: { trackId: pick.id, requester } });
    return resolved({ ack: cdAck, track: { title: pick.title, artist: pick.artist }, queuePosition: null });
  }

  queue.log('request', `resolved via ${pickSource}: ${pick.title} — ${pick.artist}`);

  // On an artist miss the up-front ack (written before the cascade knew it would
  // miss) is a lie; replace it with an honest stand-in line.
  let ack: string;
  if (entry.artistMiss) {
    ack = `No ${entry.artistMiss} in the crates — here's something that fits the moment instead.`;
  } else {
    const screened = screenAck(matched.ack, text, 'Coming right up.');
    if (screened.guard) {
      flagGuard(entry, screened.guard);
      queue.log('request-guard', `cascade ack echoed request text — replaced`);
    }
    ack = screened.ack;
  }

  // 3. DJ intro. On a miss, pass the absent artist so the intro owns the
  // substitution. Station voice off means no intro and no model call; the ack
  // still reaches the listener.
  let introScript = autoVoiceAllowed()
    ? await dj.generateIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
      requestText: text,
      artistMiss: entry.artistMiss || null,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    })
    : null;
  // Echo guard, as in the more-like-this path.
  const guarded = await guardIntro(introScript, text, () => dj.generateIntro({
    track: pick,
    context: ctx,
    requestedBy: requester,
    artistMiss: entry.artistMiss || null,
    recap: queue.getDjRecap(),
    recentTracks: queue.getRecentTracks(),
    recentOpeners: queue.getRecentOpeners(),
  }));
  if (guarded.guard) {
    flagGuard(entry, guarded.guard);
    queue.log('request-guard', `intro echoed request text — ${guarded.guard}`);
  }
  introScript = guarded.script;

  // 4. Enqueue. push() dedups a track a concurrent request already queued (#619).
  const pos = await queue.push({
    track: pick,
    requestedBy: requester,
    intent: matched.intent,
    introScript,
    introKind: 'dj-speak',
    introPersona: session.onAirPersona(),
  });
  entry.pick = pick;
  if (pos === -2) {
    // Blocklist refused the pick; standard not-found copy so it doesn't leak.
    entry.pickSource = `${pickSource}:blocked`;
    return failed(sorryNoMatch(requester));
  }
  if (pos === -1) {
    const dupAck = queue.dedupAck(pick.id);
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
  // Sanitize never grows its input, so no re-slice is needed.
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
  // slot in the listener queue. See queue.pendingListenerRequests().
  const pendingCount = queue.pendingListenerRequests();
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
    message: entry.message,
  });
});
