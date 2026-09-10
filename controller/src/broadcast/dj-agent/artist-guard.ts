// Pick-anchor and spacing artist guard policy — pure, unit-pinned
// (#1124 / #1187 / #1251 / #1406). The guard runs in dj-agent.pickViaAgent;
// this module owns which candidates a re-pick may choose from and whether the
// guard fires at all, so both are testable without a model call.

import { artistRootKey, type CandidateLike } from '../../music/recency.js';

// Re-exported so the guard's tests read its comparison key from here rather
// than reaching past into music/recency.
export { artistRootKey };

// Default for `settings.llm.artistVarietyWindow` — how many recent plays the
// guard remembers. The effective exclusion is wider than 5 plays:
// neighbourArtistRoots(n) gathers up to n queued-and-unaired tracks plus the
// on-air track plus the last n distinct plays, so up to 2n+1 artists.
export const ARTIST_VARIETY_WINDOW = 5;

// Why the guard fired. The caller escalates the two differently: a match with
// the pick-cycle anchor is worth a pool rescue, while spacing is a preference
// that yields to whatever the run already surfaced. `onair` is the historical
// telemetry spelling and is kept for compatibility; it does not assert that
// the anchor is still on air or remains the FIFO predecessor after awaits.
export type ArtistGuardCause = 'onair' | 'recent' | null;

// `recentRoots` (queue.neighbourArtistRoots) already CONTAINS the logical
// neighbours visible at the caller's snapshot. The anchor test runs first to
// select the stronger compatibility cause, so an empty spacing window still
// leaves pick-anchor protection intact. An untagged pick is never guarded: no
// artist is not evidence of a repeat.
export function artistGuardCause(
  pickRoot: string,
  anchorRoot: string,
  recentRoots: Set<string> = new Set(),
): ArtistGuardCause {
  if (!pickRoot) return null;
  if (anchorRoot && pickRoot === anchorRoot) return 'onair';
  return recentRoots.has(pickRoot) ? 'recent' : null;
}

export interface AlternativePool<T> {
  // The candidates the re-pick may choose from, keyed by id as `seen` is.
  alt: Map<string, T>;
  // How many other-artist candidates the recency window removed.
  dropped: number;
  // Every alternative was a recently-heard artist, so the window was overridden
  // and the bare rejected-artist exclusion handed back. `dropped` is 0 here
  // too, so this tells "the window was a no-op" from "it was overruled".
  starved: boolean;
}

// The candidate set for a guard re-pick. `avoidRoot` is the rejected pick's own
// artist key; `recentRoots` is the surrounding queue/history snapshot.
// Candidates with no artist are never dropped.
export function alternativeCandidates<T extends CandidateLike>(
  seen: Iterable<[string, T]>,
  avoidRoot: string,
  recentRoots: Set<string> = new Set(),
): AlternativePool<T> {
  const base = [...seen].filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || root !== avoidRoot;
  });
  if (!base.length || !recentRoots.size) return { alt: new Map(base), dropped: 0, starved: false };

  const fresh = base.filter(([, s]) => {
    const root = artistRootKey(s);
    return !root || !recentRoots.has(root);
  });
  // Every alternative is recently heard. Hand back the unnarrowed set: a repeat
  // one slot later is worse than a repeat five slots later.
  if (!fresh.length) return { alt: new Map(base), dropped: 0, starved: true };

  return { alt: new Map(fresh), dropped: base.length - fresh.length, starved: false };
}

// What the guard did, split by OUTCOME not cause: the call site only needs
// "did the pick change, and does the slot still need filling". Every relaxation
// reason is logged here.
export type ArtistGuardOutcome<T> =
  | { kind: 'none' }
  // Fired, and the pick stands anyway. Relaxed, logged, slot still ours.
  | { kind: 'kept' }
  // Fired and the re-pick landed: use these in place of the original pick.
  | { kind: 'repicked'; object: { id?: string | null } & Record<string, unknown>; song: T }
  // The pool rescue filled the slot itself (it enqueues, links and records its
  // own session turn), so the caller has nothing left to do for this pick.
  | { kind: 'rescued' };

// Everything injected — no queue, no settings, no model — so the wiring between
// these decisions is testable without a model call.
export interface ArtistGuardDeps<T> {
  // The agent's candidate and the track this pick cycle was anchored to. The
  // anchor is usually the track on air, but is the held queue head when pair
  // drain starts a deadline pick for that head's intended successor. It is a
  // captured selection input, not a continuously-current FIFO predecessor. A
  // re-picked outcome replaces only `song`/`object`; it never mutates the anchor.
  song: T;
  object: { id?: string | null } & Record<string, unknown>;
  pickAnchor: CandidateLike | null;
  // The run's own candidates, keyed by id, as pickViaAgent's `extras.seen`.
  seen: Iterable<[string, T]>;
  // queue.neighbourArtistRoots(window) — passed in rather than fetched, so the
  // caller owns every queue read. `window` is carried only for the log text.
  recentRoots: Set<string>;
  window: number;
  // A constrained re-pick over `alt`. Returns the model's object, or null when
  // the call failed or answered with an id outside the set it was offered.
  repick: (
    alt: Map<string, T>,
    reason: string,
  ) => Promise<({ id?: string | null } & Record<string, unknown>) | null>;
  // The fallback pool asked for a pick that is NOT this artist. Only ever
  // called on the pick-anchor cause — see the note at its call site.
  poolRescue: (avoidArtist: string) => Promise<'queued' | 'empty' | 'collision'>;
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

export async function runArtistGuard<T extends CandidateLike>(
  deps: ArtistGuardDeps<T>,
): Promise<ArtistGuardOutcome<T>> {
  const { song, pickAnchor, seen, recentRoots, window, repick, poolRescue, log, logEvent } = deps;

  const pickRoot = artistRootKey(song);
  const cause = artistGuardCause(pickRoot, artistRootKey(pickAnchor || {}), recentRoots);
  if (!cause) return { kind: 'none' };

  const { alt, dropped, starved } = alternativeCandidates<T>(seen, pickRoot, recentRoots);
  const label = cause === 'onair' ? 'pick-anchor artist' : 'recently-played artist';
  const telemetry = {
    cause,
    basis: cause === 'onair' ? 'pick-anchor' : 'recent-window',
  };

  // Spacing yields to the run: no fresher artist exists to re-pick, so don't
  // spend a re-pick plus a pool rescue arriving back here. An anchor match
  // still escalates through both.
  if (cause === 'recent' && (starved || !alt.size)) {
    logEvent('pick.artistGuard', {
      ...telemetry, relaxed: true, reason: alt.size ? 'all-recent' : 'no-other-artist',
      artist: song.artist, candidates: alt.size, window,
    });
    log(`recently-played artist "${song.artist}" allowed — no fresher artist among the run's candidates (spacing window ${window} slots)`);
    return { kind: 'kept' };
  }

  if (alt.size) {
    const repicked = await repick(
      alt,
      cause === 'onair'
        ? `The track you chose is by ${song.artist}, the artist on the track this pick cycle is anchored to. Avoid repeating that anchor artist; choose a DIFFERENT artist from the candidates above.`
        : `The track you chose is by ${song.artist}, who has already played in the last few slots — space artists out across the show. Choose a DIFFERENT artist from the candidates above.`,
    );
    // Resolved from `alt`, not the full `seen`, so the re-pick can only land on
    // something it was offered even if the schema ever loosens.
    const altSong = repicked?.id ? alt.get(repicked.id) : null;
    if (altSong && repicked) {
      logEvent('pick.artistGuard', { ...telemetry, relaxed: false, from: song.artist, to: altSong.artist, candidates: alt.size, recencySkipped: dropped, recencyStarved: starved, window });
      log(`${label} "${song.artist}" avoided — re-picked "${altSong.title}" by ${altSong.artist} from ${alt.size} other-artist candidate(s)${dropped ? `, ${dropped} more skipped as recently-played artists` : ''}${starved ? ' (every alternative was recently played — recency window waived)' : ''}`);
      return { kind: 'repicked', object: repicked, song: altSong };
    }
  }

  // A failed spacing re-pick keeps the pick. The pool rescue below answers
  // "does another artist exist at all", which is only in doubt for the
  // pick-anchor cause; here the run surfaced one and the model declined it.
  if (cause === 'recent') {
    logEvent('pick.artistGuard', {
      ...telemetry, relaxed: true, reason: 'repick-failed',
      artist: song.artist, candidates: alt.size, window,
    });
    log(`recently-played artist "${song.artist}" allowed — re-pick from ${alt.size} other-artist candidate(s) didn't land (spacing window ${window} slots)`);
    return { kind: 'kept' };
  }

  // Pool rescue (#1187). It enqueues, links and records its own session turn,
  // so 'queued' means the slot is filled and the caller is done. A pool pick
  // that dedups against something already queued reports 'collision' and falls
  // through to the relaxation below rather than dropping the slot.
  const rescued = await poolRescue(song.artist || '');
  const runWasThin = alt.size
    ? `re-pick from ${alt.size} other-artist candidate(s) didn't land`
    : 'every agent candidate was that artist';
  if (rescued === 'queued') {
    logEvent('pick.artistGuard', { ...telemetry, relaxed: false, reason: 'pool-rescue', artist: song.artist, candidates: alt.size });
    log(`pick-anchor artist "${song.artist}" avoided — ${runWasThin}, so the pick came from the fallback pool instead`);
    return { kind: 'rescued' };
  }
  // 'empty' (the pool holds no other artist) vs 'collision' (its pick deduped)
  // stay distinct so the log tells the two apart.
  const reason = alt.size ? 'repick-failed' : 'no-other-artist';
  logEvent('pick.artistGuard', { ...telemetry, relaxed: true, reason, artist: song.artist, candidates: alt.size, poolRescue: rescued });
  log(`pick-anchor artist "${song.artist}" allowed — ${runWasThin} and the fallback pool ${rescued === 'collision' ? 'pick was already queued' : 'had none either'} (relaxed)`);
  return { kind: 'kept' };
}
