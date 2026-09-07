// Golden-vector tests for music/id-canonical.ts — the byte-for-byte port of
// Navidrome PR #5824's canonicalID() shape transform (db/migrations/
// 20260720015443_uniform_canonical_ids.go). Navidrome's upcoming release
// rewrites almost every id in its DB through this transform; the adoption path
// (library-db/id-adoption.ts) replays it against our stored ids to carry
// tags/analysis/vectors across the rotation instead of pruning them.
//
// Every vector below is lifted verbatim from the PR's own test suites
// (model/id/id_test.go, db/migrations/id_canonical_test.go), so a drift from
// upstream fails HERE, not silently at adoption time. The alphabet is Go
// big.Int's base-62 digit set — 0-9, a-z, A-Z, lowercase BEFORE uppercase —
// which is NOT the common base62 ordering; the vectors pin it.
//
// Run: `tsx scripts/id-canonical.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  const { canonicalId, encode128 } = await import('../src/music/id-canonical.js');

  console.log('encode128 (Go id.Encode golden values):');

  await test('all-zero bytes encode as 22 zero digits', () => {
    assert.equal(encode128(new Uint8Array(16)), '0000000000000000000000');
  });

  await test('all-0xff bytes (2^128 - 1) match the Go golden value', () => {
    assert.equal(encode128(new Uint8Array(16).fill(0xff)), '7N42dgm5tFLK9N8MT7fHC7');
  });

  await test('the 32-hex round-trip vector matches', () => {
    const b = Uint8Array.from(Buffer.from('e3b7fc2ae9447bbec37a13bf916e3cf6', 'hex'));
    assert.equal(encode128(b), '6VHl3uR4kss6sUPKA8Cwnk');
  });

  console.log('canonicalId (migration canonicalID golden values):');

  await test('a 22-char id that fits 128 bits is kept (hash family)', () => {
    assert.equal(canonicalId('5cLJPkLA5DK2BADhoeotPk'), '5cLJPkLA5DK2BADhoeotPk');
  });

  await test('an overflowing 22-char random id is remapped via md5 of the string', () => {
    assert.equal(canonicalId('zzzzzzzzzzzzzzzzzzzzzz'), '3LyqmwQBm5IRqlVjNYASwb');
  });

  await test('a legacy 32-hex id is re-encoded value-preserving', () => {
    assert.equal(canonicalId('e3b7fc2ae9447bbec37a13bf916e3cf6'), '6VHl3uR4kss6sUPKA8Cwnk');
  });

  await test('an old playlist uuid is re-encoded value-preserving', () => {
    assert.equal(canonicalId('f47ac10b-58cc-4372-a567-0e02b2c3d479'), '7rke2SAWaicSeSYzkhww6R');
  });

  await test('uppercase hex re-encodes to the same value as lowercase', () => {
    // Go's hex.DecodeString is case-insensitive; the port must be too.
    assert.equal(canonicalId('E3B7FC2AE9447BBEC37A13BF916E3CF6'), '6VHl3uR4kss6sUPKA8Cwnk');
  });

  console.log('canonicalId pass-throughs (unrecognized shapes untouched):');

  const passThrough: Array<[string, string]> = [
    ['empty string', ''],
    ['10-char share id', 'aB3xY9kQz1'],
    ['16-char truncated Finamp id', '0123456789abcdef'],
    ['22 chars with non-base62 char', '!!!!!!!!!!!!!!!!!!!!!!'],
    ['32 chars non-hex', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['36 chars without uuid dashes', '000000000000000000000000000000000000'],
  ];
  for (const [label, s] of passThrough) {
    await test(`${label} passes through`, () => {
      assert.equal(canonicalId(s), s);
    });
  }

  await test('a 36-char id with dashes in the wrong spots passes through', () => {
    assert.equal(
      canonicalId('f47ac10b58-cc-4372-a567-0e02b2c3d479'),
      'f47ac10b58-cc-4372-a567-0e02b2c3d479',
    );
  });

  console.log('idempotence (safe to re-apply on an already-migrated store):');

  const shapes = [
    '5cLJPkLA5DK2BADhoeotPk',
    'zzzzzzzzzzzzzzzzzzzzzz',
    'e3b7fc2ae9447bbec37a13bf916e3cf6',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    '',
    'aB3xY9kQz1',
    '!!!!!!!!!!!!!!!!!!!!!!',
  ];
  for (const s of shapes) {
    await test(`canonicalId is a fixed point on canonicalId(${JSON.stringify(s)})`, () => {
      const once = canonicalId(s);
      assert.equal(canonicalId(once), once);
    });
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall id-canonical tests passed');
}

await main();
