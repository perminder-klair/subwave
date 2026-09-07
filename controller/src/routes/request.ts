// POST /request — listener track requests. The HTTP call returns immediately
// with a request id; the slow work (LLM matching, the pick cascade, intro
// generation, enqueue) runs in the background. GET /request/:id reports the
// outcome so the UI can poll for it.
import express from 'express';
import { randomUUID } from 'node:crypto';
import * as subsonic from '../music/subsonic.js';
import * as dj from '../llm/dj.js';
import * as library from '../music/library.js';
import { getFullContext } from '../context.js';
import { queue } from '../broadcast/queue.js';
import * as djAgent from '../broadcast/dj-agent.js';
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

export const router = express.Router();

// Neutralize prompt-injection markup in listener-supplied request text before
// it's stored, logged, displayed, or fed to the LLM. A song request is short
// natural language ("play Diljit latest", "rainy day vibes") — it never legibly
// contains instruction-shaped markup, so stripping it can't hurt a real request
// but defangs attempts to smuggle directives to the DJ agent (the raw text is
// posted verbatim as a session turn and aired as free-text patter). This is a
// belt — the prompt framing still treats the text as data — not the only layer.
function sanitizeRequestText(raw: string): string {
  return String(raw ?? '')
    // chat/template role + instruction tokens (Llama/Mistral/ChatML style)
    .replace(/\[\/?INST\]|<<\/?SYS>>|<\|[^|>]*\|>/gi, ' ')
    // any HTML/XML-ish tag, e.g. <project_instructions> … </project_instructions>
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    // leading role markers that fake a new turn ("system:", "assistant:")
    .replace(/^[ \t]*(system|assistant|developer)\s*:/gim, ' ')
    // the unambiguous "ignore/disregard the previous instructions" family
    .replace(/\b(ignore|disregard|forget|override)\b[^.!?\n]*\b(previous|prior|above|earlier|all)\b[^.!?\n]*\binstructions?\b/gi, ' ')
    // double quotes would let the text break out of the "${text}" framing
    .replace(/"/g, "'")
    // collapse the multi-line "instruction block" shape into one line
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// In-memory request ledger. Each POST /request mints an entry; the background
// resolver mutates it; GET /request/:id reads it. Ephemeral by design — a
// controller restart drops in-flight requests, which is fine: the track is
// already queued or it isn't, and the listener can just ask again.
// ---------------------------------------------------------------------------
const requests = new Map();
const REQUEST_TTL_MS = 10 * 60 * 1000;

// One request in flight per IP (settings.requests.onePendingPerIp): an IP's
// previous request must resolve AND leave the upcoming queue (i.e. air) before
// the next one is accepted. Entries are ledger entries; pruneRequests() below
// is the shared janitor.
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

// Resolve "latest album by Diljit" style requests: find the artist, sort their
// albums by year, pick a song from the right album. Returns a Subsonic song or null.
async function pickByArtistAndSort({ artistName, sort, scope: _scope, recentIds }: { artistName: string; sort: string | null; scope: string; recentIds: Set<string> }) {
  try {
    // Fuzzy-resolve so a transliteration variance or typo ("Sikandar" vs the
    // library's "Sikander") still lands on the right artist instead of failing.
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
      // No explicit sort (a bare "play <artist>") → shuffle so the pick
      // spreads across the whole catalogue instead of always hitting the
      // first album Subsonic returns.
      albums = shuffle(albums);
    }
    // sort=popular → leave order as Subsonic returned

    // Try the top-ranked album first; if its tracks are all recently played,
    // walk down the list before giving up.
    for (const album of albums.slice(0, 5)) {
      const songs = await subsonic.getAlbum(album.id);
      if (songs.length === 0) continue;
      const fresh = songs.filter(s => !recentIds.has(s.id));
      const pool = fresh.length > 0 ? fresh : songs;
      // scope=album → random track from the album; scope=song → same thing here
      return pool[Math.floor(Math.random() * pool.length)];
    }
  } catch (err) {
    queue.log('error', `pickByArtistAndSort failed: ${err.message}`);
  }
  return null;
}

// Fallback for "more like this" when the currently-playing artist has nothing
// else in the library (e.g. a one-off collab credit) — find a track that
// actually RESEMBLES the current one. "more like this" means more like the
// TRACK, not strictly more by the artist, so this honours the request instead
// of dead-ending. Prefers the audio-similarity extension ("sounds like this"),
// then the Last.fm similarity graph. Returns a fresh Subsonic song (same shape
// as pickByArtistAndSort) or null. Excludes the seed track and recent plays.
async function pickSimilarToTrack(reference, recentIds: Set<string>) {
  const id = reference?.track?.id;
  if (!id) return null;
  const exclude = new Set(recentIds);
  exclude.add(id); // never return the song that's playing right now
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

// Resolve a listener's free-text genre ("hip hop", "punjabi") to a genre value
// that actually exists in the library. search3 is a title/artist/album text
// match and can't query the genre tag, so genre requests must go through
// getSongsByGenre with an exact genre name. Returns the matched name or null.
async function resolveGenre(name) {
  try {
    return await subsonic.resolveGenreName(name);
  } catch (err) {
    queue.log('error', `resolveGenre failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Background resolver — everything the listener used to wait on. Mutates the
// ledger entry to `resolved` (track queued) or `failed` (no match / error).
// `ctx` from getFullContext() is fetched once here and threaded through every
// path, instead of the four separate fetches the inline handler used to do.
// ---------------------------------------------------------------------------
// Append the durable debug record once, at a request's terminal state, from the
// trace fields the resolution paths stash on `entry` as they go. Best-effort —
// a logging hiccup must never affect the listener's outcome. Called from both
// resolveRequest's terminal closures and the crash catch below, so a request
// that throws mid-resolution still lands in the log.
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

// Record a guard verdict on the entry without clobbering an earlier one — a
// single request can trip the ack guard and then the intro guard, and the
// durable log should show both rather than whichever ran last.
function flagGuard(entry, verdict: string | null | undefined) {
  if (!verdict) return;
  entry.guard = entry.guard ? `${entry.guard}+${verdict}` : verdict;
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

  // Roll the session if a show/mood boundary has passed since the last track
  // change, then post the request as a single `event` turn. Doing it here —
  // before any resolution path — means the agent, the "more like this"
  // shortcut and the stateless cascade all share one event turn, so the
  // session never carries an orphan event with no DJ reply.
  try {
    await session.maybeRoll(ctx);
    const cur = queue.current?.track || null;
    session.appendTurn({
      role: 'event', kind: 'request',
      // The pick agent reads this window for hours, so an unsigned request must
      // not leave the string 'anon' sitting in it as if it were a name (#1347).
      text: `${isNamedRequester(requester) ? `Listener "${requester}" requests` : 'An unnamed listener requests'}: "${text}"`
        + (cur ? ` (currently playing "${cur.title}" by ${cur.artist}${cur.id ? ` [id: ${cur.id}]` : ''})` : ''),
    });
  } catch (err) {
    queue.log('error', `Session update for request failed: ${err.message}`);
  }

  // 0. "more like this" — never let it through the generic search path, it's a
  // meta-instruction about the current track, not a query. Pick another song
  // by the current/last artist and skip the LLM match.
  const isMoreLikeThis = /^more\s+like\s+this[.!?]?$/i.test(text);
  if (isMoreLikeThis) {
    entry.path = 'more-like-this';
    entry.pickSource = 'more-like-this';
    const reference = queue.current || queue.history[0];
    const refArtist = reference?.track?.artist;
    if (!refArtist) {
      return failed(`Nothing's playing yet — tell me what you're after instead.`);
    }
    // Requests stay near-unfiltered — 2h is enough to skip the song still
    // ringing in their ears without blocking a re-request from earlier today.
    const recentIds = queue.recentlyPlayedIds(2);
    for (const id of queue.queuedIds()) recentIds.add(id);
    // Try another track by the same artist first (the cheap, on-the-nose read),
    // then fall back to real track similarity so a one-off collab credit playing
    // now doesn't dead-end the request ("Couldn't find more from X in the crates").
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
    // The fallback can land on a different artist, so phrase the ack from the
    // actual pick, not the seed.
    const sameArtist = !!pick.artist && pick.artist === refArtist;
    const ackLine = sameArtist ? `More from ${refArtist}, coming up.` : `More like that, coming up.`;
    // Station voice off (settings.tts.enabled) → the request is still honoured
    // and the listener still gets their text ack; there's just no spoken intro,
    // and no model call to write one.
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
    // Echo guard (A2): a script that reads the request back is regenerated with
    // the request text withheld — it can't echo what it never saw.
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
      // Voice it as whoever wrote it — render and air both happen later and
      // would otherwise re-resolve the speaker off the wall clock.
      introPersona: session.onAirPersona(),
    });
    entry.pick = pick;
    if (pos === -2) {
      // Never-play blocklist refused the pick (library-db-sourced candidates
      // can slip past the subsonic filter). Decline with the standard
      // not-found copy — no leak that the track exists but is blocked.
      entry.pickSource = `${entry.pickSource}:blocked`;
      return failed(`Couldn't find anything close to "${reference?.track?.title || refArtist}" in the crates.`);
    }
    if (pos === -1) {
      // A concurrent request already queued this exact track — acknowledge
      // honestly instead of airing a second intro over a phantom replay (#619).
      const dupAck = queue.dedupAck(pick.id);
      entry.pickSource = `${entry.pickSource}:already-queued`;
      // Nothing was queued for THIS listener — don't let the one-pending hold
      // key on a track they didn't get (stillInFlight).
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
      ack: ackLine,
      track: { title: pick.title, artist: pick.artist },
      queuePosition: queue.upcoming.length,
    });
  }

  // Conversational DJ agent — when enabled it searches the library itself with
  // the discovery tools and writes the intro, posting the request into the
  // live session. On any failure, fall through to the stateless matcher
  // cascade below so a request is never dropped.
  try {
    const agentRes = await djAgent.runRequest(queue, ctx, { requester, text });
    if (agentRes) {
      // Agent path's echo guard (dj-agent.ts) already logged the ephemeral
      // djLog entry when it fired; thread the same verdict into the durable
      // request log so `guard` isn't silently unset for every agent-path
      // request (the cascade/more-like-this paths set it inline above).
      if (agentRes.guard) flagGuard(entry, agentRes.guard);
      if (!agentRes.track) {
        // Chat escape (C1): the agent answered in persona — nothing to queue.
        // Only reachable on an EXPLICIT kind:"chat" now (dj-agent.ts); an
        // omitted id no longer lands here, it falls through to the cascade.
        queue.log('request', `agent chat-answered (no track)`);
        entry.path = 'chat';
        entry.pickSource = 'agent-chat';
        return resolved({ ack: agentRes.ack, track: null, queuePosition: null });
      }
      if (agentRes.refused) {
        // The agent declined to queue (repeat cooldown, or push() deduped it)
        // and returned the track only so the ack and the log can name it.
        // Reporting `queue.upcoming.length` here put "Queued · Position #N" on
        // the listener's screen over an ack saying the opposite, and recorded a
        // clean `agent` resolution in the operator log for a play that never
        // happened. Keep the marker, no position, no one-pending hold.
        queue.log('request', `agent refused (${agentRes.refused}): ${agentRes.track.title} — ${agentRes.track.artist}`);
        entry.path = 'agent';
        entry.pickSource = `agent:${agentRes.refused}`;
        entry.pick = agentRes.track;
        entry.refused = true;
        return resolved({ ack: agentRes.ack, track: agentRes.track, queuePosition: null });
      }
      queue.log('request', `agent resolved: ${agentRes.track.title} — ${agentRes.track.artist}`);
      entry.path = 'agent';
      entry.pickSource = 'agent';
      entry.pick = agentRes.track;
      entry.introScript = agentRes.introScript || null;
      return resolved({
        ack: agentRes.ack,
        track: agentRes.track,
        queuePosition: queue.upcoming.length,
      });
    }
  } catch (err) {
    queue.log('error', `DJ agent request failed: ${err.message} — falling back`);
  }

  // 1. LLM matches intent — pass current track so vibe queries can be
  // interpreted against what's actually on-air ("match this energy",
  // "something slower than this", etc.).
  const currentTrack = queue.current?.track || null;
  const matched = await dj.matchRequest(text, {
    listenerName: requester,
    nowPlaying: currentTrack,
  });
  queue.log('intent', `"${text}" → ${matched.intent || '(no intent)'}`, {
    mood: matched.mood,
    scope: matched.scope,
    sort: matched.sort,
    artist: matched.artist,
    language: matched.language,
    searchTerms: matched.search_terms,
  });

  // Conversational message → conversational answer; nothing queued (C1).
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

  // Stash the matcher breakdown for the debug record — this path is the
  // stateless cascade (agent + more-like-this never reach here).
  entry.path = 'cascade';
  entry.intent = matched.intent || null;
  entry.mood = matched.mood || null;
  entry.scope = matched.scope || null;
  entry.sort = matched.sort || null;
  entry.artist = matched.artist || null;
  entry.genre = matched.genre || null;
  entry.language = matched.language || null;
  entry.searchTerms = matched.search_terms || null;

  // Requests stay near-unfiltered — see /more-like-this comment above.
  const recentIds = queue.recentlyPlayedIds(2);
  for (const id of queue.queuedIds()) recentIds.add(id);
  await library.load();

  // Helper: pick a fresh random item from a pool, preferring non-recents.
  const randomFresh = (pool: any[]) => {
    if (!pool || pool.length === 0) return null;
    const fresh = pool.filter((s: any) => s?.id && !recentIds.has(s.id));
    const choose = fresh.length > 0 ? fresh : pool;
    return choose[Math.floor(Math.random() * choose.length)] || null;
  };

  let pick: any = null;
  let pickSource: string | null = null;

  // A specific song title was named if any search term differs from the
  // artist name. Without one, an artist request is a bare "play <artist>".
  const artistLc = (matched.artist || '').toLowerCase().trim();
  const namedSongTitle = (matched.search_terms || []).some((t: string) =>
    t && typeof t === 'string' && t.toLowerCase().trim() && t.toLowerCase().trim() !== artistLc
  );

  // 2a. Artist path — resolve the artist's albums and pick a track. Used for
  // "latest/oldest album by X", album requests, AND bare "play <artist>"
  // requests with no song title: walking artist → albums → songs reaches the
  // whole catalogue, where a flat search3 only sees the top ~25 hits.
  if (!pick && matched.artist && (matched.sort || matched.scope === 'album' || !namedSongTitle)) {
    pick = await pickByArtistAndSort({
      artistName: matched.artist,
      sort: matched.sort,
      scope: matched.scope,
      recentIds,
    });
    if (pick) pickSource = 'artist-sort';
  }

  // 2b. Genre path — match the listener's genre against the library's real
  // genre tags. search3 can't query genre, so route through getSongsByGenre.
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

  // 2b-bis. Language path — "play something Turkish" (issue #349). Language
  // isn't a Subsonic field, so try it as a genre tag first (highest
  // precision: "turkish" → "Turkish Pop"), then as a plain search term in
  // case the word shows up in artist/album/title. Misses fall through to the
  // remaining pick sources like every other step.
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
        // Strict-fresh (C2): with a tiny text-match pool (often 1 track), falling
        // back to recently-played candidates just dedup-dies downstream — treat
        // an all-stale pool as a miss and let the cascade continue instead.
        const fresh = (r || []).filter((s: any) => s?.id && !recentIds.has(s.id));
        pick = fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : null;
        if (pick) pickSource = `language-search:${matched.language}`;
      } catch (err) {
        queue.log('error', `language search pick failed: ${err.message}`);
      }
    }
  }

  // 2c. Search by terms — artist names / song titles only (the system prompt
  // routes genres and vibes elsewhere; defensively drop a term that equals
  // the mood, genre, or language string). A random page offset means repeated
  // requests for the same artist don't always cycle the same top-25 search3 hits.
  if (!pick) {
    const terms = (matched.search_terms || []).filter((t: string) => {
      if (!t || typeof t !== 'string') return false;
      if (matched.mood && t.toLowerCase() === matched.mood.toLowerCase()) return false;
      if (matched.genre && t.toLowerCase() === matched.genre.toLowerCase()) return false;
      if (matched.language && t.toLowerCase() === matched.language.toLowerCase()) return false;
      return true;
    });
    if (terms.length > 0) {
      let candidates: any[] = [];
      for (const term of terms) {
        const songOffset = Math.floor(Math.random() * 3) * 25;
        let r = await subsonic.search(term, { songCount: 25, songOffset });
        // A deep offset can land past the end of the result set — fall back
        // to the first page so a valid query never comes back empty.
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

  // 2d. Mood-tagged library — the right vocabulary for vibe queries. The
  // tagger writes moods like "calm", "rainy", "night" to state/moods.json;
  // matchRequest's "mood" field uses the same vocabulary.
  if (!pick && matched.mood) {
    const moodPool = library.songsByMood(matched.mood);
    pick = randomFresh(moodPool);
    if (pick) pickSource = `library-mood:${matched.mood}`;
  }

  // 2e. Similar-songs from the current track — when the listener's intent is
  // vibe-adjacent and we have something playing, Subsonic can surface
  // adjacency that wasn't captured in our local mood tags.
  if (!pick && currentTrack?.id && (matched.mood || /similar|like|match/i.test(text))) {
    try {
      const similar = await subsonic.getSimilarSongs(currentTrack.id, { count: 20 });
      pick = randomFresh(similar);
      if (pick) pickSource = 'similar-to-current';
    } catch {}
  }

  // 2f. Dominant-mood fallback — if the listener gave us nothing actionable
  // but the station has a mood for the current moment (weather/time/festival),
  // play something that fits the room rather than refusing.
  if (!pick && ctx.dominantMood) {
    const moodPool = library.songsByMood(ctx.dominantMood);
    pick = randomFresh(moodPool);
    if (pick) pickSource = `library-mood:${ctx.dominantMood}(context)`;
  }

  // 2g. Starred — operator's hand-picked favourites are always a safe pick.
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

  // Near-miss flag: the listener named an artist but the track we're airing
  // isn't by them — the cascade couldn't find that artist (even fuzzily) and
  // fell through to mood/genre/starred filler. We still queue the filler (the
  // station never refuses), but recording it makes this silent degrade visible
  // in the request log instead of looking like a clean resolve.
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

  // Repeat cooldown (B6): a track that just aired can't be re-queued by
  // request. Checked before intro generation so a cooldown hit never spends a
  // model call — the listener still gets a friendly, honest ack (`resolved`,
  // not `failed`).
  const cdMin = Number((settings.get() as any)?.requests?.repeatCooldownMin ?? 120);
  if (cdMin > 0 && queue.recentlyPlayedIds(cdMin / 60).has(pick.id)) {
    entry.pick = pick;
    entry.pickSource = `${pickSource}:cooldown`;
    // Refused, not queued — see the more-like-this dedup branch above.
    entry.refused = true;
    const cdAck = queue.cooldownAck(pick.id, pick.title);
    session.appendTurn({ role: 'dj', kind: 'request', text: cdAck, meta: { trackId: pick.id, requester } });
    return resolved({ ack: cdAck, track: { title: pick.title, artist: pick.artist }, queuePosition: null });
  }

  queue.log('request', `resolved via ${pickSource}: ${pick.title} — ${pick.artist}`);

  // On an artist miss the up-front `ack` (written by matchRequest before the
  // cascade knew it would miss) is a lie — "Got some Katy Perry coming up!"
  // over a Daft Punk track. Replace it with an honest stand-in line.
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

  // 3. Generate DJ intro that mentions the request. On a miss, pass the
  // requested-but-absent artist so the spoken intro owns the substitution
  // instead of pretending the track is by them.
  // Station voice off → no spoken intro and no model call to write one (see the
  // more_like_this path above). The `ack` below still reaches the listener.
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
  // Echo guard (A2): a script that reads the request back is regenerated with
  // the request text withheld — it can't echo what it never saw.
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

  // 4. Add to queue (will trigger Liquidsoap via the queue manager). A
  // concurrent request that already queued this exact track makes push() dedup
  // it (#619) — acknowledge honestly rather than pretending it's freshly queued.
  const pos = await queue.push({
    track: pick,
    requestedBy: requester,
    intent: matched.intent,
    introScript,
    introKind: 'dj-speak',
    // Voice it as whoever wrote it (see the more_like_this push above).
    introPersona: session.onAirPersona(),
  });
  entry.pick = pick;
  if (pos === -2) {
    // Never-play blocklist refused the pick — decline with the standard
    // not-found copy so the block doesn't leak to the listener.
    entry.pickSource = `${pickSource}:blocked`;
    return failed(sorryNoMatch(requester));
  }
  if (pos === -1) {
    const dupAck = queue.dedupAck(pick.id);
    entry.pickSource = `${pickSource}:already-queued`;
    // Refused, not queued — see the more-like-this dedup branch above.
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
    ack,
    track: { title: pick.title, artist: pick.artist },
    queuePosition: queue.upcoming.length,
  });
}

// ---------------------------------------------------------------------------
// POST /request — listener submits a request. Validates + rate-limits
// synchronously, then returns a request id immediately and resolves in the
// background. The listener never waits on the LLM.
//
// The shared schema (schemas/request.ts, also run pre-flight by the player's
// request boxes) owns the SHAPE: text present and under the cap, name under its
// cap. Over-cap text REFUSES rather than being sliced — a silent slice could cut
// a request mid-thought and have the DJ answer half of it — and the box tells
// the listener before the network is touched. The guard pipeline below
// (sanitize → strip → screen) stays route-owned: it repairs rather than refuses,
// and needs server state the schema can't see.
// ---------------------------------------------------------------------------
// validatePublicBody, not validateBody: this is the one LISTENER-facing form,
// so the 400 carries an unprefixed message plus the success/message keys the
// shipped native app reads. See the middleware for why.
router.post('/request', validatePublicBody(listenerRequestSchema), async (req, res) => {
  const cfg = (settings.get() as any)?.requests || {};
  if (REQUESTS_DISABLED || cfg.enabled === false) {
    return res.status(503).json({ success: false, message: 'Requests are temporarily closed.' });
  }

  // Zero-listener pause (unchanged — see original comment).
  await listeners.refresh();
  if (!listeners.djCallsAllowed()) {
    return res.status(503).json({
      success: false,
      message: "The DJ's on autopilot — requests reopen when someone's tuned in.",
    });
  }

  // validateBody already replaced req.body with the parsed shape: text is a
  // trimmed non-empty string within the cap, name a trimmed string ('' when
  // absent). Sanitize (markup-shaped injection), then neutralize the "read
  // this on air" directive family — the cleaned text is all the
  // session/prompts/air see; the raw text is preserved on the entry for the
  // operator request log. Sanitize never grows its input, so no re-slice.
  const { text: rawText, name: rawName } = req.body as { text: string; name: string };
  const stripped = stripScriptedOpener(sanitizeRequestText(rawText));
  const text = stripped.text;
  if (!text) {
    // Distinguish "you typed nothing" from "everything you typed was staging
    // directions for the DJ, so there is no request left to resolve" — the
    // second is reachable by an ordinary listener via a false-positive match,
    // and "Empty request" over a message they can see they wrote reads as a
    // bug. Never echo the text back in the error.
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
  // Run the janitor BEFORE the gates, not after. The one-pending hold below
  // returns 429 without ever reaching the rest of the handler, so pruning
  // later meant a request whose resolution never settled held its IP well past
  // the 10-minute TTL — freed only when some OTHER IP's request got far enough
  // to prune, which on a single-listener station is "never, until restart".
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
  // Both queue-state refusals below carry the COOLDOWN as Retry-After, which is
  // a truthful floor rather than a guess: checkRateLimit above already stamped
  // this IP's cooldown, so the caller genuinely cannot succeed before it
  // expires, whatever the queue does in the meantime. A client that honours it
  // stops hammering; one that doesn't just meets the cooldown 429.
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

  // Every gate passed — the request is being accepted, so now spend the hourly
  // budgets. Deliberately AFTER the two queue-state gates above: those reject
  // without queueing anything, and charging an accept-budget for them let a
  // full queue burn the station-wide cap down to zero on rejections alone (see
  // middleware/ratelimit.ts). The per-IP cooldown was already spent by
  // checkRateLimit, which is what keeps those rejections from being free to
  // hammer.
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

  // Hand the listener a receipt and let go of the connection. The booth does
  // the rest; GET /request/:id reports the outcome.
  res.status(202).json({ success: true, requestId: id, status: 'pending' });

  resolveRequest(entry).catch(err => {
    queue.log('error', `Request resolution crashed: ${err.message}`);
    entry.status = 'failed';
    entry.message = 'Something went wrong in the booth — try again.';
    recordOutcome(entry);
  });
});

// ---------------------------------------------------------------------------
// GET /request/:id — poll for the outcome of a submitted request.
// ---------------------------------------------------------------------------
router.get('/request/:id', (req, res) => {
  const entry = requests.get(req.params.id);
  if (!entry) {
    // Unknown id: either never existed, or pruned / lost to a restart. The
    // UI treats this as "stop polling" rather than an error.
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
