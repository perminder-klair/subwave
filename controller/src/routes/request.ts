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
import * as listeners from '../broadcast/listeners.js';
import * as webhooks from '../broadcast/webhooks.js';
import {
  checkRateLimit, clientIp,
  REQUESTS_DISABLED, REQUEST_TEXT_MAX, REQUEST_NAME_MAX,
} from '../middleware/ratelimit.js';

export const router = express.Router();

const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

// ---------------------------------------------------------------------------
// In-memory request ledger. Each POST /request mints an entry; the background
// resolver mutates it; GET /request/:id reads it. Ephemeral by design — a
// controller restart drops in-flight requests, which is fine: the track is
// already queued or it isn't, and the listener can just ask again.
// ---------------------------------------------------------------------------
const requests = new Map();
const REQUEST_TTL_MS = 10 * 60 * 1000;

function pruneRequests() {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  for (const [id, entry] of requests) {
    if (entry.createdAt < cutoff) requests.delete(id);
  }
}

// Resolve "latest album by Diljit" style requests: find the artist, sort their
// albums by year, pick a song from the right album. Returns a Subsonic song or null.
async function pickByArtistAndSort({ artistName, sort, scope: _scope, recentIds }: { artistName: string; sort: string | null; scope: string; recentIds: Set<string> }) {
  try {
    const artists = await subsonic.searchArtists(artistName, { artistCount: 5 });
    if (artists.length === 0) return null;
    const artist = await subsonic.getArtist(artists[0].id);
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

// Resolve a listener's free-text genre ("hip hop", "punjabi") to a genre value
// that actually exists in the library. search3 is a title/artist/album text
// match and can't query the genre tag, so genre requests must go through
// getSongsByGenre with an exact genre name. Returns the matched name or null.
async function resolveGenre(name) {
  if (!name) return null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  if (!target) return null;
  try {
    const genres = await subsonic.getGenres();
    let hit = genres.find(g => norm(g.value) === target);
    if (!hit) {
      hit = genres.find(g => {
        const gv = norm(g.value);
        return gv && (gv.includes(target) || target.includes(gv));
      });
    }
    return hit?.value || null;
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
async function resolveRequest(entry) {
  const { requester, text } = entry;
  const resolved = ({ ack, track, queuePosition }) => {
    entry.status = 'resolved';
    entry.ack = ack || null;
    entry.track = track || null;
    entry.queuePosition = typeof queuePosition === 'number' ? queuePosition : null;
  };
  const failed = (message) => {
    entry.status = 'failed';
    entry.message = message;
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
      text: `Listener "${requester}" requests: "${text}"`
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
    const reference = queue.current || queue.history[0];
    const refArtist = reference?.track?.artist;
    if (!refArtist) {
      return failed(`Nothing's playing yet — tell me what you're after instead.`);
    }
    // Requests stay near-unfiltered — 2h is enough to skip the song still
    // ringing in their ears without blocking a re-request from earlier today.
    const recentIds = queue.recentlyPlayedIds(2);
    const pick = await pickByArtistAndSort({
      artistName: refArtist, sort: null, scope: 'song', recentIds,
    });
    if (!pick) {
      return failed(`Couldn't find more from ${refArtist} in the crates.`);
    }
    const introScript = await dj.generateIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
      requestText: text,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    });
    await queue.push({
      track: pick, requestedBy: requester, intent: 'more_like_this', introScript,
      introKind: 'dj-speak',
    });
    session.appendTurn({
      role: 'dj', kind: 'request',
      text: introScript || `More from ${refArtist}, coming up.`,
      meta: { trackId: pick.id, requester },
    });
    return resolved({
      ack: `More from ${refArtist}, coming up.`,
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
      queue.log('request', `agent resolved: ${agentRes.track.title} — ${agentRes.track.artist}`);
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
    searchTerms: matched.search_terms,
  });

  // Requests stay near-unfiltered — see /more-like-this comment above.
  const recentIds = queue.recentlyPlayedIds(2);
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
        const songs = await subsonic.getSongsByGenre(genre, { count: 100 });
        pick = randomFresh(songs);
        if (pick) pickSource = `genre:${genre}`;
      } catch (err) {
        queue.log('error', `genre pick failed: ${err.message}`);
      }
    }
  }

  // 2c. Search by terms — artist names / song titles only (the system prompt
  // routes genres and vibes elsewhere; defensively drop a term that equals
  // the mood or genre string). A random page offset means repeated requests
  // for the same artist don't always cycle the same top-25 search3 hits.
  if (!pick) {
    const terms = (matched.search_terms || []).filter((t: string) => {
      if (!t || typeof t !== 'string') return false;
      if (matched.mood && t.toLowerCase() === matched.mood.toLowerCase()) return false;
      if (matched.genre && t.toLowerCase() === matched.genre.toLowerCase()) return false;
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
    return failed(`Sorry ${requester}, nothing in the crates matched that.`);
  }
  queue.log('request', `resolved via ${pickSource}: ${pick.title} — ${pick.artist}`);

  // 3. Generate DJ intro that mentions the request
  const introScript = await dj.generateIntro({
    track: pick,
    context: ctx,
    requestedBy: requester,
    requestText: text,
    recap: queue.getDjRecap(),
    recentTracks: queue.getRecentTracks(),
    recentOpeners: queue.getRecentOpeners(),
  });

  // 4. Add to queue (will trigger Liquidsoap via the queue manager)
  await queue.push({
    track: pick,
    requestedBy: requester,
    intent: matched.intent,
    introScript,
    introKind: 'dj-speak',
  });
  session.appendTurn({
    role: 'dj', kind: 'request',
    text: introScript || matched.ack || `Queued "${pick.title}".`,
    meta: { trackId: pick.id, requester },
  });

  return resolved({
    ack: matched.ack,
    track: { title: pick.title, artist: pick.artist },
    queuePosition: queue.upcoming.length,
  });
}

// ---------------------------------------------------------------------------
// POST /request — listener submits a request. Validates + rate-limits
// synchronously, then returns a request id immediately and resolves in the
// background. The listener never waits on the LLM.
// ---------------------------------------------------------------------------
router.post('/request', async (req, res) => {
  if (REQUESTS_DISABLED) {
    return res.status(503).json({ success: false, message: 'Requests are temporarily closed.' });
  }

  // Zero-listener pause: a request would mean LLM work, so it's gated too.
  // Force a fresh Icecast read so a listener who just connected isn't turned
  // away on a stale cached count.
  await listeners.refresh();
  if (!listeners.djCallsAllowed()) {
    return res.status(503).json({
      success: false,
      message: "The DJ's on autopilot — requests reopen when someone's tuned in.",
    });
  }

  const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
  const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
  const text = rawText.trim().slice(0, REQUEST_TEXT_MAX);
  if (!text) {
    return res.status(400).json({ error: 'Empty request' });
  }
  const requester = (rawName.trim().slice(0, REQUEST_NAME_MAX)) || 'anon';

  const gate = checkRateLimit(clientIp(req));
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({
      success: false,
      message: `Easy there — try again in ${gate.retryAfter}s.`,
      retryAfter: gate.retryAfter,
    });
  }

  pruneRequests();
  const id = randomUUID();
  const entry: any = {
    id,
    status: 'pending',
    requester,
    text,
    ack: null,
    track: null,
    queuePosition: null,
    message: null,
    createdAt: Date.now(),
  };
  requests.set(id, entry);
  queue.log('request', `${requester}: "${text}" (id ${id.slice(0, 8)})`);
  webhooks.notify('request.received', { requestedBy: requester, text });

  // Hand the listener a receipt and let go of the connection. The booth does
  // the rest; GET /request/:id reports the outcome.
  res.status(202).json({ success: true, requestId: id, status: 'pending' });

  resolveRequest(entry).catch(err => {
    queue.log('error', `Request resolution crashed: ${err.message}`);
    entry.status = 'failed';
    entry.message = 'Something went wrong in the booth — try again.';
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
