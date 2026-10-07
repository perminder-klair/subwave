// Track blocks by name (#1827 review). A music-source switch re-keys every
// track, and a track block whose id the metadata matcher could not carry
// across stopped being enforced — the blocklist is absolute, so that was a
// track the operator banned airing again. The fallback is artist + title +
// album, all three present on both sides, through the blocklist's one fold
// (recency.nameKey): a title alone still never matches, since covers and
// "Intro" share titles.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'blocklist-track-name-'));
process.env.STATE_DIR = stateDir;
const blocklist = await import('../src/music/blocklist.js');
await blocklist.load();
after(() => rmSync(stateDir, { recursive: true, force: true }));

test('a track block holds on a new id when artist, title and album match', async () => {
  await blocklist.add({ type: 'track', id: 'old-1', name: 'Harbour Lights', artist: 'Neon Harbor', album: 'Night Drive' });
  assert.ok(blocklist.isBlocked({ id: 'jf-new', title: 'harbour  lights', artist: 'NEON HARBOR', album: 'Night Drive' }), 'case and spacing fold');
  assert.ok(blocklist.isBlocked({ id: 'px-9', title: 'Harbour Lights', artist: 'Neon Harbor', album: 'Night Drive' }));
  assert.equal(blocklist.matchOf({ id: 'px-9', title: 'Harbour Lights', artist: 'Neon Harbor', album: 'Night Drive' })?.id, 'old-1');
});

test('a different album, a cover or a bare title is not the blocked track', () => {
  assert.ok(!blocklist.isBlocked({ id: 'live', title: 'Harbour Lights', artist: 'Neon Harbor', album: 'Live at the Pier' }), 'the live version');
  assert.ok(!blocklist.isBlocked({ id: 'cover', title: 'Harbour Lights', artist: 'Someone Else', album: 'Night Drive' }), 'a cover');
  assert.ok(!blocklist.isBlocked({ id: 'bare', title: 'Harbour Lights' }));
  assert.ok(!blocklist.isBlocked({ id: 'no-album', title: 'Harbour Lights', artist: 'Neon Harbor' }), 'a row without an album never name-matches');
});

test('an entry without an album never name-matches', async () => {
  await blocklist.add({ type: 'track', id: 'old-2', name: 'Intro', artist: 'Many', album: null });
  assert.equal(blocklist.trackNameKey('Intro', 'Many', null), null);
  assert.ok(!blocklist.isBlocked({ id: 'x', title: 'Intro', artist: 'Many', album: 'Anything' }));
});

test('the track name is matched before broader name blocks, so its unblock clears it', async () => {
  await blocklist.add({ type: 'artist', id: 'ar-1', name: 'Neon Harbor' });
  assert.equal(blocklist.matchOf({ id: 'jf-new', title: 'Harbour Lights', artist: 'Neon Harbor', album: 'Night Drive' })?.type, 'track');
  assert.equal(blocklist.matchOf({ id: 'jf-other', title: 'Other Song', artist: 'Neon Harbor', album: 'Night Drive' })?.type, 'artist');
});
