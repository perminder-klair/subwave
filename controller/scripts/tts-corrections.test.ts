// Unit tests for the corrections normalizers (settings/vocab.ts) — the
// lenient load-path pass and the strict update()/PUT-settings pass.
// Run: `npm test -- tts-corrections` (tsx scripts/tts-corrections.test.ts).

import assert from 'node:assert/strict';
import {
  normalizeTtsCorrections, validateTtsCorrectionsStrict, TTS_CORRECTIONS_LIMIT,
} from '../src/settings/vocab.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('normalizeTtsCorrections (lenient load path):');
  await test('non-array input returns an empty list', () => {
    assert.deepEqual(normalizeTtsCorrections(undefined), []);
    assert.deepEqual(normalizeTtsCorrections(null), []);
    assert.deepEqual(normalizeTtsCorrections('nope'), []);
  });
  await test('a well-formed row passes through, trimmed', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: '  GHz  ', to: '  gigahertz  ' }]),
      [{ from: 'GHz', to: 'gigahertz' }],
    );
  });
  await test('a row with a blank/missing `from` is dropped', () => {
    assert.deepEqual(normalizeTtsCorrections([{ from: '', to: 'x' }]), []);
    assert.deepEqual(normalizeTtsCorrections([{ to: 'x' }]), []);
    assert.deepEqual(normalizeTtsCorrections([{ from: '   ', to: 'x' }]), []);
  });
  await test('non-string `to` becomes an empty string, not dropped', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: 'literally', to: 42 }]),
      [{ from: 'literally', to: '' }],
    );
  });
  await test('malformed rows (non-object, null) are skipped, not thrown', () => {
    assert.deepEqual(
      normalizeTtsCorrections([null, 'x', 42, { from: 'ok', to: 'yes' }]),
      [{ from: 'ok', to: 'yes' }],
    );
  });
  await test('`from` is truncated at 80 chars, `to` at 160', () => {
    const longFrom = 'a'.repeat(90);
    const longTo = 'b'.repeat(200);
    const result = normalizeTtsCorrections([{ from: longFrom, to: longTo }]);
    assert.equal(result[0].from.length, 80);
    assert.equal(result[0].to.length, 160);
  });
  await test('capped at 100 rows, the first 100 survive', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ from: `w${i}`, to: `x${i}` }));
    const result = normalizeTtsCorrections(rows);
    assert.equal(result.length, 100);
    assert.equal(result[0].from, 'w0');
    assert.equal(result[99].from, 'w99');
  });

  console.log('validateTtsCorrectionsStrict (strict update() path):');
  await test('throws on non-array', () => {
    assert.throws(() => validateTtsCorrectionsStrict('nope'), /must be an array/);
  });
  await test('throws over the entry cap', () => {
    const rows = Array.from({ length: TTS_CORRECTIONS_LIMIT + 1 }, (_, i) => ({ from: `w${i}`, to: `x${i}` }));
    assert.throws(() => validateTtsCorrectionsStrict(rows), /at most/);
  });
  await test('a well-formed row validates, trimmed', () => {
    assert.deepEqual(
      validateTtsCorrectionsStrict([{ from: '  GHz  ', to: '  gigahertz  ' }]),
      [{ from: 'GHz', to: 'gigahertz' }],
    );
  });
  await test('throws when `from` is empty or exceeds the cap', () => {
    assert.throws(() => validateTtsCorrectionsStrict([{ from: '', to: 'x' }]), /from must be/);
    assert.throws(
      () => validateTtsCorrectionsStrict([{ from: 'a'.repeat(81), to: 'x' }]),
      /from must be/,
    );
  });
  await test('throws when `to` exceeds the cap', () => {
    assert.throws(
      () => validateTtsCorrectionsStrict([{ from: 'x', to: 'b'.repeat(161) }]),
      /to must be at most/,
    );
  });
  await test('throws when a row is not an object', () => {
    assert.throws(() => validateTtsCorrectionsStrict([null]), /must be an object/);
    assert.throws(() => validateTtsCorrectionsStrict(['x']), /must be an object/);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
}

main();
