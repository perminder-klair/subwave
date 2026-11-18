/**
 * The Dash's Skip dialog: skip the now-playing track, keep it (or its album,
 * or its artist) off the air for good, or both. One button and one dialog,
 * where there were a Skip and a Never play doing overlapping halves.
 *
 * "Just skip it" is the bare `POST /dj/skip`, unchanged: it ends whatever is
 * on air, a jingle or bed included (`broadcast.md`). A never-play choice adds
 * no new rule path: the block is the Library page's own write,
 * `POST /library/blocklist { type, trackId }` through `library/block-actions`
 * (the server resolves the album or artist from the track; the blocklist is
 * absolute, so nothing it covers airs again, listener requests included), and
 * its optional skip is the existing `POST /dj/skip`, TARGETED at the blocked
 * track (`expectId`, #2017). The block runs FIRST, so a failed block never
 * skips a track the operator meant to keep off the air only together with the
 * block.
 *
 * A plain skip's toast offers the block afterwards (`notifySkipped`), for the
 * operator who decides once the track is gone. That block skips nothing, so
 * it needs none of the on-air reads below.
 */
import type { QueryClient } from '@tanstack/react-query';
import { AdminResponseError, type AdminFetch } from '../../../lib/admin-query';
import { notify } from '../../../lib/notify';
import type { SkipRefusalReason } from '../../../lib/schemas.generated';
import { notifyBlockedWithUndo, postBlock } from '../library/block-actions';
import type { BlockEntry, BlockType } from '../library/types';
import { dashKeys } from './queries';
import type { DashStatus } from './types';

export type BlockOutcome = 'added' | 'already';
export type SkipOutcome = 'not-asked' | 'done' | 'failed' | 'moot' | 'behind-jingle' | 'unconfirmed';

/**
 * The track the dialog opened on. Captured at open, so a track change while
 * the dialog is up blocks what the operator was looking at, not its successor.
 */
export interface SkipTarget {
  /** Absent for a track outside the library: it can be skipped, never blocked. */
  id?: string;
  title: string;
  artist?: string;
  album?: string;
}

/** What the dialog does: skip only, or block at one of the three tiers. */
export type SkipChoice = 'skip' | BlockType;

export interface SkipChoiceOption {
  id: SkipChoice;
  label: string;
  detail: string;
  /** Why the choice can't be made, shown in its place. Absent: it can. */
  disabled?: string;
}

/**
 * The dialog's choices, plain skip first (the default on every open). An
 * album or artist the Dash can't name is not offered: the operator confirms
 * a block by what it covers, and the server would resolve one the dialog
 * never showed.
 */
export function skipChoices(t: SkipTarget): SkipChoiceOption[] {
  const notLibrary = t.id ? undefined : 'Only a library track can be blocked.';
  return [
    { id: 'skip', label: 'Just skip it', detail: 'Ends what is on air now. It can air again later.' },
    { id: 'track', label: 'Never this track', detail: `“${t.title}” never airs again.`, disabled: notLibrary },
    {
      id: 'album',
      label: 'Never this album',
      detail: t.album ? `Nothing from “${t.album}” airs again.` : '',
      disabled: notLibrary ?? (t.album ? undefined : 'The album on air is not known.'),
    },
    {
      id: 'artist',
      label: 'Never this artist',
      detail: t.artist ? `Nothing by ${t.artist} airs again.` : '',
      disabled: notLibrary ?? (t.artist ? undefined : 'The artist on air is not known.'),
    },
  ];
}

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

/**
 * The block write, at the track's own tier or its album's or artist's. 409
 * "already blocked" is an outcome, not an error.
 */
export async function blockPlayingTrack(
  fetcher: AdminFetch,
  trackId: string,
  scope: BlockType = 'track',
): Promise<NeverPlayResult> {
  try {
    const j = await postBlock(fetcher, scope, trackId);
    return { block: 'added', purged: j.purged, entry: j.entry };
  } catch (error) {
    if (error instanceof AdminResponseError && error.status === 409) return { block: 'already' };
    throw error;
  }
}

export function neverPlayToast(o: {
  title: string;
  artist?: string | null;
  album?: string | null;
  /** The tier blocked. Absent: the track. */
  scope?: BlockType;
  block: BlockOutcome;
  /** Absent: the block came without a skip of its own (a plain skip's follow-up). */
  skip?: SkipOutcome;
  purged?: number;
  skipError?: string;
}): { tone: 'ok' | 'err'; text: string } {
  const parts = [blockedText(o)];
  if (o.skip === 'done') parts.push('skipped');
  else if (o.skip === 'not-asked') parts.push('it finishes now');
  else if (o.skip === 'moot') parts.push('no longer on air, nothing skipped');
  else if (o.skip === 'behind-jingle') parts.push('a jingle is on air or just ended, nothing skipped — skip again in a few seconds');
  else if (o.skip === 'unconfirmed') parts.push('not confirmed on air, nothing skipped');
  else if (o.skip === 'failed') parts.push(`skip failed${o.skipError ? `: ${o.skipError}` : ''}`);
  if (o.purged) parts.push(`${o.purged} dropped from queue`);
  return { tone: o.skip === 'failed' ? 'err' : 'ok', text: parts.join(' · ') };
}

// An album or artist block without its name falls back to the track's words,
// which still say the block landed.
function blockedText(o: { title: string; artist?: string | null; album?: string | null; scope?: BlockType; block: BlockOutcome }): string {
  const by = o.artist ? ` — ${o.artist}` : '';
  const added = o.block === 'added';
  if (o.scope === 'artist' && o.artist) {
    return added ? `nothing by ${o.artist} will air again` : `${o.artist} was already on the never-play list`;
  }
  if (o.scope === 'album' && o.album) {
    return added ? `nothing from “${o.album}”${by} will air again` : `“${o.album}”${by} was already on the never-play list`;
  }
  const what = `“${o.title}”${by}`;
  return added ? `${what} will never air again` : `${what} was already on the never-play list`;
}

/** The follow-up blocks a plain skip's toast offers, in button order. */
export function skipFollowUps(t: SkipTarget): Array<{ scope: BlockType; label: string }> {
  if (!t.id) return [];
  const out: Array<{ scope: BlockType; label: string }> = [{ scope: 'track', label: 'never play' }];
  if (t.artist) out.push({ scope: 'artist', label: 'never this artist' });
  return out;
}

/**
 * A plain skip's toast. A library track's also offers to keep it off the air,
 * for the operator who decides once it is gone. Worded as a question about
 * the track the dialog showed, never as what the skip cut: a bare skip ends
 * whatever is on air, and during a jingle now-playing already names the song
 * after it.
 */
export function notifySkipped(t: SkipTarget, block: (scope: BlockType) => void): void {
  const offers = skipFollowUps(t);
  if (!offers.length) {
    notify.ok('skip track done');
    return;
  }
  notify.choices(
    'skip track done',
    `Keep “${t.title}”${t.artist ? ` — ${t.artist}` : ''} off the air?`,
    offers.map(o => ({ label: o.label, onClick: () => block(o.scope) })),
  );
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
