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
