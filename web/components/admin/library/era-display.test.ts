import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTrackLength, shortFolder, yearTargets } from './era-display';

test('track length reads as m:ss, unknown as nothing', () => {
  assert.equal(formatTrackLength(220), '3:40');
  assert.equal(formatTrackLength(434.4), '7:14');
  assert.equal(formatTrackLength(59.6), '1:00');
  assert.equal(formatTrackLength(null), '');
  assert.equal(formatTrackLength(0), '');
});

test('a folder is shortened to its last segments', () => {
  assert.equal(shortFolder('/music/DISCOTHEQUE/PLAYLISTS/Rock'), '…/PLAYLISTS/Rock');
  assert.equal(shortFolder('/music/Rock'), 'music/Rock');
  assert.equal(shortFolder('/a/b/c', 1), '…/c');
  assert.equal(shortFolder(null), '');
});

test('a year goes to the entry and every copy folded under it', () => {
  assert.deepEqual(yearTargets({ id: 'a', copies: [{ id: 'b' }, { id: 'c' }] }), ['a', 'b', 'c']);
  assert.deepEqual(yearTargets({ id: 'a' }), ['a']);
  assert.deepEqual(yearTargets({ id: 'a', copies: [{ id: 'a' }] }), ['a']);
});
