// music/prune-policy.ts — may the orphan reconcile DELETE?
//
// This gate stands in front of db.pruneMissingTracks, which drops a track's row,
// its text vector and its audio vector. Getting it wrong in either direction is
// expensive and quiet, so both directions are pinned here:
//
//   • too permissive → a walk that merely failed to READ something deletes live
//     tags. That is the bug this module exists for: Spotify's pool can come back
//     short from a 403, a rate-limit window or a maxTracks cap, and every
//     missing track then looks exactly like one the operator removed.
//   • too strict → Subsonic's reconcile silently stops working. A source that
//     reports nothing MUST still prune, which is why the facade's default is
//     `{ complete: true }` while this gate itself fails closed. That asymmetry
//     is deliberate and is the case most likely to be "tidied" away.
//
// Run: npm test -- prune-policy

import assert from 'node:assert/strict';
import test from 'node:test';
import { prunePermitted, pruneSkippedLine } from '../src/music/prune-policy.js';

const complete = { complete: true } as const;

test('a complete walk prunes — the wanted behaviour still works', () => {
  assert.deepEqual(prunePermitted({ walked: 4200, health: complete }), { ok: true });
});

test('an empty walk never prunes, whatever the source claims', () => {
  // The original guard, kept: a source that answered with nothing would
  // otherwise delete the entire library.
  for (const walked of [0, -1, Number.NaN]) {
    const d = prunePermitted({ walked, health: complete });
    assert.equal(d.ok, false, `walked=${walked}`);
    assert.match((d as any).reason, /no tracks/);
  }
});

test('a source that reports NOTHING prunes exactly as before — the Subsonic regression guard', () => {
  // music/source.ts answers `{ complete: true }` for any source without the
  // probe. If that default ever flips, every existing Navidrome station stops
  // reconciling and nothing says so.
  assert.deepEqual(prunePermitted({ walked: 1, health: { complete: true } }), { ok: true });
});

test('an incomplete walk blocks the prune and carries the source’s own reason', () => {
  const reason = 'Spotify is rate-limiting the station (412s left), so the catalogue walk may be short';
  const d = prunePermitted({ walked: 3800, health: { complete: false, reason } });
  assert.equal(d.ok, false);
  assert.equal((d as any).reason, reason, 'the operator-facing wording travels verbatim');
});

test('an incomplete walk with no reason still blocks', () => {
  const d = prunePermitted({ walked: 10, health: { complete: false } });
  assert.equal(d.ok, false);
  assert.match((d as any).reason, /incomplete/);
});

test('the skip line says nothing was deleted, in one wording for all three callers', () => {
  const line = pruneSkippedLine('the last Spotify pool build was incomplete');
  assert.match(line, /the last Spotify pool build was incomplete/);
  assert.match(line, /[Nn]othing was deleted/, 'the operator must not read a skip as a no-op success');
});
