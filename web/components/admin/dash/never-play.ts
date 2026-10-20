/**
 * "Never play" on the Dash's now-playing track.
 *
 * No new rule path: the block is the Library page's own write,
 * `POST /library/blocklist { type: 'track', trackId }` through
 * `library/block-actions` (the blocklist is absolute, so the track never airs
 * again, listener requests included), and the optional skip is the existing
 * `POST /dj/skip`. The block runs FIRST, so a
 * failed block never skips a track the operator meant to keep off the air
 * only together with the block.
 */
import { AdminResponseError, type AdminFetch } from '../../../lib/admin-query';
import { postBlock } from '../library/block-actions';
import type { BlockEntry } from '../library/types';

export type BlockOutcome = 'added' | 'already';
export type SkipOutcome = 'not-asked' | 'done' | 'failed' | 'moot';

/**
 * Whether to skip after the block lands. `onAirId` must come from a FRESH
 * status read taken after the block request resolved: the track can change
 * while that request is in flight (a slow Navidrome getSong has no upper
 * bound), and a skip decided on the status the click saw would skip the
 * successor for every listener. An unknown on-air track is never skipped.
 */
export function skipDecision(o: {
  skipToo: boolean;
  targetId: string;
  onAirId: string | null | undefined;
}): 'skip' | 'not-asked' | 'moot' {
  if (!o.skipToo) return 'not-asked';
  return o.onAirId && o.onAirId === o.targetId ? 'skip' : 'moot';
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
  else parts.push(`skip failed${o.skipError ? `: ${o.skipError}` : ''}`);
  if (o.purged) parts.push(`${o.purged} dropped from queue`);
  return { tone: o.skip === 'failed' ? 'err' : 'ok', text: parts.join(' · ') };
}
