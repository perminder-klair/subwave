// The Music server tile's link: only an absolute http(s) address from
// Settings → Navidrome, with any credentials and query dropped.
// Run: npm test -- music-server-link
import test from 'node:test';
import assert from 'node:assert/strict';
import { musicServerLink } from './music-server-link';

test('an http(s) address becomes the link', () => {
  assert.equal(musicServerLink('http://navidrome.example:4533'), 'http://navidrome.example:4533/');
  assert.equal(musicServerLink(' https://music.example/navidrome/ '), 'https://music.example/navidrome/');
});

test('credentials and a query never reach the link', () => {
  assert.equal(musicServerLink('https://admin:secret@music.example/?u=admin&p=secret#x'), 'https://music.example/');
});

test('anything else leaves the tile unlinked', () => {
  for (const bad of [null, undefined, '', '   ', 'navidrome:4533', 'music.example', 'javascript:alert(1)', 'ftp://music.example']) {
    assert.equal(musicServerLink(bad), null, String(bad));
  }
});
