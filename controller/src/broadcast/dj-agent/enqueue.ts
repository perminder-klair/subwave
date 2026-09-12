// Turning an agent's chosen song into a queued track: the field projection the
// model sees, trimming a link back to an intro, and the enqueue itself.

import * as settings from '../../settings.js';
import * as session from '../session.js';
import * as subsonic from '../../music/source.js';
import * as dj from '../../llm/dj.js';
import { stripThinking } from '../../llm/sdk.js';
import { recordPick } from '../../llm/log.js';
import * as requestLog from '../request-log.js';
import { echoesRecentRequest } from '../../util/request-guard.js';
import { speechPaceScale } from '../../audio/tts.js';
import { normalizeForDisplay, normalizeForSpeech, spokenWordScale } from '../../audio/speech-text.js';
import { introMsOf } from './runs.js';

export function trackFields(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    year: song.year,
    // All genre tags, comma-joined.
    genre: subsonic.songGenres(song).join(', ') || null,
    // Seconds; the queue needs it to spot picks that will hit the max-track
    // cap. Field name varies by source: Subsonic `duration`, the picker tools'
    // slim projection `duration_sec`, library rows `durationSec`.
    duration: song.duration ?? song.duration_sec ?? song.durationSec ?? null,
    // Rides raw Subsonic songs (pool picks) but not the slim projection agent
    // picks resolve from — undefined there tells queue.applyLoudnessGain to
    // recover it with a getSong lookup.
    replayGain: song.replayGain,
  };
}

// Echo guard on the PICK path: the session window quotes listener request text
// verbatim for ~40 turns, so an injected phrasing can resurface in a later
// pick's link. Policy lives in util/request-guard.ts; this applies it and logs.
// Exported because callers also apply it BEFORE enqueuePick, so the session
// turn records the line as it will air. Re-running it is safe: a pre-applied
// drop short-circuits, and a trim only ever shortens to a prefix, which cannot
// turn a no-hit into a hit.
export function dropEchoedLink(link: string | null, queue: any): string | null {
  if (!link || !echoesRecentRequest(link, requestLog.recentRequests)) return link;
  queue.log('request-guard', `pick link echoed recent listener request text — link dropped`);
  return null;
}

// Talk-within-the-intro budget (#962), applied to a between-track link in DJ
// mode: trim to the pick's measured intro runway — sentence/clause-complete or
// dropped (null), never a fragment. Outside DJ mode there is no budget, only
// the reader's cleanup.
//
// Returns the DISPLAY form (#1186): it becomes introScript, which is
// booth-logged, remembered in the session and shown in the player's feed. The
// pronunciation layer is applied separately by speak() at render time.
export function trimLinkToIntro(text: string | null | undefined, song: any): string | null {
  const raw = (text || '').trim();
  if (!raw) return null;
  const clean = stripThinking(raw);
  const display = normalizeForDisplay(clean);
  // Non-DJ personas skip the budget but not the cleanup.
  if (!settings.getEffectivePersona()?.djMode) return display || null;
  // A DURATION budget, so it is counted on the words the engine will read.
  // spokenWordScale folds the display/spoken difference into the pace scale, so
  // the ceiling stays a spoken-word ceiling while the trim lands on the display
  // text's sentence boundaries. firstVocalMsFor arms the drop when a measured
  // vocal entry leaves no runway.
  const spoken = normalizeForSpeech(clean, settings.get().tts?.corrections);
  const pace = speechPaceScale('link') * spokenWordScale(display, spoken);
  return dj.enforceIntroBudget(display, introMsOf(song), pace, dj.firstVocalMsFor(song)) || null;
}

// `link` is attached to the queued item so the queue airs it at the transition
// INTO this track, not over whatever is on air when the pick is made (#189).
// `linkPrev` is the track the link back-announces, so the queue can drop a
// stale link if a request jumps ahead. `linkClockAt` is the air moment the line
// was written to speak, present only when a clock was offered; the queue drops
// the line if the real seam drifts too far from it (#1314).
//
// Returns the queue position, or -1 when push() dropped the pick (dedup or
// blocklist). On -1 neither the ai-pick log nor the durable picks-log record is
// written, and callers fall through (agent → pool → auto.m3u).
export async function enqueuePick(
  queue, song, reason, source,
  link: string | null = null,
  linkPrev: any = null,
  { sweep = false, washout = false, blend = false, dissolve = false, chop = false, loop = false }: { sweep?: boolean; washout?: boolean; blend?: boolean; dissolve?: boolean; chop?: boolean; loop?: boolean } = {},
  { linkClockAt = null }: { linkClockAt?: Date | null } = {},
): Promise<number> {
  // Single chokepoint for the intro budget: every pick path funnels its link
  // through here, so a new caller can't skip it. Near-idempotent for callers
  // that already trimmed — this pass recomputes spokenWordScale on the kept
  // text and can trim slightly further, so air always honours the budget while
  // the session turn may carry the marginally longer reading.
  const introLink = dropEchoedLink(trimLinkToIntro(link, song), queue);
  const track: any = trackFields(song);
  // Transition effects (DJ mode only); getAnnotatedUri stamps the liq_* flags
  // and radio.liq ramps them. sweep muffles the crossfade INTO this pick;
  // dissolve/chop act on the PREVIOUS track under this pick; washout rings this
  // track out as it ENDS.
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
    // Pin the voice to whoever wrote the line: render and air both happen later.
    introPersona: session.onAirPersona(),
    aiPicked: true,
    linkPrev,
    linkClockAt,
  });
  if (pos === -2) {
    // Never-play blocklist refused the pick (library-db candidates can slip
    // past the subsonic filter). Same "didn't queue" signal as dedup.
    queue.log('ai-pick', `${song.title} — ${song.artist} refused (never-play blocklist)`, { reason, source });
    return -1;
  }
  if (pos === -1) return -1;
  queue.log('ai-pick', `${song.title} — ${song.artist}`, { reason, source });
  recordPick({ song, reason, source });
  return pos;
}


