// likes.load({ readOnly: true }) never writes likes.json.
//
// The tagger child process reads the like store to filter stars
// (music/seed-selector.ts). A normal load() on a store with no file mints a
// secret and flushes it; from a second process that is a second writer, and
// its `{ secret, likes: [] }` could land over likes the controller recorded in
// the meantime. Read-only skips the mint.
//
// Run: npm test -- likes-readonly-load

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-likes-readonly-'));
process.env.STATE_DIR = root;
const likes = await import('../src/broadcast/likes.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('a read-only load of a missing store leaves no file behind', async () => {
  await likes.load({ readOnly: true });
  assert.deepEqual(likes.operatorStarred([{ id: 'a' }], { enabled: true, influenceDj: false }), [{ id: 'a' }], 'no records: nothing filtered');
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(existsSync(join(root, 'likes.json')), false);
});
