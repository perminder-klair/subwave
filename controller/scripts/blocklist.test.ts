// The never-play blocklist (music/blocklist.ts): persistence round-trips and
// the isBlocked() matching contract — id first, exact normalised-name fallback
// for album/artist entries (library-db rows carry no Subsonic ids), and NO
// name matching for track entries, since covers share titles.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time.
const stateDir = mkdtempSync(join(tmpdir(), 'blocklist-test-'));
process.env.STATE_DIR = stateDir;

const blocklist = await import('../src/music/blocklist.js');

try {
  await blocklist.load(); // no file yet: starts empty, must not throw
  assert.equal(blocklist.isEmpty(), true);
  assert.deepEqual(blocklist.list(), []);

  // Empty list blocks nothing and rejectBlocked is identity.
  assert.equal(blocklist.isBlocked({ id: 'x', artist: 'Anyone' }), false);
  const arr = [{ id: 'a' }, { id: 'b' }];
  assert.equal(blocklist.rejectBlocked(arr), arr);

  // Track entries: id only, never by name.
  const t = await blocklist.add({ type: 'track', id: 'trk1', name: 'Song X', artist: 'Y' });
  assert.ok(t);
  assert.equal(blocklist.isBlocked({ id: 'trk1' }), true);
  assert.equal(blocklist.isBlocked({ id: 'other', title: 'Song X', artist: 'Y' }), false, 'track entries must not name-match');

  // Dedupe on (type, id).
  assert.equal(await blocklist.add({ type: 'track', id: 'trk1' }), null);
  assert.equal(blocklist.list().length, 1);

  // Album entries: id, then the (name, artist) pair.
  await blocklist.add({ type: 'album', id: 'alb1', name: 'Greatest Hits', artist: 'Ambient Guy' });
  assert.equal(blocklist.isBlocked({ id: 's1', albumId: 'alb1' }), true);
  assert.equal(blocklist.isBlocked({ id: 's2', album: 'greatest  hits', artist: 'AMBIENT GUY' }), true, 'album name+artist fallback, normalised');
  assert.equal(blocklist.isBlocked({ id: 's3', album: 'Greatest Hits', artist: 'Someone Else' }), false, 'same album title by another artist stays playable');

  // Artist entries: id, then normalised name.
  await blocklist.add({ type: 'artist', id: 'art1', name: 'Ambient Guy' });
  assert.equal(blocklist.isBlocked({ id: 's4', artistId: 'art1' }), true);
  assert.equal(blocklist.isBlocked({ id: 's5', artist: ' ambient guy ' }), true, 'artist name fallback, normalised');
  assert.equal(blocklist.isBlocked({ id: 's6', artist: 'Ambient Guy Trio' }), false, 'exact match only, no substring');

  // rejectBlocked drops only the blocked rows.
  const filtered = blocklist.rejectBlocked([{ id: 'trk1' }, { id: 'ok' }, { id: 's7', artist: 'Ambient Guy' }]);
  assert.deepEqual(filtered.map((s: any) => s.id), ['ok']);

  const onDisk = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
  assert.equal(onDisk.entries.length, 3);
  assert.ok(onDisk.entries.every((e: any) => e.addedAt));

  assert.equal(await blocklist.remove('artist', 'art1'), true);
  assert.equal(await blocklist.remove('artist', 'art1'), false, 'second remove is a miss');
  assert.equal(blocklist.isBlocked({ id: 's5', artist: 'ambient guy' }), false, 'artist unblocked');
  assert.equal(blocklist.isBlocked({ id: 'trk1' }), true, 'other entries survive a remove');

  // matchOf precedence is a contract, since the UI unblocks exactly the entry
  // it names: ids before the name fallback, most specific id first.
  await blocklist.add({ type: 'artist', id: 'art1', name: 'Ambient Guy' });
  const doubleBlocked = { id: 'trk1', artistId: 'art1', artist: 'Ambient Guy' };
  assert.equal(blocklist.matchOf(doubleBlocked)?.type, 'track', 'track id wins over an artist block on the same row');
  assert.equal(blocklist.matchOf({ id: 's8', albumId: 'alb1', artistId: 'art1' })?.type, 'album', 'album id wins over artist id');
  assert.equal(blocklist.matchOf({ id: 's9', artist: 'Ambient Guy' })?.id, 'art1');
  assert.equal(blocklist.matchOf({ id: 's10', artist: 'Nobody' }), null);
  assert.equal(blocklist.matchOf(null), null);

  // Album keys join two free-text fields, so without an uncontainable
  // separator ("Live In", "Tokyo") and ("Live", "In Tokyo") collide.
  await blocklist.add({ type: 'album', id: 'alb2', name: 'Live In', artist: 'Tokyo' });
  assert.equal(blocklist.isBlocked({ id: 's11', album: 'Live In', artist: 'Tokyo' }), true);
  assert.equal(blocklist.isBlocked({ id: 's12', album: 'Live', artist: 'In Tokyo' }), false, 'album/artist boundary must not smear');

  // refOf carries only what a row needs to render and unblock; `kind`
  // separates id entries from rule refs on the same wire shape.
  assert.deepEqual(blocklist.refOf(blocklist.matchOf({ id: 'trk1' })!), { kind: 'entry', type: 'track', id: 'trk1', name: 'Song X' });

  // annotate keeps every row and stamps the blocking entry.
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

  // removeMany: one rewrite, honest about what was already gone.
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

  // Rule entries (pure matching lives in blocklist-rules.test.ts). Non-seasonal
  // and unscoped so the clock/show context can't flap the assertions. Remaining
  // id entries here: track trk1, artist art1.
  const rule = await blocklist.addRule({ label: 'No ambient tag', field: 'tag', values: ['ambient'] });
  assert.ok(rule.id && rule.addedAt);
  assert.equal(blocklist.isEmpty(), false);

  const tagged = { id: 'r-t1', title: 'Drift', artist: 'Someone', genres: ['Ambient'], moods: [] };
  assert.equal(blocklist.isBlocked(tagged), true, 'rule blocks by tag');
  assert.equal(blocklist.isBlocked({ id: 'r-t2', genres: ['Rock'], moods: [] }), false);

  // hitOf: entries first, rules second.
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

  // Rules ride blocklist.json beside entries; a pre-rules file loads as zero.
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

  // Remove: id entries still present, so isEmpty stays false.
  assert.equal(await blocklist.removeRule(rule.id), true);
  assert.equal(await blocklist.removeRule(rule.id), false, 'second remove is a miss');
  assert.equal(blocklist.isBlocked(tagged), false, 'rule gone, track pickable again');

  console.log('blocklist.test.ts: all assertions passed');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
