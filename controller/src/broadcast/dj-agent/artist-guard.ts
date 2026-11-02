// Pick-anchor and spacing artist guard policy — pure, unit-pinned
// (#1124 / #1187 / #1251 / #1406). The guard runs in dj-agent.pickViaSelectionRoute,
// and on a listener request's stand-in in runRequestViaAgent (#1979) and the
// stateless request cascade (#1993); this module owns which candidates a
// re-pick may choose from and whether the guard fires at all, so both are
// testable without a model call.

import { artistCreditsOverlap, artistRootKey, creditedActKeys, creditInRoots, type CandidateLike } from '../../music/recency.js';

// Re-exported so the guard's tests read its comparison key from here rather
// than reaching past into music/recency.
export { artistRootKey };

// Default for `settings.llm.artistVarietyWindow` — how many recent plays the
// guard remembers. The effective exclusion is wider than 5 plays:
// neighbourArtistRoots(n) gathers up to n queued-and-unaired tracks plus the
// on-air track plus the last n distinct plays, so up to 2n+1 artists.
export const ARTIST_VARIETY_WINDOW = 5;

// The Agentic pick event names the artists this guard would refuse, so the
// model can step around them up front. Without it the model sees only its own
// pick notes, proposes an artist from the window, and every refusal costs a
// second model call (seen live: one artist proposed four slots running on a
// playlist show). The guard stays the enforcement; this is the same rule
// stated where the choice is made, never a filter on the discovery tools
// (#618). "Unless nothing else fits" matches the guard's own posture, which
// lets a repeat through when the run surfaced no alternative.
export function recentArtistsClause(credits: readonly string[]): string {
  const names = credits.map(c => String(c ?? '').trim()).filter(Boolean);
  if (!names.length) return '';
  return ` Artists just played or already queued, so choose someone else unless nothing else fits: ${names.join('; ')}.`;
}

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
// `pickCredit` is the pick's whole credit, so the spacing test sees every act
// it names (recency.creditedActKeys), not only its lead; absent, the lead
// stands for the credit, as before.
export function artistGuardCause(
  pickRoot: string,
  anchorRoot: string,
  recentRoots: Set<string> = new Set(),
  pickCredit: string = pickRoot,
): ArtistGuardCause {
  if (!pickRoot) return null;
  if (anchorRoot && artistCreditsOverlap(pickRoot, anchorRoot)) return 'onair';
  return creditInRoots(pickCredit || pickRoot, recentRoots) ? 'recent' : null;
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
// artist key; `anchorRoot` also stays excluded on an anchor match. Overlap is
// not transitive: two different combined credits can both name the anchor.
// `recentRoots` is the surrounding queue/history snapshot.
// Candidates with no artist are never dropped.
function alternativeArtist(song: CandidateLike, avoidRoot: string, anchorRoot: string): boolean {
  const root = artistRootKey(song);
  return !artistCreditsOverlap(root, avoidRoot) && !artistCreditsOverlap(root, anchorRoot);
}

// `exempt` marks candidates the recency narrowing never removes — a listener
// request's own ask (#1979). Absent, every candidate is subject to it. It is
// asked only of a candidate by a recent artist: on the request path it is the
// stand-in reading, a pass over every line the run wrote, and a pool of a
// hundred candidates asking it of each one stalled the event loop.
export function alternativeCandidates<T extends CandidateLike>(
  seen: Iterable<[string, T]>,
  avoidRoot: string,
  recentRoots: Set<string> = new Set(),
  anchorRoot = '',
  exempt: (song: T) => boolean = () => false,
): AlternativePool<T> {
  const base = [...seen].filter(([, s]) => alternativeArtist(s, avoidRoot, anchorRoot));
  if (!base.length || !recentRoots.size) return { alt: new Map(base), dropped: 0, starved: false };

  const fresh = base.filter(([, s]) => !spacedOut(s, recentRoots, exempt));
  // Every alternative is recently heard. Hand back the unnarrowed set: a repeat
  // one slot later is worse than a repeat five slots later.
  if (!fresh.length) return { alt: new Map(base), dropped: 0, starved: true };

  return { alt: new Map(fresh), dropped: base.length - fresh.length, starved: false };
}

// Does the recency narrowing remove this candidate? Its credit is in the
// window and it is not exempt; `exempt` is asked last, for the reason above.
function spacedOut<T extends CandidateLike>(song: T, recentRoots: Set<string>, exempt: (song: T) => boolean): boolean {
  return !!artistRootKey(song) && creditInRoots(song, recentRoots) && !exempt(song);
}

// How many slots ago a credit was last heard (queue.neighbourArtistDistances):
// its NEAREST act, matched the way the window matches. Not in the window:
// Infinity. Unlike the window's yes/no test (spacedOut, through artistRootIn),
// an exact hit does not end the search: "pixies" can sit nine slots back while
// "pixies • black francis" sits one back, and stopping at the exact key read
// the act as nine slots ago — the very candidate the swap then chose, straight
// after itself.
export function creditDistance(song: CandidateLike | string, distances: Map<string, number>): number {
  let best = Infinity;
  for (const act of creditedActKeys(song)) {
    best = Math.min(best, distances.get(act) ?? Infinity);
    for (const [key, d] of distances) if (d < best && artistCreditsOverlap(act, key)) best = d;
  }
  return best;
}

// When spacing has to relax (every candidate's artist is inside the window),
// the candidate whose artist was heard LONGEST ago, if it was heard longer ago
// than the pick's. Without it the guard kept the model's pick, which could be
// the artist from two slots back while a candidate from eleven slots back sat
// in the same run (Katerine, 10 Oct). No model call: the run already chose its
// candidates. A tie goes to the first-listed, which is the run's own order —
// discovery order on Agentic, fit order on Shortlist — not a ranking by the
// model. Never the anchor artist, whatever the window says.
export function leastRecentAlternative<T extends CandidateLike>(
  alt: Map<string, T>,
  pick: CandidateLike,
  distances: Map<string, number> | undefined,
  anchorRoot: string,
): { song: T; from: number; to: number } | null {
  if (!distances?.size) return null;
  const from = creditDistance(pick, distances);
  let best: { song: T; from: number; to: number } | null = null;
  for (const song of alt.values()) {
    if (anchorRoot && artistCreditsOverlap(artistRootKey(song), anchorRoot)) continue;
    const to = creditDistance(song, distances);
    if (to > from && (!best || to > best.to)) best = { song, from, to };
  }
  return best;
}

// The candidates a corrective LISTENER-REQUEST call may choose from (#1979).
// A request is exempt from spacing because an explicit ask wins, but a
// stand-in for an ask the library could not meet is the DJ's choice of
// artist, so a corrective call — the request path's one model call after the
// run — is not offered a stand-in by a recently-heard artist. What the
// listener asked for always stays, whoever played it last. No artist is being
// rejected yet, so none is avoided outright, and a set with nothing fresh left
// is handed back whole, as above: the call still gets to answer.
export function requestRepickCandidates<T extends CandidateLike>(
  seen: Iterable<[string, T]>,
  recentRoots: Set<string>,
  isStandIn: (song: T) => boolean,
): AlternativePool<T> {
  return alternativeCandidates(seen, '', recentRoots, '', (song) => !isStandIn(song));
}

export interface RequestDraw<T> {
  pick: T | null;
  // The first draw, when spacing set it aside for `pick`.
  withheld: T | null;
  // How many recent stand-ins the draw passed over to reach `pick`.
  skipped: number;
  // Every candidate was a recent stand-in, so the first draw stood.
  starved: boolean;
}

// One draw from a STATELESS listener-request pool (#1993). The request
// cascade in routes/request.ts has no model call to re-pick with, so spacing a
// stand-in is a matter of which pool member it draws: a stand-in by a
// recently-heard artist is passed over, by the test requestRepickCandidates
// narrows a corrective call's offer with. What the listener asked for stays
// in however recently it played, and a pool holding nothing but recent
// stand-ins draws as it always did, so spacing never costs a request its slot.
// Nor does it take the least-recent swap (leastRecentAlternative), which is
// the pick path's alone (ArtistGuardDeps.recentDistances).
// It redraws without replacement until a candidate passes rather than
// filtering first: a cascade pool can be a whole mood's slice of the library,
// and reading every candidate measured ~70 ms on 20k. The pick is the same,
// uniform over the candidates that pass.
export function drawRequestCandidate<T extends CandidateLike>(
  pool: readonly T[],
  recentRoots: Set<string>,
  isStandIn: (song: T) => boolean,
  random: () => number = Math.random,
): RequestDraw<T> {
  const passes = (song: T) => !spacedOut(song, recentRoots, (s) => !isStandIn(s));
  const first = pool[Math.floor(random() * pool.length)] ?? null;
  if (!first || passes(first)) return { pick: first, withheld: null, skipped: 0, starved: false };
  const rest = pool.filter((s) => s && s !== first);
  let skipped = 1;
  for (let left = rest.length; left > 0; left--) {
    const i = Math.floor(random() * left);
    const song = rest[i]!;
    rest[i] = rest[left - 1]!;
    if (passes(song)) return { pick: song, withheld: first, skipped, starved: false };
    skipped++;
  }
  return { pick: first, withheld: null, skipped: 0, starved: true };
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
  // The run's own candidates, keyed by id, as pickViaSelectionRoute's `extras.seen`.
  seen: Iterable<[string, T]>;
  // queue.neighbourArtistRoots(window) — passed in rather than fetched, so the
  // caller owns every queue read. `window` is carried only for the log text.
  recentRoots: Set<string>;
  // queue.neighbourArtistDistances(window): how many slots ago each act in
  // `recentRoots` was heard. Absent, a relaxation keeps the pick, as before.
  // PICK path only. The swap it enables answers with no ack or intro, so the
  // listener-request stand-in guard (runRequestViaAgent, #1979) must never pass
  // it: a swap there would replace the listener's answer lines with nothing.
  recentDistances?: Map<string, number>;
  window: number;
  // Candidates the recency narrowing never removes (alternativeCandidates).
  exempt?: (song: T) => boolean;
  // A constrained re-pick over `alt`. Returns the model's object, or null when
  // the call failed or answered with an id outside the set it was offered.
  repick: (
    alt: Map<string, T>,
    reason: string,
  ) => Promise<({ id?: string | null } & Record<string, unknown>) | null>;
  // The fallback pool asked for a pick that is NOT this artist. Only ever
  // called on the pick-anchor cause. Both credits stay excluded through the
  // pool's recency relaxation, since overlap is not transitive.
  poolRescue: (avoidArtist: string, avoidAnchorArtist: string) => Promise<'queued' | 'empty' | 'collision'>;
  log: (line: string) => void;
  logEvent: (name: string, payload: Record<string, unknown>) => void;
}

export async function runArtistGuard<T extends CandidateLike>(
  deps: ArtistGuardDeps<T>,
): Promise<ArtistGuardOutcome<T>> {
  const { song, pickAnchor, seen, recentRoots, window, exempt, repick, poolRescue, log, logEvent } = deps;

  const pickRoot = artistRootKey(song);
  const anchorRoot = artistRootKey(pickAnchor || {});
  const cause = artistGuardCause(pickRoot, anchorRoot, recentRoots, song?.artist || pickRoot);
  if (!cause) return { kind: 'none' };

  const avoidAnchorRoot = cause === 'onair' ? anchorRoot : '';
  const { alt, dropped, starved } = alternativeCandidates<T>(seen, pickRoot, recentRoots, avoidAnchorRoot, exempt);
  const label = cause === 'onair' ? 'pick-anchor artist' : 'recently-played artist';
  const telemetry = {
    cause,
    basis: cause === 'onair' ? 'pick-anchor' : 'recent-window',
  };

  // Spacing yields to the run: no fresher artist exists to re-pick, so don't
  // spend a re-pick plus a pool rescue arriving back here. An anchor match
  // still escalates through both. Yielding takes the candidate heard longest
  // ago when that beats the pick (leastRecentAlternative), else keeps it.
  if (cause === 'recent' && (starved || !alt.size)) {
    const older = starved ? leastRecentAlternative(alt, song, deps.recentDistances, anchorRoot) : null;
    if (older) {
      logEvent('pick.artistGuard', {
        ...telemetry, relaxed: true, reason: 'all-recent', swapped: 'least-recent',
        from: song.artist, to: older.song.artist, fromSlots: older.from, toSlots: older.to,
        candidates: alt.size, window,
      });
      log(`recently-played artist "${song.artist}" (${older.from} slot(s) ago) swapped for "${older.song.title}" by ${older.song.artist} (${older.to} slots ago) — every candidate was inside the spacing window (${window} slots), so the one heard longest ago plays`);
      return {
        kind: 'repicked',
        // The model's note and transition were written for the other track.
        object: { id: String(older.song.id), reason: '', musicalReason: '', transition: null },
        song: older.song,
      };
    }
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
        ? `The track you chose is by ${song.artist}, overlapping the ${pickAnchor?.artist} credit this pick cycle is anchored to. Avoid repeating that anchor artist; choose a DIFFERENT artist from the candidates above.`
        : `The track you chose is by ${song.artist}, who has already played in the last few slots — space artists out across the show. Choose a DIFFERENT artist from the candidates above.`,
    );
    // Resolved from `alt`, not the full `seen`, so the re-pick can only land on
    // something it was offered even if the schema ever loosens.
    const altSong = repicked?.id ? alt.get(repicked.id) : null;
    if (altSong && repicked && alternativeArtist(altSong, pickRoot, avoidAnchorRoot)) {
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
  const rescued = await poolRescue(song.artist || '', pickAnchor?.artist || '');
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
