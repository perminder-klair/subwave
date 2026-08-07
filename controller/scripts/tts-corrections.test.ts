// Unit tests for the corrections normalizers (settings/vocab.ts) — the
// lenient load-path pass and the strict update()/PUT-settings pass. Both
// gained a `language` field (empty = "All languages") alongside the
// pre-existing `from`/`to`.
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
  await test('a row with no language key defaults to empty string', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: 'GHz', to: 'gigahertz' }]),
      [{ from: 'GHz', to: 'gigahertz', language: '' }],
    );
  });
  await test('a row with a language string keeps it, trimmed', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: 'Ke$ha', to: 'Kesha', language: '  German  ' }]),
      [{ from: 'Ke$ha', to: 'Kesha', language: 'German' }],
    );
  });
  await test('a non-string language becomes empty string, not dropped', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: 'x', to: 'y', language: 42 }]),
      [{ from: 'x', to: 'y', language: '' }],
    );
  });
  await test('language is truncated at 80 chars', () => {
    const longLang = 'a'.repeat(90);
    const result = normalizeTtsCorrections([{ from: 'x', to: 'y', language: longLang }]);
    assert.equal(result[0].language.length, 80);
  });

  console.log('validateTtsCorrectionsStrict (strict update() path):');
  await test('throws on non-array', () => {
    assert.throws(() => validateTtsCorrectionsStrict('nope'), /must be an array/);
  });
  await test('throws over the entry cap', () => {
    const rows = Array.from({ length: TTS_CORRECTIONS_LIMIT + 1 }, (_, i) => ({ from: `w${i}`, to: `x${i}` }));
    assert.throws(() => validateTtsCorrectionsStrict(rows), /at most/);
  });
  await test('a row with no language key strict-validates to empty string', () => {
    assert.deepEqual(
      validateTtsCorrectionsStrict([{ from: 'GHz', to: 'gigahertz' }]),
      [{ from: 'GHz', to: 'gigahertz', language: '' }],
    );
  });
  await test('a valid language rides through, trimmed', () => {
    assert.deepEqual(
      validateTtsCorrectionsStrict([{ from: 'x', to: 'y', language: '  Spanish  ' }]),
      [{ from: 'x', to: 'y', language: 'Spanish' }],
    );
  });
  await test('throws when language exceeds the cap', () => {
    const longLang = 'a'.repeat(81);
    assert.throws(
      () => validateTtsCorrectionsStrict([{ from: 'x', to: 'y', language: longLang }]),
      /language must be at most/,
    );
  });
  await test('a non-string language coerces via String(), does not throw for a short value', () => {
    assert.deepEqual(
      validateTtsCorrectionsStrict([{ from: 'x', to: 'y', language: 42 }]),
      [{ from: 'x', to: 'y', language: '42' }],
    );
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
}

main();
