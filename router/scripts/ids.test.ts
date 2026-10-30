// The id codec is the guarantee every store in the station leans on: published
// ids fit the /cover/:id guard, never contain '/', round-trip, and never take
// a shape controller/src/music/id-canonical.ts would rewrite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ID_LENGTH, prefixedCodec, rawCodec } from '../src/host/ids.js';

const COVER_GUARD = /^[\w-]{1,64}$/;

// A port of the shape test in controller/src/music/id-canonical.ts: the three
// lengths and formats it rewrites. A namespaced id must never match any.
const HEX32 = /^[0-9a-f]{32}$/;
function canonicalShape(s: string): boolean {
  if (s.length === 32 && HEX32.test(s)) return true;
  if (s.length === 22 && /^[0-9A-Za-z]{22}$/.test(s)) return true;
  if (s.length === 36 && s[8] === '-' && s[13] === '-' && s[18] === '-' && s[23] === '-') {
    return HEX32.test(s.slice(0, 8) + s.slice(9, 13) + s.slice(14, 18) + s.slice(19, 23) + s.slice(24));
  }
  return false;
}

test('safe native ids travel as <prefix>-<native> and round-trip', () => {
  const c = prefixedCodec('jf');
  const id = c.encode('a1b2c3d4e5f60718293a4b5c6d7e8f90')!;
  assert.equal(id, 'jf-a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(c.decode(id), 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.ok(c.owns(id));
});

test('unsafe native ids are packed, stay cover-safe, and round-trip', () => {
  const c = prefixedCodec('fold');
  for (const native of ['Music/Artist/01 Song.flac', 'a b', 'ümlaut', 'x/y', '../../etc/passwd', '42:7']) {
    const id = c.encode(native)!;
    assert.ok(id, native);
    assert.match(id, COVER_GUARD);
    assert.ok(!id.includes('/'));
    assert.equal(c.decode(id), native);
  }
});

test('ids that cannot fit in 64 characters are refused, not truncated', () => {
  const c = prefixedCodec('px');
  assert.equal(c.encode('x'.repeat(MAX_ID_LENGTH)), undefined);
  assert.ok(c.encode('x'.repeat(MAX_ID_LENGTH - 3)));
});

test('a codec does not own another prefix, or tampered payloads', () => {
  const jf = prefixedCodec('jf');
  const px = prefixedCodec('px');
  assert.equal(jf.decode(px.encode('123')!), undefined);
  assert.equal(jf.decode('jf-'), undefined);
  assert.equal(jf.decode('jf_!!!'), undefined);
  assert.equal(jf.decode('jf_YQ'), 'a');
  assert.equal(jf.decode('jf_YQ='), undefined, 'padding never appears in what we publish');
  assert.equal(jf.decode('plainid'), undefined);
});

test('no namespaced id takes a shape id-canonical.ts rewrites', () => {
  const prefixes = ['jf', 'px', 'nd', 'mock', 'abcdef', 'a1'];
  const natives = [
    'a'.repeat(32 - 3),
    'b'.repeat(22 - 3),
    '0123456789abcdef0123456789abcdef',
    '01234567-89ab-cdef-0123-456789abcdef',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, 19),
  ];
  for (const p of prefixes) {
    const c = prefixedCodec(p);
    for (const n of natives) {
      for (let cut = 0; cut <= n.length; cut++) {
        const id = c.encode(n.slice(0, cut) || 'x');
        if (id) assert.equal(canonicalShape(id), false, `${id} looks canonical`);
      }
    }
  }
});

test('invalid prefixes are rejected', () => {
  for (const bad of ['', 'a', 'Jf', '1a', 'toolong', 'a-b']) {
    assert.throws(() => prefixedCodec(bad), /invalid id prefix/);
  }
});

test('raw ids pass through unchanged, and an unsafe raw id is dropped rather than re-encoded', () => {
  const c = rawCodec();
  assert.equal(c.encode('2xV9pQ7rT1yU4iO0pAs3dF'), '2xV9pQ7rT1yU4iO0pAs3dF');
  assert.equal(c.decode('2xV9pQ7rT1yU4iO0pAs3dF'), '2xV9pQ7rT1yU4iO0pAs3dF');
  assert.equal(c.encode('has/slash'), undefined);
  assert.equal(c.encode('x'.repeat(65)), undefined);
});
