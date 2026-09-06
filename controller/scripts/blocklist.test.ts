// Unit tests for the never-play blocklist (music/blocklist.ts): add/remove/
// dedupe round-trips through blocklist.json, and the isBlocked() matching
// contract — id-first (track/album/artist), exact normalised-name fallback for
// album/artist entries (library-db rows carry no Subsonic ids), and NO name
// matching for track entries (covers/re-recordings share titles).
//
// Also pins the admin-facing half: matchOf()'s precedence (the UI names the
// matched entry and unblocks exactly it, so a doubly-blocked row must always
// resolve the same way), annotate() keeping blocked rows instead of dropping
// them, and removeMany()'s single-rewrite bulk unblock.
// Run: `tsx scripts/blocklist.test.ts`.
//
// node:assert-via-tsx style, matching scripts/auto-pool.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time.
const stateDir = mkdtempSync(join(tmpdir(), 'blocklist-test-'));
process.env.STATE_DIR = stateDir;

const blocklist = await import('../src/music/blocklist.js');

try {
  await blocklist.load(); // no file yet — starts empty, must not throw
  assert.equal(blocklist.isEmpty(), true);
  assert.deepEqual(blocklist.list(), []);

  // Empty list blocks nothing and rejectBlocked is identity.
  assert.equal(blocklist.isBlocked({ id: 'x', artist: 'Anyone' }), false);
  const arr = [{ id: 'a' }, { id: 'b' }];
  assert.equal(blocklist.rejectBlocked(arr), arr);

  // ── track entries: id-only, never by name ─────────────────────────────────
  const t = await blocklist.add({ type: 'track', id: 'trk1', name: 'Song X', artist: 'Y' });
  assert.ok(t);
  assert.equal(blocklist.isBlocked({ id: 'trk1' }), true);
  assert.equal(blocklist.isBlocked({ id: 'other', title: 'Song X', artist: 'Y' }), false, 'track entries must not name-match');

  // Dedupe on (type, id).
  assert.equal(await blocklist.add({ type: 'track', id: 'trk1' }), null);
  assert.equal(blocklist.list().length, 1);

  // ── album entries: id, then (name, artist) pair ───────────────────────────
  await blocklist.add({ type: 'album', id: 'alb1', name: 'Greatest Hits', artist: 'Ambient Guy' });
  assert.equal(blocklist.isBlocked({ id: 's1', albumId: 'alb1' }), true);
  assert.equal(blocklist.isBlocked({ id: 's2', album: 'greatest  hits', artist: 'AMBIENT GUY' }), true, 'album name+artist fallback, normalised');
  assert.equal(blocklist.isBlocked({ id: 's3', album: 'Greatest Hits', artist: 'Someone Else' }), false, 'same album title by another artist stays playable');

  // ── artist entries: id, then normalised name ──────────────────────────────
  await blocklist.add({ type: 'artist', id: 'art1', name: 'Ambient Guy' });
  assert.equal(blocklist.isBlocked({ id: 's4', artistId: 'art1' }), true);
  assert.equal(blocklist.isBlocked({ id: 's5', artist: ' ambient guy ' }), true, 'artist name fallback, normalised');
  assert.equal(blocklist.isBlocked({ id: 's6', artist: 'Ambient Guy Trio' }), false, 'exact match only, no substring');

  // rejectBlocked drops only the blocked rows.
  const filtered = blocklist.rejectBlocked([{ id: 'trk1' }, { id: 'ok' }, { id: 's7', artist: 'Ambient Guy' }]);
  assert.deepEqual(filtered.map((s: any) => s.id), ['ok']);

  // ── persistence round-trip ────────────────────────────────────────────────
  const onDisk = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
  assert.equal(onDisk.entries.length, 3);
  assert.ok(onDisk.entries.every((e: any) => e.addedAt));

  // ── remove ────────────────────────────────────────────────────────────────
  assert.equal(await blocklist.remove('artist', 'art1'), true);
  assert.equal(await blocklist.remove('artist', 'art1'), false, 'second remove is a miss');
  assert.equal(blocklist.isBlocked({ id: 's5', artist: 'ambient guy' }), false, 'artist unblocked');
  assert.equal(blocklist.isBlocked({ id: 'trk1' }), true, 'other entries survive a remove');

  // ── matchOf: which entry, not just whether ────────────────────────────────
  // The admin UI names the matched entry and offers to remove exactly it, so
  // the precedence is a contract: ids before the name fallback, and the most
  // specific id first. A row that is blocked twice over must always resolve to
  // the same entry.
  await blocklist.add({ type: 'artist', id: 'art1', name: 'Ambient Guy' });
  const doubleBlocked = { id: 'trk1', artistId: 'art1', artist: 'Ambient Guy' };
  assert.equal(blocklist.matchOf(doubleBlocked)?.type, 'track', 'track id wins over an artist block on the same row');
  assert.equal(blocklist.matchOf({ id: 's8', albumId: 'alb1', artistId: 'art1' })?.type, 'album', 'album id wins over artist id');
  assert.equal(blocklist.matchOf({ id: 's9', artist: 'Ambient Guy' })?.id, 'art1');
  assert.equal(blocklist.matchOf({ id: 's10', artist: 'Nobody' }), null);
  assert.equal(blocklist.matchOf(null), null);

  // Album keys join two free-text fields. Without a separator no string can
  // contain, ("Live In", "Tokyo") and ("Live", "In Tokyo") would collide.
  await blocklist.add({ type: 'album', id: 'alb2', name: 'Live In', artist: 'Tokyo' });
  assert.equal(blocklist.isBlocked({ id: 's11', album: 'Live In', artist: 'Tokyo' }), true);
  assert.equal(blocklist.isBlocked({ id: 's12', album: 'Live', artist: 'In Tokyo' }), false, 'album/artist boundary must not smear');

  // refOf carries only what a row needs to render and unblock. The `kind`
  // discriminant separates id entries from rule refs on the same wire shape.
  assert.deepEqual(blocklist.refOf(blocklist.matchOf({ id: 'trk1' })!), { kind: 'entry', type: 'track', id: 'trk1', name: 'Song X' });

  // ── annotate: keep every row, stamp the blocking entry ────────────────────
  const annotated = blocklist.annotate([
    { id: 'trk1', title: 'Song X' },
    { id: 'clear', title: 'Something Else' },
    { id: 's13', artist: 'Ambient Guy' },
  ]);
  assert.equal(annotated.length, 3, 'annotate keeps blocked rows — the library browser shows the library');
  assert.equal(annotated[0].blockedBy?.type, 'track');
  assert.equal(annotated[1].blockedBy, null);
  assert.equal(annotated[2].blockedBy?.id, 'art1');
  assert.equal((annotated[0] as any).title, 'Song X', 'annotate preserves the row');

  // ── removeMany: one rewrite, honest about what was already gone ───────────
  const bulk = await blocklist.removeMany([
    { type: 'album', id: 'alb1' },
    { type: 'album', id: 'alb2' },
    { type: 'track', id: 'ghost' },
  ]);
  assert.equal(bulk.removed, 2);
  assert.deepEqual(bulk.missing, [{ type: 'track', id: 'ghost' }]);
  assert.equal(blocklist.isBlocked({ id: 's1', albumId: 'alb1' }), false);
  assert.equal(blocklist.isBlocked({ id: 'trk1' }), true, 'untargeted entries survive');
  const afterBulk = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
  assert.deepEqual(
    afterBulk.entries.map((e: any) => `${e.type}:${e.id}`).sort(),
    ['artist:art1', 'track:trk1'],
    'the persisted file matches memory after a bulk remove',
  );

  // A batch that hits nothing is a no-op, not an error.
  const none = await blocklist.removeMany([{ type: 'track', id: 'ghost' }]);
  assert.equal(none.removed, 0);
  assert.equal(none.missing.length, 1);

  // ── Rule entries (integration; pure matching pinned by ─────────────────────
  // scripts/blocklist-rules.test.ts). Non-seasonal, unscoped rules here so the
  // clock/show context can't flap the assertions.

  // The remaining id entries at this point: track trk1, artist art1.
  const rule = await blocklist.addRule({ label: 'No ambient tag', field: 'tag', values: ['ambient'] });
  assert.ok(rule.id && rule.addedAt);
  assert.equal(blocklist.isEmpty(), false);

  const tagged = { id: 'r-t1', title: 'Drift', artist: 'Someone', genres: ['Ambient'], moods: [] };
  assert.equal(blocklist.isBlocked(tagged), true, 'rule blocks by tag');
  assert.equal(blocklist.isBlocked({ id: 'r-t2', genres: ['Rock'], moods: [] }), false);

  // hitOf: entries FIRST (the UI unblocks exactly the entry), rules second.
  const ruleHit = blocklist.hitOf(tagged);
  assert.equal(ruleHit?.kind, 'rule');
  assert.equal(ruleHit?.kind === 'rule' && ruleHit.label, 'No ambient tag');
  assert.equal(ruleHit?.kind === 'rule' && ruleHit.seasonal, false);
  const entryHit = blocklist.hitOf({ id: 'trk1', genres: ['Ambient'] });
  assert.equal(entryHit?.kind, 'entry', 'an id entry outranks a matching rule');

  // rejectBlocked + annotate consult rules through the same hitOf.
  assert.deepEqual(blocklist.rejectBlocked([tagged, { id: 'ok', genres: ['Rock'] }]).map((s: any) => s.id), ['ok']);
  const ruleAnnotated = blocklist.annotate([tagged]);
  assert.equal(ruleAnnotated[0].blockedBy?.kind, 'rule');

  // Persistence round-trip: rules ride blocklist.json beside entries, and a
  // pre-rules file (no `rules` key) loads as zero rules (checked implicitly by
  // the initial load at the top of this file).
  const withRules = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
  assert.equal(withRules.rules.length, 1);
  assert.equal(withRules.rules[0].field, 'tag');

  // Update replaces the patchable fields, keeps id + addedAt.
  const updated = await blocklist.updateRule(rule.id, { label: 'No ambient tag', field: 'tag', values: ['ambient', 'drone'] });
  assert.deepEqual(updated?.values, ['ambient', 'drone']);
  assert.equal(updated?.addedAt, rule.addedAt);
  assert.equal(await blocklist.updateRule('ghost', { label: 'x', field: 'tag', values: ['x'] }), null);

  // Invalid payloads throw and change nothing.
  await assert.rejects(() => blocklist.addRule({ label: '', field: 'tag', values: ['x'] }), /label/);
  assert.equal(blocklist.listRules().length, 1);

  // Remove → empty again (id entries still present, so isEmpty stays false).
  assert.equal(await blocklist.removeRule(rule.id), true);
  assert.equal(await blocklist.removeRule(rule.id), false, 'second remove is a miss');
  assert.equal(blocklist.isBlocked(tagged), false, 'rule gone, track pickable again');

  // ── libraryPath (never-play-again's Navidrome-side exclusion marker) ──────
  // Absent from an ordinary block (the ONLY existing add() call sites never
  // pass it) — must default to null, not undefined, so it round-trips
  // predictably through JSON.
  await blocklist.add({ type: 'track', id: 'trk-plain', name: 'Plain Block' });
  assert.equal(blocklist.getEntry('track', 'trk-plain')?.libraryPath, null);

  // Set when the caller (never-play-again) supplies one.
  await blocklist.add({ type: 'track', id: 'trk-np', name: 'Never Play', libraryPath: 'Artist/Album/03 Track.flac' });
  assert.equal(blocklist.getEntry('track', 'trk-np')?.libraryPath, 'Artist/Album/03 Track.flac');

  // getEntry(): exact (type, id) lookup, unlike matchOf()'s song-shaped
  // precedence walk — a miss on a wrong type or an absent id is null, not a
  // throw, and it does not match by name the way the artist/album fallback
  // does.
  assert.equal(blocklist.getEntry('album', 'trk-np'), null, 'type must match too');
  assert.equal(blocklist.getEntry('track', 'nonexistent'), null);

  // Persists and reloads: libraryPath survives a fresh load() from disk.
  const withLibraryPath = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
  const npEntry = withLibraryPath.entries.find((e: any) => e.id === 'trk-np');
  assert.equal(npEntry.libraryPath, 'Artist/Album/03 Track.flac');
  const plainEntry = withLibraryPath.entries.find((e: any) => e.id === 'trk-plain');
  assert.equal(plainEntry.libraryPath, null);

  // ── setLibraryPath(): narrow update, never a remove()+add() round trip ────
  // (never-play-again's "upgrade an already-blocked entry" path — see
  // broadcast/never-play-again.ts.)
  const beforeUpgrade = blocklist.getEntry('track', 'trk-plain')!;
  const upgraded = await blocklist.setLibraryPath('track', 'trk-plain', 'Plain/Block/Track.mp3');
  assert.equal(upgraded?.libraryPath, 'Plain/Block/Track.mp3');
  assert.equal(upgraded?.addedAt, beforeUpgrade.addedAt, 'addedAt is untouched');
  assert.equal(upgraded?.name, beforeUpgrade.name, 'name is untouched');
  assert.equal(upgraded, blocklist.getEntry('track', 'trk-plain'), 'mutates and returns the SAME entry object, not a replacement');
  assert.equal(blocklist.isBlocked({ id: 'trk-plain' }), true, 'the track is still (and was always) blocked throughout the update — no remove()+add() gap');

  // Persists.
  const afterUpgrade = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
  assert.equal(afterUpgrade.entries.find((e: any) => e.id === 'trk-plain').libraryPath, 'Plain/Block/Track.mp3');

  // Setting the SAME value again is a no-op — same object, same addedAt, and
  // (can't directly observe "no write happened" here, but the value is
  // unchanged either way) idempotent.
  const noopUpgrade = await blocklist.setLibraryPath('track', 'trk-plain', 'Plain/Block/Track.mp3');
  assert.equal(noopUpgrade, upgraded);

  // Clearing back to null is a normal update too, not a special case.
  assert.equal((await blocklist.setLibraryPath('track', 'trk-plain', null))?.libraryPath, null);

  // Unknown (type, id) → null, not a throw.
  assert.equal(await blocklist.setLibraryPath('track', 'nonexistent', 'x'), null);
  assert.equal(await blocklist.setLibraryPath('album', 'trk-np', 'x'), null, 'type must match too, same as getEntry()');

  console.log('blocklist.test.ts: all assertions passed');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
