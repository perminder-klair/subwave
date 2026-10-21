/**
 * "Never play" on the Dash's now-playing track.
 *
 * No new rule path: the block is the Library page's own write,
 * `POST /library/blocklist { type: 'track', trackId }` through
 * `library/block-actions` (the blocklist is absolute, so the track never airs
 * again, listener requests included), and the optional skip is the existing
 * `POST /dj/skip`, TARGETED at the blocked track (`expectId`, #2017). The
 * block runs FIRST, so a failed block never skips a track the operator meant
 * to keep off the air only together with the block.
 */
import type { QueryClient } from '@tanstack/react-query';
import { AdminResponseError, type AdminFetch } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import type { SkipRefusalReason } from '../../../lib/schemas.generated';
import { notifyBlockedWithUndo, postBlock } from '../library/block-actions';
import type { BlockEntry } from '../library/types';
import { dashKeys } from './queries';
import type { DashStatus } from './types';

export type BlockOutcome = 'added' | 'already';
export type SkipOutcome = 'not-asked' | 'done' | 'failed' | 'moot' | 'behind-jingle' | 'unconfirmed';

/**
 * Refetch the Dash status once the block has landed, and return the on-air id
 * from the SERVER's answer to that read, or undefined when there is none.
 *
 * The answer is the fetch's own success, caught as it lands. Never the cache
 * afterwards: it also holds the Dash's optimistic writes, stamped as fresh as
 * any read. Removing a queue row cancels this very refetch and writes the
 * pre-block status back minus the row, so a cache read named the blocked track
 * after the server had moved on, and the skip cut its successor (#2018). A
 * `setQueryData` write is a `manual` success, so it never counts, whoever
 * writes the cache now or later. Nor the fetch's return value: a fetch
 * cancelled by an unmount resolves with the cached data, and one paused
 * offline never resolves.
 *
 * No answer: a refetch that fails, is cancelled with nothing after it (that
 * row removal), is cancelled by the Dash unmounting, or returns at once while
 * offline. Nothing is skipped without one. A refetch cancelled by a newer one
 * (another Dash action's invalidation) takes that fetch's answer, which was
 * sent later still. The LAST success counts: a poll already answered when the
 * refetch goes out cannot be cancelled and still writes inside the window,
 * ahead of the refetch's own answer.
 */
export async function refetchOnAirId(client: QueryClient): Promise<string | undefined> {
  const queryKey = dashKeys.status();
  const query = client.getQueryCache().find<DashStatus>({ queryKey, exact: true });
  if (!query) return undefined;
  let read: DashStatus | undefined;
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.query !== query) return;
    if (event.action.type === 'success' && !event.action.manual) read = event.action.data as DashStatus | undefined;
  });
  try {
    await client.refetchQueries({ queryKey, exact: true });
  } finally {
    unsubscribe();
  }
  return read?.nowPlaying?.subsonic_id || undefined;
}

/**
 * Whether "block + skip now" skips, once the block has landed. `onAirId` must
 * come from `refetchOnAirId`: the track can change while the block request is in
 * flight (a slow Navidrome getSong has no upper bound), and a skip decided on
 * the status the click saw would skip the successor for every listener. No
 * fresh read, or one naming no track, is never skipped.
 */
export function skipDecision(o: {
  targetId: string;
  onAirId: string | undefined;
}): 'skip' | 'moot' | 'unconfirmed' {
  if (!o.onAirId) return 'unconfirmed';
  return o.onAirId === o.targetId ? 'skip' : 'moot';
}

/**
 * What a failed targeted skip means. A 409 skipped nothing, and its `reason`
 * says why:
 *
 *   * `track-changed`, `bed-on-air`, `break-on-air` — the blocked track is not
 *     what the mixer is playing. It ended during the skip's commit wait, or a
 *     bed or pause-talk break followed it (neither moves now-playing on, so
 *     `refetchOnAirId` still names it). The same answer as a `moot` decision.
 *   * `jingle-on-air` — the blocked track is the one now-playing names, but a
 *     jingle's seam names it before it airs: it is still queued behind the
 *     outgoing tail and the jingle, or has only just started. It is about to
 *     play, so the operator is told to skip again once it does, never that it
 *     left the air.
 *
 * A 409 with an unknown or absent reason reads as `moot`, the answer every
 * 409 got before the reasons were told apart. Anything other than a 409 is a
 * failure.
 */
export function skipFailureOutcome(error: unknown): 'moot' | 'behind-jingle' | 'failed' {
  if (!(error instanceof AdminResponseError) || error.status !== 409) return 'failed';
  const body: unknown = error.body;
  const reason = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
  return reason === ('jingle-on-air' satisfies SkipRefusalReason) ? 'behind-jingle' : 'moot';
}

export interface NeverPlayResult {
  block: BlockOutcome;
  /** Queued copies the server dropped (`queue.purgeBlocked()`). */
  purged?: number;
  /** The new entry, for Undo. Absent when it was already blocked. */
  entry?: BlockEntry;
}

/** The block write. 409 "already blocked" is an outcome, not an error. */
export async function blockPlayingTrack(fetcher: AdminFetch, trackId: string): Promise<NeverPlayResult> {
  try {
    const j = await postBlock(fetcher, 'track', trackId);
    return { block: 'added', purged: j.purged, entry: j.entry };
  } catch (error) {
    if (error instanceof AdminResponseError && error.status === 409) return { block: 'already' };
    throw error;
  }
}

export function neverPlayToast(o: {
  title: string;
  artist?: string | null;
  block: BlockOutcome;
  skip: SkipOutcome;
  purged?: number;
  skipError?: string;
}): { tone: 'ok' | 'err'; text: string } {
  const what = `“${o.title}”${o.artist ? ` — ${o.artist}` : ''}`;
  const parts = [o.block === 'added' ? `${what} will never air again` : `${what} was already on the never-play list`];
  if (o.skip === 'done') parts.push('skipped');
  else if (o.skip === 'not-asked') parts.push('it finishes now');
  else if (o.skip === 'moot') parts.push('no longer on air, nothing skipped');
  else if (o.skip === 'behind-jingle') parts.push('a jingle is on air or just ended, nothing skipped — skip again in a few seconds');
  else if (o.skip === 'unconfirmed') parts.push('not confirmed on air, nothing skipped');
  else parts.push(`skip failed${o.skipError ? `: ${o.skipError}` : ''}`);
  if (o.purged) parts.push(`${o.purged} dropped from queue`);
  return { tone: o.skip === 'failed' ? 'err' : 'ok', text: parts.join(' · ') };
}

/**
 * Show the `neverPlayToast` message. A new entry always carries Undo, after a
 * failed skip too: the block landed either way, so the error toast offers the
 * same Undo the success one does.
 */
export function notifyNeverPlay(
  t: { tone: 'ok' | 'err'; text: string },
  entry: BlockEntry | undefined,
  lift: (entry: BlockEntry) => Promise<unknown>,
): void {
  if (entry) notifyBlockedWithUndo(t.text, entry, lift, t.tone);
  else if (t.tone === 'err') notify.err(t.text);
  else notify.ok(t.text);
}
