/**
 * "Never play" on the Dash's now-playing track.
 *
 * No new rule path: the block is the library table's own
 * `POST /library/blocklist { type: 'track', trackId }` (the blocklist is
 * absolute, so the track never airs again, listener requests included) and the
 * optional skip is the existing `POST /dj/skip`. The block runs FIRST, so a
 * failed block never skips a track the operator meant to keep off the air
 * only together with the block.
 */
import { AdminResponseError, adminJson, type AdminFetch } from '../../../lib/admin-query';

export type BlockOutcome = 'added' | 'already';
export type SkipOutcome = 'not-asked' | 'done' | 'failed';

export interface NeverPlayResult {
  block: BlockOutcome;
  /** Queued copies the server dropped (`queue.purgeBlocked()`). */
  purged?: number;
  /** The new entry, for Undo. Absent when it was already blocked. */
  entry?: { type: 'track'; id: string; name?: string | null };
}

/** The block write. 409 "already blocked" is an outcome, not an error. */
export async function blockPlayingTrack(fetcher: AdminFetch, trackId: string): Promise<NeverPlayResult> {
  try {
    const j = await adminJson<{ entry?: NeverPlayResult['entry']; purged?: number }>(fetcher, '/library/blocklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'track', trackId }),
    });
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
  else parts.push(`skip failed${o.skipError ? `: ${o.skipError}` : ''}`);
  if (o.purged) parts.push(`${o.purged} dropped from queue`);
  return { tone: o.skip === 'failed' ? 'err' : 'ok', text: parts.join(' · ') };
}
