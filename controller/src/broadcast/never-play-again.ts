// "Never Play Again" orchestration — POST /dj/never-play-again. Blocks the
// current track in SUB/WAVE's own blocklist, best-effort excludes it from
// Navidrome's own catalog (music/never-play-ignore.ts + a triggered Navidrome
// rescan), then skips it — in that order, because the blocklist entry must
// exist before the skip risks a re-pick.
//
// Split out of routes/dj.ts rather than inlined in the Express handler for
// the same reason broadcast/skip-policy.ts and broadcast/drain-policy.ts are
// their own modules — root CLAUDE.md's rule that a decision composed from
// several steps and reached from more than one place lives in its own
// module, never inlined at the call site. This module deliberately imports
// NOTHING from music/blocklist.js, music/subsonic.js, music/never-play-ignore.js
// or broadcast/queue.js — every collaborator arrives via `deps`, which keeps
// this file free of their (large) import graphs and lets
// scripts/never-play-again.test.ts exercise every branch with plain stub
// functions: no state dir, no Subsonic, no Liquidsoap. routes/dj.ts (which
// already imports all of those for its other routes) builds the real `deps`
// object and is the only production caller.

/** The shape of a music/blocklist.ts BlockEntry this module actually reads —
 *  kept local (rather than importing music/blocklist.js's type) for the same
 *  import-graph reason as everything else here. */
export interface BlockEntryLike {
  type: string;
  id: string;
  name: string | null;
  artist: string | null;
  album: string | null;
  addedAt: string;
  libraryPath?: string | null;
}

export interface NeverPlayAgainDeps {
  /** queue.getNowPlaying() — the live now-playing.json snapshot. */
  getNowPlaying: () => Promise<{ subsonic_id?: string | null; title?: string | null; artist?: string | null; album?: string | null } | null>;
  /** subsonic.getSong(id) — may throw (Navidrome unreachable); the
   *  orchestrator catches that itself, callers don't need to. */
  getSong: (id: string) => Promise<{ title?: string | null; artist?: string | null; album?: string | null; path?: string | null } | null>;
  /** blocklist.add(input) — returns null on an already-blocked (type, id).
   *  Always called with libraryPath: null — see the libraryPath-consistency
   *  note below runNeverPlayAgain for why. */
  blocklistAdd: (input: {
    type: 'track';
    id: string;
    name: string | null;
    artist: string | null;
    album: string | null;
    libraryPath: string | null;
  }) => Promise<BlockEntryLike | null>;
  /** blocklist.matchOf({id}) — used only to recover the existing entry when
   *  blocklistAdd() reports an already-blocked track. */
  blocklistMatch: (song: { id: string }) => BlockEntryLike | null;
  /** blocklist.setLibraryPath(type, id, libraryPath) — the ONLY place
   *  libraryPath is ever written onto a blocklist entry, and only once
   *  ignoreAdd() below has actually confirmed the .ndignore write landed —
   *  covers a fresh block and an already-blocked entry alike (both start
   *  this function with libraryPath unset on `blocked`). Never called when
   *  the existing entry already carries the same path. Returns null only if
   *  the entry vanished between the earlier add()/match() and this call. */
  blocklistSetLibraryPath: (type: 'track', id: string, libraryPath: string) => Promise<BlockEntryLike | null>;
  /** queue.purgeBlocked() — drops now-blocked upcoming items, returns how many. */
  purgeBlocked: () => number;
  /** scheduler.refreshAutoPlaylist() — rewrites auto.m3u. */
  refreshAutoPlaylist: () => Promise<void>;
  /** never-play-ignore.isEnabled() — is NEVER_PLAY_LIBRARY_PATH configured. */
  ignoreEnabled: () => boolean;
  /** never-play-ignore.resolveWithinRoot(rel) — throws on an invalid/escaping path. */
  resolveWithinRoot: (rel: string) => string;
  /** never-play-ignore.add(rel) — may throw (missing/unwritable library root). */
  ignoreAdd: (rel: string) => Promise<boolean>;
  /** subsonic.startScan() — never throws by its own contract, but treated as
   *  fallible here regardless (deps are an interface, not a promise). */
  startScan: () => Promise<{ ok: boolean; scanning?: boolean }>;
  /** queue.commitBeforeSkip() — the existing /dj/skip pair-aware commit wait. */
  commitBeforeSkip: () => Promise<{ pending: boolean; committed: boolean; waitedMs: number }>;
  /** liquidsoap-control.skipTrack() — the telnet skip. */
  skipTrack: () => Promise<unknown>;
  /** queue.log(kind, message) — the booth log / admin audit trail. */
  log: (kind: string, message: string) => void;
}

export interface NeverPlayAgainResult {
  ok: true;
  blocked: BlockEntryLike;
  purged: number;
  navidromeExcluded: boolean;
  navidromeScanTriggered: boolean;
  skip: { pending: boolean; committed: boolean };
  warning: string | null;
}

/** Thrown for the cases the route reports as a real failure rather than a
 *  degraded 200: no current track, a stale confirmation (409 both), and an
 *  internal-consistency failure (500) that should be unreachable in
 *  practice. A failed SKIP is deliberately NOT one of these — it propagates
 *  as whatever error commitBeforeSkip()/skipTrack() threw, so the caller
 *  (routes/dj.ts) reports it exactly like the existing POST /dj/skip
 *  already does. */
export class NeverPlayAgainError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'NeverPlayAgainError';
    this.status = status;
  }
}

/**
 * `expectedSubsonicId` is the id the operator actually confirmed — captured
 * by the admin UI at the moment the confirmation dialog was opened (see
 * web/components/admin/DashPanel.tsx), not re-derived from whatever's
 * playing when this function happens to run. Checked immediately against the
 * live now-playing.json snapshot, before ANY blocklist/.ndignore/skip
 * mutation: the operator can confirm a destructive dialog and, by the time
 * the request lands, the on-air track has already moved on (a short jingle,
 * a fast transition, or simple hesitation on the modal) — without this
 * check, the request would silently act on whatever is NOW playing rather
 * than what the operator actually looked at and approved.
 */
export async function runNeverPlayAgain(deps: NeverPlayAgainDeps, expectedSubsonicId: string): Promise<NeverPlayAgainResult> {
  const now = await deps.getNowPlaying();
  const subsonicId = now?.subsonic_id;
  if (!subsonicId) {
    throw new NeverPlayAgainError(409, 'no current track');
  }
  if (subsonicId !== expectedSubsonicId) {
    throw new NeverPlayAgainError(409, 'the on-air track changed before this could be applied — try again');
  }

  // Navidrome unreachable degrades to the now-playing.json snapshot's own
  // title/artist/album (no `path`, so the Navidrome-side half is skipped
  // below) — never fails the whole request over a single upstream call, the
  // same posture POST /library/blocklist already takes for its trackId
  // resolution.
  let song: { title?: string | null; artist?: string | null; album?: string | null; path?: string | null } | null = null;
  try {
    song = await deps.getSong(subsonicId);
  } catch (err: any) {
    deps.log('error', `never-play-again: getSong(${subsonicId}) failed: ${err?.message ?? err}`);
  }

  const name = song?.title ?? now?.title ?? null;
  const artist = song?.artist ?? now?.artist ?? null;
  const album = song?.album ?? now?.album ?? null;

  let libraryPath: string | null = null;
  let warning: string | null = null;

  if (!deps.ignoreEnabled()) {
    // Feature not configured — not a failure, nothing to warn about: an
    // operator who never set NEVER_PLAY_LIBRARY_PATH doesn't need to be told
    // on every single press.
  } else if (!song?.path) {
    warning = 'Navidrome exclusion skipped — could not resolve the file path';
  } else {
    try {
      libraryPath = deps.resolveWithinRoot(song.path);
    } catch (err: any) {
      warning = `Navidrome exclusion skipped — ${err?.message ?? err}`;
      deps.log('error', `never-play-again: path validation failed: ${err?.message ?? err}`);
    }
  }

  // The SUB/WAVE-side block — the one half of this feature that must always
  // succeed for the request to mean anything. Always blocked WITHOUT a
  // libraryPath yet: that field is set later, once (and only once) the
  // .ndignore write below has actually succeeded — never optimistically
  // ahead of it, or a failed Navidrome-side write would leave the blocklist
  // entry falsely claiming an exclusion that was never written (see
  // BlockEntry.libraryPath's own doc comment in music/blocklist.ts: "the
  // exact song.path this entry ALSO WROTE into .ndignore").
  //
  // An already-blocked current track (blocklistAdd returns null) is NOT an
  // error: the operator's intent ("never play this again") is already
  // satisfied, so recover the existing entry and carry on to
  // purge/exclude/skip exactly as if this had been a fresh block.
  const added = await deps.blocklistAdd({ type: 'track', id: subsonicId, name, artist, album, libraryPath: null });
  let blocked = added ?? deps.blocklistMatch({ id: subsonicId });
  if (!blocked) {
    // Unreachable in practice — blocklistMatch({id}) keys on the exact id
    // blocklistAdd just reported as a duplicate of — but never surface an
    // internal inconsistency as a silently-undefined response field.
    throw new NeverPlayAgainError(500, 'blocklist entry missing after add()');
  }
  deps.log('blocked', added
    ? `${name ?? subsonicId} — ${artist ?? 'unknown artist'} added to the never-play blocklist (never-play-again)`
    : `${name ?? subsonicId} — already on the never-play blocklist (never-play-again)`);

  const purged = deps.purgeBlocked();

  let navidromeExcluded = false;
  let navidromeScanTriggered = false;

  if (libraryPath) {
    try {
      await deps.ignoreAdd(libraryPath);
      navidromeExcluded = true;
      // Only now — the write has actually landed — record it on the
      // blocklist entry, so a later unblock (routes/library.ts DELETE) can
      // find and reverse it. One unified check covers both a fresh block
      // (blocked.libraryPath is still null from the add() above) and an
      // already-blocked entry that never had one recorded, or had a stale
      // one from before this track's path could be resolved.
      if (blocked.libraryPath !== libraryPath) {
        const upgraded = await deps.blocklistSetLibraryPath('track', subsonicId, libraryPath);
        if (upgraded) blocked = upgraded;
      }
    } catch (err: any) {
      warning = `Navidrome exclusion failed — ${err?.message ?? err}`;
      deps.log('error', `never-play-again: .ndignore update failed: ${err?.message ?? err}`);
    }
  }

  if (navidromeExcluded) {
    // Awaited (not fire-and-forget): the round trip that ASKS Navidrome to
    // scan is normally fast. "Not awaited to completion" means the scan
    // itself — this call returns as soon as Navidrome acknowledges the
    // request, well before a library-size-dependent scan finishes.
    const scan = await deps.startScan();
    navidromeScanTriggered = scan.ok;
    if (!scan.ok) {
      warning = "Navidrome scan trigger failed — the exclusion will apply on Navidrome's next scheduled scan instead";
    }
  }

  // Everything above has already committed and is NOT rolled back if the
  // skip fails below — a working SUB/WAVE-side block (and, when it landed,
  // a working Navidrome-side exclusion) is strictly better than none, and
  // undoing it because a DIFFERENT subsystem (Liquidsoap) failed would
  // punish the parts that succeeded. A skip failure propagates to the
  // caller unhandled — routes/dj.ts reports it exactly like the existing
  // POST /dj/skip already does (a 500 with the error message), not a
  // multi-status partial-success shape.
  //
  // refreshAutoPlaylist() is deliberately NOT launched until AFTER this try
  // settles (success or failure) — it also talks to Liquidsoap over telnet
  // (an `auto.reload` command), and launched concurrently with
  // commitBeforeSkip()/skipTrack()'s own telnet exchanges it raced them for
  // the connection, observed live as skipTrack() itself timing out
  // ("liquidsoap telnet timeout") while refreshAutoPlaylist's reload failed
  // right alongside it. The skip is the operator's immediate, highest-
  // priority intent here; the auto-playlist refresh is best-effort
  // housekeeping and must never contend with it for Liquidsoap's telnet
  // port. `finally` is what makes this hold even when skipTrack() throws:
  // the refresh still needs to run (a blocked track dropped from
  // upcoming/current-avoidance should also drop out of auto.m3u), just
  // strictly after the skip's own telnet calls have fully settled, never
  // alongside them.
  try {
    const prep = await deps.commitBeforeSkip();
    await deps.skipTrack();
    deps.log('scheduler', prep.pending && !prep.committed
      ? `track skipped by operator (never-play-again) — queued pick not confirmed in dj_queue after ${Math.round(prep.waitedMs / 1000)}s; the auto playlist may fill the slot first`
      : 'track skipped by operator (never-play-again)');

    return {
      ok: true,
      blocked,
      purged,
      navidromeExcluded,
      navidromeScanTriggered,
      skip: { pending: prep.pending, committed: prep.committed },
      warning,
    };
  } finally {
    // Fire-and-forget, same posture the existing POST /library/blocklist
    // call site (routes/library.ts) already has for this call — never let a
    // slow/failed auto.m3u rewrite hold up the response (success OR the
    // error this finally is running ahead of).
    deps.refreshAutoPlaylist().catch((err: any) =>
      deps.log('error', `never-play-again: auto-playlist refresh failed: ${err?.message ?? err}`));
  }
}

// ── unblock reversal (DELETE /library/blocklist/:type/:id) ─────────────────

export interface UnblockReversalDeps {
  /** never-play-ignore.isEnabled() — is NEVER_PLAY_LIBRARY_PATH configured. */
  ignoreEnabled: () => boolean;
  /** never-play-ignore.remove(rel) — may throw (missing/unwritable library root). */
  ignoreRemove: (rel: string) => Promise<boolean>;
  /** subsonic.startScan() — never throws by its own contract. */
  startScan: () => Promise<{ ok: boolean; scanning?: boolean }>;
  /** queue.log(kind, message) — the booth log / admin audit trail. */
  log: (kind: string, message: string) => void;
}

export interface UnblockReversalResult {
  /** True once the .ndignore line was actually removed this call. False both
   *  when there was nothing to reverse (disabled, no libraryPath, or the
   *  line was already gone) AND when the removal itself failed — check
   *  `warning` to tell those two apart. */
  reverted: boolean;
  /** Non-null only when something that SHOULD have worked didn't (a write
   *  failure, or a failed scan trigger after a successful removal) — never
   *  set for the ordinary "nothing to reverse" case. */
  warning: string | null;
}

/**
 * Best-effort reversal of a never-play-again Navidrome exclusion. Called by
 * DELETE /library/blocklist/:type/:id AFTER the SUB/WAVE-side unblock has
 * already succeeded — that success is never contingent on anything here, the
 * same "operator's core ask always lands first" posture runNeverPlayAgain()
 * itself follows. Split out as its own dependency-injected function (rather
 * than inlined in the Express route) for the same testability reason the
 * whole rest of this module exists: routes/library.ts has no HTTP-level test
 * harness, so the only way to prove this logic without one is to keep it out
 * of the handler entirely.
 *
 * Returns a `warning` — surfaced by the route as a 200 body instead of the
 * usual 204 — rather than the previous behaviour, where any reversal failure
 * was only ever logged server-side and the caller had no way to know.
 */
export async function reverseNeverPlayIgnore(deps: UnblockReversalDeps, libraryPath: string | null): Promise<UnblockReversalResult> {
  if (!libraryPath || !deps.ignoreEnabled()) return { reverted: false, warning: null };
  try {
    const removed = await deps.ignoreRemove(libraryPath);
    if (!removed) {
      // The .ndignore line was already gone (hand-edited, or a previous
      // partial reversal) — nothing left to reverse, not a failure; the
      // SUB/WAVE-side unblock this runs after already covers the operator's
      // actual ask.
      return { reverted: false, warning: null };
    }
    const scan = await deps.startScan();
    if (!scan.ok) {
      return { reverted: true, warning: "Navidrome scan trigger failed — the reversal will apply on Navidrome's next scheduled scan instead" };
    }
    return { reverted: true, warning: null };
  } catch (err: any) {
    deps.log('error', `never-play-again: .ndignore removal failed for "${libraryPath}": ${err?.message ?? err}`);
    return { reverted: false, warning: `Navidrome exclusion reversal failed — ${err?.message ?? err}` };
  }
}
