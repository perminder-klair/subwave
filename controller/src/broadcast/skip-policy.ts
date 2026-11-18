import type { SkipRefusalReason } from '../schemas/dj.js';
import type { Interposed } from './queue/pure.js';
import { CROSS_MAX_SECONDS } from '../music/mix.js';

// Force-drain and await a resolved request before an operator skip. Proceed after the bounded
// wait even if unconfirmed; ending the current track takes priority. #1300.
export const SKIP_COMMIT_WAIT_MS = 20_000;

// How often the wait loop re-reads queue state + probes dj_queue_status.
export const SKIP_POLL_INTERVAL_MS = 500;

// Older radio.liq has no dj_queue_status, so the wait proceeds on a fixed grace
// after the head is sent rather than never skipping or skipping at once.
export const UNKNOWN_STATUS_GRACE_MS = 5_000;

// dj_queue_status telnet answer. 'unknown' covers error text, garbled replies
// and an older radio.liq without the command.
export type DjQueueStatus = 'ready' | 'resolving' | 'empty' | 'unknown';

export function parseDjQueueStatus(raw: string | null | undefined): DjQueueStatus {
  const word = (raw ?? '').trim();
  if (word === 'ready' || word === 'resolving' || word === 'empty') return word;
  return 'unknown';
}

export type SkipPrep = 'skip-now' | 'commit';

// Nothing queued: bare skip, auto.m3u is the honest next. Anything queued:
// commit first, covering the held-unsent pick and the still-resolving race.
export function skipPrepAction(upcomingCount: number): SkipPrep {
  return upcomingCount > 0 ? 'commit' : 'skip-now';
}

// Whether the wait loop may hand over to the telnet skip. Only the HEAD of
// upcoming counts, so a later item's TTS render never delays the skip. 'empty'
// after a send keeps waiting, never satisfies: it can be the 1s poll race or a
// boundary prefetch, both invisible to queue().
export function commitSatisfied(p: {
  headSent: boolean;
  queueStatus: DjQueueStatus;
  sinceHeadSentMs: number;
}): boolean {
  if (!p.headSent) return false;
  if (p.queueStatus === 'ready') return true;
  if (p.queueStatus === 'unknown') return p.sinceHeadSentMs >= UNKNOWN_STATUS_GRACE_MS;
  return false;
}

// ── Targeted skip (#2017) ───────────────────────────────────────────────────
// A skip carrying `expectId` lands only while that track is still what the
// mixer is playing. A bare skip ends whatever is on air, and that stays the
// behaviour without an id: the commit wait above can outlast the song, and a
// jingle, bed or pause-talk break leaves now-playing.json naming a song that
// is not what airs (none of the three writes that file), so a caller that
// meant one song could cut another item instead.
//
// A jingle and a bed reach that timeline differently, so they are read
// differently. Beds and breaks ride dj_queue through music_meta: the same
// on_meta writes their marker and now-playing, in feed order, so a marker
// stamped after the song was fed is after it. A jingle is not orderable that
// way. radio.liq marks it where it goes on air (one writer on the
// music_with_jingle_now switch's output, rotate and manual press alike), and
// measured on liquidsoap 2.4.6 A → J → B writes B's now-playing as A's closing
// seam is fed and J's marker lands ~50ms after it (stamped at J's own feed),
// while B is not audible until A's buffered tail and J have played. A jingle is on air for its own window instead
// (queue/voice-io.ts jingleWindow, the hold airVoice already waits out).

// When now-playing.json says its song was fed, as epoch ms, or null when the
// file carries no usable stamp. Liquidsoap writes `timestamp` as time()
// truncated to whole seconds, while the bed and break markers keep the
// fraction, so a marker inside the song's own second cannot be ordered against
// it. Count the song from the END of that second: only a song that ended
// within a second of being fed could have something after it in there, while
// a sub-second-earlier marker read as "after" would refuse every skip for the
// rest of the song.
export function songFedAtMs(np: { timestamp?: unknown } | null | undefined): number | null {
  const sec = Number(np?.timestamp);
  return Number.isFinite(sec) && sec > 0 ? (Math.floor(sec) + 1) * 1000 : null;
}

// The cross term of the jingle window, in seconds. A jingle airs after the
// OUTGOING track's buffered tail, which is that track's own crossfade stamp:
// up to CROSS_MAX_SECONDS for a controller-sized one, the station crossfade
// for anything unstamped. The station figure alone (airVoice's) lets a skip
// through during the jingle's last seconds behind a longer stamp. The cost of
// the wider pad is a refusal into the song after the jingle of this pad plus
// the window's 1s tail minus that outgoing tail: on a 10s station, 15 − D_A s,
// ~5s behind a 10s tail and ~12s behind a cold ending's 3–4s stamp.
export function skipJingleCrossSec(stationCrossfadeSec: unknown): number {
  return Math.max(Number(stationCrossfadeSec) || 10, CROSS_MAX_SECONDS);
}

// The markers the targeted skip orders against now-playing (see above).
export const SKIP_ORDERED_MARKERS = ['bed', 'break'] as const satisfies readonly Interposed[];

const INTERPOSED_REFUSAL = {
  jingle: 'jingle-on-air',
  bed: 'bed-on-air',
  break: 'break-on-air',
} as const satisfies Record<Interposed, SkipRefusalReason>;

// Why a skip aimed at `expectId` must not land, or null when it may.
// `onAirId` is now-playing.json's subsonic_id read fresh; `jingleOnAir` is
// whether a jingle's window is still open; `interposed` is the newest bed or
// break marker stamped after that song was fed (queue/voice-io.ts
// interposedSince over SKIP_ORDERED_MARKERS, the reading the seam record
// takes). A different id wins over an interposed item: the song the caller
// meant is gone either way, and naming the change is the more useful answer.
export function targetedSkipRefusal(p: {
  expectId: string;
  onAirId: string | null | undefined;
  jingleOnAir: boolean;
  interposed: Interposed | null;
}): SkipRefusalReason | null {
  if (!p.onAirId || p.onAirId !== p.expectId) return 'track-changed';
  if (p.jingleOnAir) return 'jingle-on-air';
  return p.interposed ? INTERPOSED_REFUSAL[p.interposed] : null;
}

// The 409's `error` (and the booth line) for each refusal.
export const SKIP_REFUSAL_MESSAGES: Record<SkipRefusalReason, string> = {
  'track-changed': 'that track is no longer on air — nothing skipped',
  'jingle-on-air': 'a jingle is on air, about to air or just ended — nothing skipped',
  'bed-on-air': 'a bed is on air after that track — nothing skipped',
  'break-on-air': 'a pause-and-talk break is on air after that track — nothing skipped',
};
