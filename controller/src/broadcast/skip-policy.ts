import type { SkipRefusalReason } from '../schemas/dj.js';
import type { Interposed } from './queue/pure.js';

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
// jingle, bed or pause-talk break after it leaves now-playing.json naming it
// (none of the three writes that file), so a caller that meant one song could
// cut the next item instead.

// When now-playing.json says its song was fed, as epoch ms, or null when the
// file carries no usable stamp. Liquidsoap writes `timestamp` as time()
// truncated to whole seconds, while the jingle, bed and break markers keep the
// fraction, so a marker inside the song's own second cannot be ordered against
// it. Count the song from the END of that second: only a song that ended
// within a second of being fed could have something after it in there, while
// a sub-second-earlier marker read as "after" would refuse every skip for the
// rest of the song.
export function songFedAtMs(np: { timestamp?: unknown } | null | undefined): number | null {
  const sec = Number(np?.timestamp);
  return Number.isFinite(sec) && sec > 0 ? (Math.floor(sec) + 1) * 1000 : null;
}

const INTERPOSED_REFUSAL = {
  jingle: 'jingle-on-air',
  bed: 'bed-on-air',
  break: 'break-on-air',
} as const satisfies Record<Interposed, SkipRefusalReason>;

// Why a skip aimed at `expectId` must not land, or null when it may.
// `onAirId` is now-playing.json's subsonic_id read fresh; `interposed` is the
// newest jingle/bed/break marker stamped after that song was fed
// (queue/voice-io.ts interposedSince), the same reading the seam record takes.
// A different id wins over an interposed item: the song the caller meant is
// gone either way, and naming the change is the more useful answer.
export function targetedSkipRefusal(p: {
  expectId: string;
  onAirId: string | null | undefined;
  interposed: Interposed | null;
}): SkipRefusalReason | null {
  if (!p.onAirId || p.onAirId !== p.expectId) return 'track-changed';
  return p.interposed ? INTERPOSED_REFUSAL[p.interposed] : null;
}

// The 409's `error` (and the booth line) for each refusal.
export const SKIP_REFUSAL_MESSAGES: Record<SkipRefusalReason, string> = {
  'track-changed': 'that track is no longer on air — nothing skipped',
  'jingle-on-air': 'a jingle is on air after that track — nothing skipped',
  'bed-on-air': 'a bed is on air after that track — nothing skipped',
  'break-on-air': 'a pause-and-talk break is on air after that track — nothing skipped',
};
