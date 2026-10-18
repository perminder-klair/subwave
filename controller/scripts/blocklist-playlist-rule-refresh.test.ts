// A playlist rule's member set is resolved through subsonic.getPlaylist, whose
// default return runs through blocklist.rejectBlocked — the filter that consults
// that very set. Read filtered, the second refresh returned the playlist minus
// its own members (0 tracks, rule inert), and the filter's re-entry into
// activeCompiledRules() started a nested refresh that discarded the awaited one.
// Drives the real fetch -> filter chain.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'blocklist-playlist-rule-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://rule-library.invalid';
const blocklist = await import('../src/music/blocklist.js');
const { clearPlaylistCache } = await import('../src/music/show-playlist.js');

const members = [{ id: 'e1', title: 'One', artist: 'A' }, { id: 'e2', title: 'Two', artist: 'B' }];
const realFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'rule-library.invalid', 'no live service calls');
  assert.equal(url.pathname.split('/').at(-1), 'getPlaylist');
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', playlist: { entry: members } } });
};
after(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

test('a playlist rule keeps its members across refreshes', async () => {
  await blocklist.load();
  await blocklist.addRule({ label: 'Explicit', field: 'playlist', values: ['pl-explicit'], season: null, showIds: [] });
  await blocklist.refreshPlaylistMembers();
  assert.equal(blocklist.isBlocked({ id: 'e1' }), true, 'first resolve blocks a member');

  clearPlaylistCache(); // the memo TTL has lapsed; the next refresh refetches
  await blocklist.refreshPlaylistMembers();
  assert.equal(blocklist.isBlocked({ id: 'e1' }), true, 'a refetch must not drop the rule\'s own members');
  assert.equal(blocklist.isBlocked({ id: 'other' }), false);
  assert.equal(blocklist.rulesWithStats([{ id: 'e1' }, { id: 'e2' }, { id: 'other' }])[0]!.matchCount, 2);
});
