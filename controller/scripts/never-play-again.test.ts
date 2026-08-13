// Unit tests for broadcast/never-play-again.ts — the POST /dj/never-play-again
// orchestration AND its DELETE /library/blocklist/:type/:id reversal
// counterpart (reverseNeverPlayIgnore). Every collaborator is
// dependency-injected (see NeverPlayAgainDeps / UnblockReversalDeps), so
// these tests never touch a real state dir, Subsonic, or Liquidsoap — just
// the ordering/branching logic itself.
//
// node:test shape (per-assertion reporting), matching scripts/skip-policy.test.ts.
// Run: `tsx scripts/never-play-again.test.ts` or via `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runNeverPlayAgain,
  reverseNeverPlayIgnore,
  NeverPlayAgainError,
  type NeverPlayAgainDeps,
  type UnblockReversalDeps,
  type BlockEntryLike,
} from '../src/broadcast/never-play-again.js';

const NOW_PLAYING = { subsonic_id: 'trk1', title: 'Now Playing Title', artist: 'Now Artist', album: 'Now Album' };
const SONG = { title: 'Real Title', artist: 'Real Artist', album: 'Real Album', path: 'Artist/Album/01 Track.flac' };
// The id every fixture's now-playing/blocklist entry uses — passed as
// expectedSubsonicId in every test that isn't specifically exercising the
// stale-track mismatch case.
const EXPECTED_ID = 'trk1';

function makeEntry(overrides: Partial<BlockEntryLike> = {}): BlockEntryLike {
  return {
    type: 'track',
    id: 'trk1',
    name: 'Real Title',
    artist: 'Real Artist',
    album: 'Real Album',
    addedAt: '2026-01-01T00:00:00.000Z',
    libraryPath: null,
    ...overrides,
  };
}

// A fully-wired happy-path deps factory. Each test overrides only what it
// needs to exercise; `calls` records invocation order for the ordering test.
// blocklistAdd's default stub deliberately ignores whatever libraryPath it
// was CALLED with and always echoes back null — the real music/blocklist.ts
// add() no longer receives anything else (see the libraryPath-consistency
// fix), and a stub that faithfully modelled a bug that no longer exists
// would let a regression back in silently.
function makeDeps(calls: string[], overrides: Partial<NeverPlayAgainDeps> = {}): NeverPlayAgainDeps {
  const base: NeverPlayAgainDeps = {
    getNowPlaying: async () => { calls.push('getNowPlaying'); return NOW_PLAYING; },
    getSong: async (id) => { calls.push('getSong'); assert.equal(id, 'trk1'); return SONG; },
    blocklistAdd: async (input) => {
      calls.push('blocklistAdd');
      assert.equal(input.libraryPath, null, 'blocklistAdd must always be called with libraryPath: null — see the libraryPath-consistency fix');
      return makeEntry({ name: input.name, artist: input.artist, album: input.album, libraryPath: null });
    },
    blocklistMatch: (song) => { calls.push('blocklistMatch'); assert.equal(song.id, 'trk1'); return makeEntry(); },
    blocklistSetLibraryPath: async (type, id, libraryPath) => {
      calls.push('blocklistSetLibraryPath');
      assert.equal(type, 'track');
      assert.equal(id, 'trk1');
      return makeEntry({ libraryPath });
    },
    purgeBlocked: () => { calls.push('purgeBlocked'); return 0; },
    refreshAutoPlaylist: async () => { calls.push('refreshAutoPlaylist'); },
    ignoreEnabled: () => { calls.push('ignoreEnabled'); return true; },
    resolveWithinRoot: (rel) => { calls.push('resolveWithinRoot'); return rel; },
    ignoreAdd: async (rel) => { calls.push('ignoreAdd'); assert.equal(rel, SONG.path); return true; },
    startScan: async () => { calls.push('startScan'); return { ok: true, scanning: true }; },
    commitBeforeSkip: async () => { calls.push('commitBeforeSkip'); return { pending: false, committed: false, waitedMs: 0 }; },
    skipTrack: async () => { calls.push('skipTrack'); },
    log: () => { /* silent in tests */ },
    ...overrides,
  };
  return base;
}

test('no current track → 409, nothing else runs', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    getNowPlaying: async () => { calls.push('getNowPlaying'); return null; },
  });
  await assert.rejects(
    () => runNeverPlayAgain(deps, EXPECTED_ID),
    (err: unknown) => {
      assert.ok(err instanceof NeverPlayAgainError);
      assert.equal(err.status, 409);
      assert.match(err.message, /no current track/);
      return true;
    },
  );
  assert.deepEqual(calls, ['getNowPlaying'], 'no other collaborator is called once there is no current track');
});

test('no current track when subsonic_id is present but empty/null → still 409', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    getNowPlaying: async () => { calls.push('getNowPlaying'); return { subsonic_id: null }; },
  });
  await assert.rejects(() => runNeverPlayAgain(deps, EXPECTED_ID), NeverPlayAgainError);
});

// ── stale-track guard (expectedSubsonicId) ──────────────────────────────────
// The admin UI captures the id it's about to confirm when the dialog OPENS,
// not when it's confirmed — the request can land after the on-air track has
// already moved on. This is the authoritative re-check, run before ANY
// mutation.

test('expectedSubsonicId matches the live current track: proceeds normally', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls);
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.equal(result.ok, true);
  assert.ok(calls.includes('blocklistAdd'));
  assert.ok(calls.includes('skipTrack'));
});

test('expectedSubsonicId MISMATCH: 409, and absolutely no blocklist/.ndignore/skip changes', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls);
  await assert.rejects(
    () => runNeverPlayAgain(deps, 'a-completely-different-track-id'),
    (err: unknown) => {
      assert.ok(err instanceof NeverPlayAgainError);
      assert.equal(err.status, 409);
      assert.match(err.message, /track changed/i, 'the error clearly says the track changed, not a generic failure');
      assert.match(err.message, /try again/i, 'and tells the operator what to do about it');
      return true;
    },
  );
  // getNowPlaying is the ONLY thing that ran — the mismatch is caught before
  // getSong, before blocklistAdd, before ignoreAdd, before purgeBlocked,
  // before commitBeforeSkip/skipTrack. This is the literal "no
  // blocklist/.ndignore/skip changes" requirement, not an approximation of it.
  assert.deepEqual(calls, ['getNowPlaying']);
});

test('expectedSubsonicId mismatch message is distinct from the no-current-track message', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls);
  await assert.rejects(
    () => runNeverPlayAgain(deps, 'wrong-id'),
    (err: unknown) => {
      assert.ok(err instanceof NeverPlayAgainError);
      assert.ok(!/no current track/i.test((err as Error).message), 'a mismatch is not reported as "no current track" — they are different operator-facing situations');
      return true;
    },
  );
});

test('successful ordering: block (no libraryPath yet), purge, ignore, upgrade libraryPath, scan, THEN commit+skip, and refreshAutoPlaylist strictly last', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls);
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);

  assert.equal(result.ok, true);
  assert.equal(result.navidromeExcluded, true);
  assert.equal(result.navidromeScanTriggered, true);
  assert.equal(result.warning, null);
  assert.deepEqual(result.skip, { pending: false, committed: false });
  // libraryPath only ever lands via blocklistSetLibraryPath, AFTER ignoreAdd
  // has actually succeeded — never optimistically alongside the initial add().
  assert.equal(result.blocked.libraryPath, SONG.path);
  assert.ok(!('navidromeExcludedPath' in result), 'navidromeExcludedPath was removed from the API — nothing consumes it and it exposed filesystem-relative data for no gain');

  // blocklistMatch is only consulted on an already-blocked track — a fresh
  // add() (this scenario) must not call it. blocklistSetLibraryPath fires
  // AFTER ignoreAdd succeeds, not alongside the initial blocklistAdd — that
  // ordering IS the libraryPath-consistency fix. refreshAutoPlaylist is
  // LAST, strictly after commitBeforeSkip AND skipTrack — see the two
  // dedicated no-overlap tests below for the stronger claim (not just call
  // ORDER, but that it cannot even START until skipTrack has settled).
  assert.deepEqual(calls, [
    'getNowPlaying',
    'getSong',
    'ignoreEnabled',
    'resolveWithinRoot',
    'blocklistAdd',
    'purgeBlocked',
    'ignoreAdd',
    'blocklistSetLibraryPath',
    'startScan',
    'commitBeforeSkip',
    'skipTrack',
    'refreshAutoPlaylist',
  ]);
});

// Flushes the microtask queue (every default dep in makeDeps() resolves via
// a plain `async () => {...}` with no real I/O, so every pending promise
// ahead of the one we're deliberately holding open settles within a handful
// of microtask ticks) without letting a macrotask-scheduled continuation run
// — i.e. execution progresses as far as it possibly can, which is exactly up
// to (and blocked on) the held-open promise, and no further.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('refreshAutoPlaylist cannot start before skipTrack has RESOLVED — no telnet overlap on a successful skip', async () => {
  const calls: string[] = [];
  let releaseSkip!: () => void;
  let skipSettled = false;
  let refreshObservedSkipUnsettled = false;

  const deps = makeDeps(calls, {
    skipTrack: () => {
      calls.push('skipTrack');
      return new Promise<void>((resolve) => {
        releaseSkip = () => { skipSettled = true; resolve(); };
      });
    },
    refreshAutoPlaylist: async () => {
      calls.push('refreshAutoPlaylist');
      if (!skipSettled) refreshObservedSkipUnsettled = true;
    },
  });

  const pending = runNeverPlayAgain(deps, EXPECTED_ID);

  await flushMicrotasks();
  assert.ok(calls.includes('skipTrack'), 'execution has reached the skip attempt');
  assert.ok(!calls.includes('refreshAutoPlaylist'), 'must NOT have fired while skipTrack is still pending — this is the reported race');

  releaseSkip();
  const result = await pending;

  assert.ok(calls.includes('refreshAutoPlaylist'), 'fires once the skip attempt has settled');
  assert.equal(refreshObservedSkipUnsettled, false, 'refreshAutoPlaylist never ran while skipTrack was unsettled, at the moment it actually executed');
  assert.equal(calls.indexOf('refreshAutoPlaylist'), calls.length - 1, 'strictly after skipTrack, nothing runs concurrently after it');
  assert.equal(result.ok, true);
});

test('refreshAutoPlaylist cannot start before skipTrack has REJECTED — still launches (via finally), never overlapping, and the skip failure still propagates', async () => {
  const calls: string[] = [];
  let rejectSkip!: (err: Error) => void;
  let skipSettled = false;
  let refreshObservedSkipUnsettled = false;
  const skipError = new Error('liquidsoap telnet timeout');

  const deps = makeDeps(calls, {
    skipTrack: () => {
      calls.push('skipTrack');
      return new Promise<void>((_resolve, reject) => {
        rejectSkip = (err) => { skipSettled = true; reject(err); };
      });
    },
    refreshAutoPlaylist: async () => {
      calls.push('refreshAutoPlaylist');
      if (!skipSettled) refreshObservedSkipUnsettled = true;
    },
  });

  const pending = runNeverPlayAgain(deps, EXPECTED_ID);

  await flushMicrotasks();
  assert.ok(calls.includes('skipTrack'));
  assert.ok(!calls.includes('refreshAutoPlaylist'), 'must NOT have fired while skipTrack is still pending, even on the path that will end in a rejection');

  rejectSkip(skipError);
  await assert.rejects(() => pending, /liquidsoap telnet timeout/);

  // The route (routes/dj.ts) turns an unhandled rejection here into the same
  // 500 the existing POST /dj/skip already returns on a skip failure — this
  // module's job is only to make sure that failure still propagates AT ALL
  // (finally re-throws automatically) rather than being swallowed.
  assert.ok(calls.includes('refreshAutoPlaylist'), 'still launches on a skip FAILURE — a blocked/excluded track should still drop out of auto.m3u');
  assert.equal(refreshObservedSkipUnsettled, false, 'refreshAutoPlaylist never ran while skipTrack was unsettled, even on the failure path');
});

test('already-blocked current track (no libraryPath resolves this time either): idempotent, still purges/excludes/skips', async () => {
  const calls: string[] = [];
  const existing = makeEntry({ name: 'Old Name', libraryPath: null });
  const deps = makeDeps(calls, {
    // No path resolves THIS call either (feature disabled here), so the
    // upgrade branch has nothing to upgrade WITH — this isolates the plain
    // "already blocked, nothing new to persist" case from the upgrade case
    // covered by the next test.
    ignoreEnabled: () => { calls.push('ignoreEnabled'); return false; },
    blocklistAdd: async () => { calls.push('blocklistAdd'); return null; }, // already blocked
    blocklistMatch: (song) => { calls.push('blocklistMatch'); assert.equal(song.id, 'trk1'); return existing; },
    blocklistSetLibraryPath: async () => { calls.push('blocklistSetLibraryPath'); throw new Error('must not be called — nothing new to upgrade with'); },
  });

  const result = await runNeverPlayAgain(deps, EXPECTED_ID);

  assert.equal(result.ok, true);
  assert.equal(result.blocked, existing, 'recovers the pre-existing entry via blocklistMatch, not a fabricated one, and never upgrades it');
  assert.ok(!calls.includes('blocklistSetLibraryPath'));
  // Still completes every other step — an already-blocked track is not an
  // error, the operator's "never play this again" intent is already met and
  // the request should still purge/skip (excludeNavidrome stays off here
  // since the feature is disabled for this call).
  assert.equal(result.navidromeExcluded, false);
  assert.equal(result.skip.pending, false);
  assert.ok(calls.includes('purgeBlocked'));
  assert.ok(calls.includes('skipTrack'));
});

test('already-blocked WITHOUT libraryPath, a path resolves this time: upgrades the entry via setLibraryPath (AFTER ignoreAdd succeeds), not remove+re-add', async () => {
  const calls: string[] = [];
  const existing = makeEntry({ name: 'Old Name', addedAt: '2020-01-01T00:00:00.000Z', libraryPath: null });
  const deps = makeDeps(calls, {
    blocklistAdd: async () => { calls.push('blocklistAdd'); return null; }, // already blocked, no libraryPath yet
    blocklistMatch: (song) => { calls.push('blocklistMatch'); assert.equal(song.id, 'trk1'); return existing; },
    // The real music/blocklist.ts setLibraryPath() mutates and returns the
    // SAME entry object, changing only libraryPath — this stub mirrors that
    // exactly, rather than fabricating a fresh entry, so the assertions
    // below actually prove addedAt/name survive an UPDATE, not a lucky
    // coincidence of two independently-constructed fixtures.
    blocklistSetLibraryPath: async (type, id, libraryPath) => {
      calls.push('blocklistSetLibraryPath');
      assert.equal(type, 'track');
      assert.equal(id, 'trk1');
      existing.libraryPath = libraryPath;
      return existing;
    },
  });

  const result = await runNeverPlayAgain(deps, EXPECTED_ID);

  assert.equal(result.ok, true);
  assert.equal(result.blocked, existing, 'the SAME entry object, mutated — never a fabricated replacement');
  assert.equal(result.blocked.libraryPath, SONG.path, 'the response reflects the UPGRADED entry');
  assert.equal(result.blocked.addedAt, '2020-01-01T00:00:00.000Z', 'addedAt is preserved — never a remove()+add() round trip');
  assert.equal(result.blocked.name, 'Old Name', 'other metadata untouched by the upgrade');
  assert.ok(calls.includes('blocklistSetLibraryPath'), 'the narrow upgrade helper is used');
  assert.equal(calls.filter((c) => c === 'blocklistAdd').length, 1, 'never a second add()');
  // Ordering: blocklistMatch recovers the entry, purge happens, THEN
  // ignoreAdd actually writes the .ndignore line, and ONLY THEN is the
  // entry upgraded — the whole point of the libraryPath-consistency fix is
  // that this upgrade can never happen ahead of a confirmed write.
  assert.deepEqual(
    calls.slice(calls.indexOf('blocklistAdd'), calls.indexOf('startScan')),
    ['blocklistAdd', 'blocklistMatch', 'purgeBlocked', 'ignoreAdd', 'blocklistSetLibraryPath'],
  );
});

test('already-blocked and ALREADY carries the same libraryPath: no redundant upgrade call', async () => {
  const calls: string[] = [];
  const existing = makeEntry({ name: 'Old Name', libraryPath: SONG.path });
  const deps = makeDeps(calls, {
    blocklistAdd: async () => { calls.push('blocklistAdd'); return null; },
    blocklistMatch: (song) => { calls.push('blocklistMatch'); assert.equal(song.id, 'trk1'); return existing; },
    blocklistSetLibraryPath: async () => { calls.push('blocklistSetLibraryPath'); throw new Error('must not be called'); },
  });

  const result = await runNeverPlayAgain(deps, EXPECTED_ID);

  assert.equal(result.ok, true);
  assert.equal(result.blocked, existing);
  assert.ok(!calls.includes('blocklistSetLibraryPath'), 'no write when the entry already has this exact path');
});

test('blocklistAdd and blocklistMatch both miss → 500 internal-consistency error', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    blocklistAdd: async () => null,
    blocklistMatch: () => null,
  });
  await assert.rejects(
    () => runNeverPlayAgain(deps, EXPECTED_ID),
    (err: unknown) => {
      assert.ok(err instanceof NeverPlayAgainError);
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test('Navidrome resolution failure (getSong throws): degrades gracefully, still blocks+skips', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    getSong: async () => { calls.push('getSong'); throw new Error('Subsonic getSong timed out after 30000ms'); },
  });

  const result = await runNeverPlayAgain(deps, EXPECTED_ID);

  assert.equal(result.ok, true);
  // No path was ever resolvable, so the Navidrome-side half is skipped —
  // but the SUB/WAVE block and the skip both still happen.
  assert.equal(result.navidromeExcluded, false);
  assert.equal(result.navidromeScanTriggered, false);
  assert.equal(result.blocked.libraryPath, null);
  assert.match(result.warning ?? '', /could not resolve the file path/);
  assert.ok(calls.includes('blocklistAdd'), 'blocklist entry still uses the now-playing.json fallback name/artist/album');
  assert.ok(calls.includes('purgeBlocked'));
  assert.ok(calls.includes('skipTrack'), 'skip still happens even though the Navidrome-side half failed');
  assert.ok(!calls.includes('resolveWithinRoot'), 'never attempted without a path to validate');
  assert.ok(!calls.includes('ignoreAdd'));
  assert.ok(!calls.includes('blocklistSetLibraryPath'));
  assert.ok(!calls.includes('startScan'), 'scan is only triggered after a successful exclusion');
});

test('song has no path at all (but getSong succeeds): same graceful degradation', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    getSong: async () => { calls.push('getSong'); return { title: 'X', artist: 'Y', album: 'Z', path: null }; },
  });
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.equal(result.navidromeExcluded, false);
  assert.equal(result.blocked.libraryPath, null);
  assert.match(result.warning ?? '', /could not resolve the file path/);
});

test('never-play-ignore disabled: no warning noise, feature simply inert', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    ignoreEnabled: () => { calls.push('ignoreEnabled'); return false; },
  });
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.equal(result.navidromeExcluded, false);
  assert.equal(result.blocked.libraryPath, null);
  assert.equal(result.warning, null, 'an operator who never configured the feature is not warned every press');
  assert.ok(!calls.includes('resolveWithinRoot'));
  assert.ok(!calls.includes('ignoreAdd'));
  assert.ok(!calls.includes('blocklistSetLibraryPath'));
  assert.ok(!calls.includes('startScan'));
});

test('path validation rejects the resolved path: degrades, does not throw the whole request', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    resolveWithinRoot: () => { calls.push('resolveWithinRoot'); throw new Error('song.path escapes NEVER_PLAY_LIBRARY_PATH'); },
  });
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.equal(result.ok, true);
  assert.equal(result.navidromeExcluded, false);
  assert.equal(result.blocked.libraryPath, null);
  assert.match(result.warning ?? '', /escapes NEVER_PLAY_LIBRARY_PATH/);
  assert.ok(calls.includes('skipTrack'), 'still skips despite the rejected path');
});

test('.ndignore write fails on a FRESH block: does not roll back the blocklist entry, and does NOT falsely record libraryPath', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    ignoreAdd: async () => { calls.push('ignoreAdd'); throw new Error('EACCES: permission denied'); },
  });
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.equal(result.ok, true);
  assert.equal(result.navidromeExcluded, false);
  assert.match(result.warning ?? '', /Navidrome exclusion failed/);
  assert.ok(calls.includes('blocklistAdd'), 'the SUB/WAVE-side block already happened and is not undone');
  // The core of the libraryPath-consistency fix: a failed .ndignore write
  // must leave the persisted entry with NO libraryPath, not the path it
  // failed to write. blocklistSetLibraryPath is only ever reached AFTER
  // ignoreAdd resolves successfully, so it must never even be called here.
  assert.equal(result.blocked.libraryPath, null, 'a failed .ndignore write must NOT leave the blocklist entry claiming the path was written');
  assert.ok(!calls.includes('blocklistSetLibraryPath'), 'never reached — ignoreAdd threw before it');
  assert.ok(!calls.includes('startScan'), 'no scan is triggered for a failed exclusion');
  assert.ok(calls.includes('skipTrack'));
});

test('.ndignore write fails on an ALREADY-BLOCKED entry: does not falsely upgrade libraryPath either', async () => {
  const calls: string[] = [];
  const existing = makeEntry({ name: 'Old Name', libraryPath: null });
  const deps = makeDeps(calls, {
    blocklistAdd: async () => { calls.push('blocklistAdd'); return null; },
    blocklistMatch: (song) => { calls.push('blocklistMatch'); assert.equal(song.id, 'trk1'); return existing; },
    blocklistSetLibraryPath: async () => { calls.push('blocklistSetLibraryPath'); throw new Error('must not be called — ignoreAdd never succeeded'); },
    ignoreAdd: async () => { calls.push('ignoreAdd'); throw new Error('EACCES: permission denied'); },
  });
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.equal(result.navidromeExcluded, false);
  assert.equal(result.blocked, existing);
  assert.equal(result.blocked.libraryPath, null, 'the already-blocked entry is not falsely upgraded when the write fails');
  assert.ok(!calls.includes('blocklistSetLibraryPath'));
});

test('startScan reports failure (unsupported Navidrome version): non-fatal, still excluded, libraryPath still recorded', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    startScan: async () => { calls.push('startScan'); return { ok: false }; },
  });
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.equal(result.navidromeExcluded, true, 'the .ndignore write itself succeeded');
  assert.equal(result.navidromeScanTriggered, false);
  assert.equal(result.blocked.libraryPath, SONG.path, 'the write succeeded, so the path IS recorded regardless of the scan trigger outcome');
  assert.match(result.warning ?? '', /scan trigger failed/i);
});

test('skip failure propagates unhandled — everything before it already committed', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    skipTrack: async () => { calls.push('skipTrack'); throw new Error('Liquidsoap unreachable'); },
  });
  await assert.rejects(() => runNeverPlayAgain(deps, EXPECTED_ID), /Liquidsoap unreachable/);
  // Not a NeverPlayAgainError — the raw skip failure propagates as-is, same
  // as the existing POST /dj/skip route's own failure shape.
  assert.ok(calls.includes('blocklistAdd'));
  assert.ok(calls.includes('ignoreAdd'));
  assert.ok(calls.includes('startScan'));
  assert.ok(calls.includes('commitBeforeSkip'));
  assert.ok(calls.includes('skipTrack'));
  // Still launches via `finally` even though skipTrack threw — see the
  // dedicated no-overlap tests above for proof it never runs CONCURRENTLY
  // with the skip attempt; this just confirms the failure path doesn't
  // swallow it.
  assert.ok(calls.includes('refreshAutoPlaylist'));
  assert.equal(calls.indexOf('refreshAutoPlaylist'), calls.length - 1, 'strictly after skipTrack, not before it');
});

test('commitBeforeSkip failure also propagates unhandled, and still fires refreshAutoPlaylist afterward', async () => {
  const calls: string[] = [];
  const deps = makeDeps(calls, {
    commitBeforeSkip: async () => { calls.push('commitBeforeSkip'); throw new Error('telnet timeout'); },
  });
  await assert.rejects(() => runNeverPlayAgain(deps, EXPECTED_ID), /telnet timeout/);
  assert.ok(!calls.includes('skipTrack'), 'never reaches the skip call itself');
  // The `finally` wraps commitBeforeSkip too, not just skipTrack — a failure
  // there must not skip the auto-playlist refresh either.
  assert.ok(calls.includes('refreshAutoPlaylist'));
  assert.equal(calls.indexOf('refreshAutoPlaylist'), calls.length - 1, 'strictly after commitBeforeSkip, never before it');
});

test('pending-but-not-committed skip is logged distinctly (does not affect the response shape)', async () => {
  const calls: string[] = [];
  const logs: Array<{ kind: string; message: string }> = [];
  const deps = makeDeps(calls, {
    commitBeforeSkip: async () => ({ pending: true, committed: false, waitedMs: 20_000 }),
    log: (kind, message) => logs.push({ kind, message }),
  });
  const result = await runNeverPlayAgain(deps, EXPECTED_ID);
  assert.deepEqual(result.skip, { pending: true, committed: false });
  assert.ok(logs.some((l) => l.message.includes('not confirmed in dj_queue')));
});

// ── reverseNeverPlayIgnore (DELETE /library/blocklist/:type/:id) ───────────
// The unblock-reversal counterpart to runNeverPlayAgain's block path. Called
// by routes/library.ts AFTER the SUB/WAVE-side unblock already succeeded —
// these tests only cover the Navidrome-side reversal outcome itself, never
// whether the underlying blocklist removal happened (that's music/
// blocklist.test.ts's job).

function makeReversalDeps(calls: string[], overrides: Partial<UnblockReversalDeps> = {}): UnblockReversalDeps {
  return {
    ignoreEnabled: () => { calls.push('ignoreEnabled'); return true; },
    ignoreRemove: async (rel) => { calls.push('ignoreRemove'); assert.equal(rel, SONG.path); return true; },
    startScan: async () => { calls.push('startScan'); return { ok: true, scanning: true }; },
    log: () => { /* silent in tests */ },
    ...overrides,
  };
}

test('reverseNeverPlayIgnore: no libraryPath — a plain block that never touched Navidrome — is a pure no-op', async () => {
  const calls: string[] = [];
  const deps = makeReversalDeps(calls);
  const result = await reverseNeverPlayIgnore(deps, null);
  assert.deepEqual(result, { reverted: false, warning: null });
  assert.deepEqual(calls, [], 'ignoreEnabled is checked lazily behind the null-path short-circuit — nothing runs at all');
});

test('reverseNeverPlayIgnore: feature disabled — no-op even with a libraryPath present', async () => {
  const calls: string[] = [];
  const deps = makeReversalDeps(calls, {
    ignoreEnabled: () => { calls.push('ignoreEnabled'); return false; },
  });
  const result = await reverseNeverPlayIgnore(deps, SONG.path);
  assert.deepEqual(result, { reverted: false, warning: null });
  assert.ok(!calls.includes('ignoreRemove'));
  assert.ok(!calls.includes('startScan'));
});

test('reverseNeverPlayIgnore: line already gone (hand-edited, or a prior partial reversal) — not a failure', async () => {
  const calls: string[] = [];
  const deps = makeReversalDeps(calls, {
    ignoreRemove: async (rel) => { calls.push('ignoreRemove'); assert.equal(rel, SONG.path); return false; },
  });
  const result = await reverseNeverPlayIgnore(deps, SONG.path);
  assert.deepEqual(result, { reverted: false, warning: null }, 'a miss is treated as "nothing left to do", not degraded');
  assert.ok(!calls.includes('startScan'), 'no point scanning when nothing was actually removed');
});

test('reverseNeverPlayIgnore: full success — removed and scan triggered', async () => {
  const calls: string[] = [];
  const deps = makeReversalDeps(calls);
  const result = await reverseNeverPlayIgnore(deps, SONG.path);
  assert.deepEqual(result, { reverted: true, warning: null });
  assert.deepEqual(calls, ['ignoreEnabled', 'ignoreRemove', 'startScan']);
});

test('reverseNeverPlayIgnore: removed successfully but the scan trigger fails — degraded, not failed', async () => {
  const calls: string[] = [];
  const deps = makeReversalDeps(calls, {
    startScan: async () => { calls.push('startScan'); return { ok: false }; },
  });
  const result = await reverseNeverPlayIgnore(deps, SONG.path);
  assert.equal(result.reverted, true, 'the .ndignore removal itself succeeded');
  assert.match(result.warning ?? '', /scan trigger failed/i);
});

test('reverseNeverPlayIgnore: ignoreRemove throws — reported as a warning, not swallowed', async () => {
  const calls: string[] = [];
  const logs: Array<{ kind: string; message: string }> = [];
  const deps = makeReversalDeps(calls, {
    ignoreRemove: async () => { calls.push('ignoreRemove'); throw new Error('EACCES: permission denied'); },
    log: (kind, message) => logs.push({ kind, message }),
  });
  const result = await reverseNeverPlayIgnore(deps, SONG.path);
  assert.equal(result.reverted, false);
  assert.match(result.warning ?? '', /reversal failed/i);
  assert.ok(!calls.includes('startScan'), 'never reached — the removal itself threw');
  assert.ok(logs.some((l) => l.kind === 'error' && l.message.includes('permission denied')), 'the failure is also logged server-side, same as before');
});
