// Pins the auto.m3u SHOW-CHANGE rebuild (#1111) — broadcast/auto-playlist-show.ts
// and its four wiring points in broadcast/scheduler.ts.
//
// THE DEFECT THIS GUARDS. `refreshAutoPlaylist` steers the fallback pool by the
// resolved active show, but it only ever ran at boot and on the
// `autoQueueRefreshMinutes` cron (default 60). A show change landing between
// two ticks therefore left the PREVIOUS show's file on disk, and with the live
// queue empty the station coasted on it: the report's Playlist Only (Strict)
// show had 26 of 28 fallback entries outside its pinned playlist until the
// operator pressed Refresh, after which all 16 were inside it. Strict is
// enforced correctly whenever the file is rebuilt — nothing was rebuilding it.
//
// The properties, and the real way each regresses:
//
//  - COMING OFF A SHOW IS A CHANGE. A key that only tracks a show's id, with no
//    identity for "no show on air", leaves the ended show's strict fallback
//    playing over default programming — the second half of every scheduled
//    boundary.
//  - AN EDIT TO THE LIVE SHOW IS A CHANGE. The pool is steered by the show's
//    genres, eras, energies, moods, vocals, strictness, pinned playlists,
//    excluded playlists and length cap, not by its id — an id-only key reports
//    "same show" for a show that now asks for entirely different music.
//  - A REORDER IS NOT. Lists are sorted into the key, so re-ordering genres in
//    the editor — which cannot change the pool — must not spend a rebuild's
//    worth of Navidrome round trips at the next boundary.
//  - A FAILED REBUILD STAYS STALE. The stamp records a build that LANDED. If a
//    throw stamped anyway, the one path that retries (the next boundary) would
//    read the stale file as current and the station would coast on the previous
//    show until the refresh cron came round — the original bug, restored.
//  - A CLAIM IS TAKEN BEFORE THE AWAIT. rollSessionNow has four call sites and
//    two can land in the same second (an expiry sweep against an operator's
//    cancel); without the claim both fan out the same Navidrome queries.
//
// The wiring itself is scraped from source: `refreshAutoPlaylistOnShowChange`
// ends in a live Navidrome fan-out, so there is no runtime seam that
// distinguishes "the hook fired" from "the hook is gone" without a real
// library behind it — the same reason picker-show-source.test.ts scrapes.
// Deliberately narrow: the anchors are the call in rollSessionNow, the stamp at
// the end of the refresh, and the four transitions naming themselves.
//
// Run: npm test -- auto-playlist-show

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  autoPlaylistShowKey,
  autoPlaylistShowLabel,
  createShowBuildTracker,
} from '../src/broadcast/auto-playlist-show.js';

// A resolved show, in the shape settings.resolveActiveShow() hands out.
const FAULTLINE = {
  id: 'show-faultline',
  name: 'FAULTLINE',
  genres: ['post-punk', 'industrial'],
  eras: [{ fromYear: 1978, toYear: 1985 }],
  energies: ['high'],
  moods: ['dark'],
  vocals: '',
  filtersStrict: true,
  playlistIds: ['q90hsP'],
  playlistStrict: true,
  excludedPlaylistIds: [],
  maxTrackSeconds: null,
};

const withField = (patch: Record<string, unknown>) => ({ ...FAULTLINE, ...patch });

// ── the key ─────────────────────────────────────────────────────────────────

test('no show on air is an identity of its own', () => {
  assert.equal(autoPlaylistShowKey(null), 'default');
  assert.equal(autoPlaylistShowKey(undefined), 'default');
  // The end of a scheduled show, and the explicit Default-programming takeover,
  // both resolve to null. Both must rebuild away from the outgoing show.
  assert.notEqual(autoPlaylistShowKey(FAULTLINE), autoPlaylistShowKey(null));
});

test('the same show resolves to the same key', () => {
  assert.equal(autoPlaylistShowKey(FAULTLINE), autoPlaylistShowKey({ ...FAULTLINE }));
});

test('a different show is a different key', () => {
  assert.notEqual(
    autoPlaylistShowKey(FAULTLINE),
    autoPlaylistShowKey(withField({ id: 'show-my-radio', name: 'My Radio' })),
  );
});

// Every field the pool build reads. An id-only key passes the test above and
// still ships the reported bug for an operator who edits the live show.
test('every field the pool is steered by moves the key', () => {
  const steering: Record<string, unknown> = {
    genres: ['shoegaze'],
    eras: [{ fromYear: 1990, toYear: 1999 }],
    energies: ['low'],
    moods: ['warm'],
    vocals: 'instrumental',
    filtersStrict: false,
    playlistIds: ['different-playlist'],
    playlistStrict: false,
    excludedPlaylistIds: ['blocked-playlist'],
    maxTrackSeconds: 420,
  };
  for (const [field, value] of Object.entries(steering)) {
    assert.notEqual(
      autoPlaylistShowKey(FAULTLINE),
      autoPlaylistShowKey(withField({ [field]: value })),
      `changing "${field}" must rebuild the fallback`,
    );
  }
});

test('an open-ended era window is distinct from a bounded one', () => {
  const open = withField({ eras: [{ fromYear: 1978, toYear: null }] });
  assert.notEqual(autoPlaylistShowKey(FAULTLINE), autoPlaylistShowKey(open));
  assert.notEqual(autoPlaylistShowKey(open), autoPlaylistShowKey(withField({ eras: [] })));
});

test('re-ordering a list does not spend a rebuild', () => {
  assert.equal(
    autoPlaylistShowKey(FAULTLINE),
    autoPlaylistShowKey(withField({ genres: ['industrial', 'post-punk'] })),
  );
  assert.equal(
    autoPlaylistShowKey(withField({ playlistIds: ['a', 'b'] })),
    autoPlaylistShowKey(withField({ playlistIds: ['b', 'a'] })),
  );
});

// The show name is for the booth log only — renaming a show doesn't change a
// note of what it plays.
test('renaming a show does not rebuild', () => {
  assert.equal(autoPlaylistShowKey(FAULTLINE), autoPlaylistShowKey(withField({ name: 'FAULT LINE' })));
});

test('the label names the show for the booth log, never the key', () => {
  assert.equal(autoPlaylistShowLabel(FAULTLINE), '"FAULTLINE"');
  assert.equal(autoPlaylistShowLabel(null), 'default programming');
  assert.equal(autoPlaylistShowLabel(withField({ name: '  ' })), 'show show-faultline');
});

// ── the tracker ─────────────────────────────────────────────────────────────

test('a controller that has never written the file needs a rebuild', () => {
  const t = createShowBuildTracker();
  assert.equal(t.needsRebuild(FAULTLINE), true);
  assert.equal(t.needsRebuild(null), true, 'not even default programming is assumed');
});

test('a build that landed suppresses the next boundary, a change does not', () => {
  const t = createShowBuildTracker();
  t.built(FAULTLINE);
  assert.equal(t.needsRebuild(FAULTLINE), false, 'the hourly roll must not refetch the same show');
  assert.equal(t.needsRebuild(null), true, 'the show ending must rebuild');
  assert.equal(t.needsRebuild(withField({ playlistIds: ['other'] })), true);
});

test('a claim stops a second boundary fanning out the same rebuild', () => {
  const t = createShowBuildTracker();
  t.built(null);
  assert.equal(t.needsRebuild(FAULTLINE), true);
  t.claim(FAULTLINE);                                  // takeover start, mid-flight
  assert.equal(t.needsRebuild(FAULTLINE), false, 'the expiry sweep must not duplicate it');
});

test('a rebuild that throws rolls back, so the next boundary retries', () => {
  const t = createShowBuildTracker();
  t.built(null);
  const rollback = t.claim(FAULTLINE);
  rollback();
  assert.equal(t.needsRebuild(FAULTLINE), true, 'a failed rebuild left the file stale');
  assert.equal(t.needsRebuild(null), false, 'rollback restores the show the file actually holds');
});

test('the landed build overwrites the claim with the show it really built for', () => {
  const t = createShowBuildTracker();
  const other = withField({ id: 'show-other', name: 'Other' });
  t.claim(FAULTLINE);
  t.built(other);   // the refresh re-resolved and found a different show live
  assert.equal(t.needsRebuild(other), false);
  assert.equal(t.needsRebuild(FAULTLINE), true);
});

// ── the wiring ──────────────────────────────────────────────────────────────

const scheduler = readFileSync(new URL('../src/broadcast/scheduler.ts', import.meta.url), 'utf8');
const shows = readFileSync(new URL('../src/routes/shows.ts', import.meta.url), 'utf8');

test('the shared boundary sequence rebuilds the fallback', () => {
  const body = scheduler.slice(scheduler.indexOf('export async function rollSessionNow'));
  const hook = body.indexOf('refreshAutoPlaylistOnShowChange(reason)');
  assert.ok(hook >= 0, 'rollSessionNow must call refreshAutoPlaylistOnShowChange — that IS the fix');
  // Fire-and-forget: holding the mic-pass behind a Navidrome pool rebuild would
  // duck the outro the handoff is supposed to land on.
  assert.ok(
    /refreshAutoPlaylistOnShowChange\(reason\)\s*\.catch\(/.test(body),
    'the rebuild must be fire-and-forget with its own trap, never awaited before the handoff',
  );
});

test('every refresh stamps what the file now holds', () => {
  assert.ok(
    scheduler.includes('autoPlaylistBuild.built(show)'),
    'refreshAutoPlaylistInner must stamp the show it built for, or every boundary rebuilds',
  );
  const inner = scheduler.slice(scheduler.indexOf('async function refreshAutoPlaylistInner'));
  const stamp = inner.indexOf('autoPlaylistBuild.built(show)');
  const write = inner.indexOf('writeFileAtomic(config.liquidsoap.autoPlaylist');
  assert.ok(write >= 0 && stamp > write, 'the stamp records a build that LANDED — it comes after the write');
});

// The four paths the report names. Each hands rollSessionNow its own reason, so
// the booth log distinguishes them — the reporter diagnosed this from the log.
test('all four show transitions run the boundary sequence', () => {
  assert.match(scheduler, /rollSessionNow\(\{ airHandoff: false, reason: 'scheduled boundary' \}\)/);
  assert.match(scheduler, /rollSessionNow\(\{ reason: 'takeover expired' \}\)/);
  assert.match(shows, /rollSessionNow\(\{ reason: 'takeover started' \}\)/);
  assert.match(shows, /rollSessionNow\(\{ reason: 'takeover cancelled' \}\)/);
});
