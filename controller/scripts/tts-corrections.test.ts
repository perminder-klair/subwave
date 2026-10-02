// Unit tests for the corrections normalizers (settings/vocab.ts) — the
// lenient load-path pass and the strict update()/PUT-settings pass.
// Run: `npm test -- tts-corrections`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeTtsCorrections, validateTtsCorrectionsStrict, TTS_CORRECTIONS_LIMIT,
} from '../src/settings/vocab.js';

// --- normalizeTtsCorrections (lenient load path) ---------------------------

test('normalize: non-array input returns an empty list', () => {
  assert.deepEqual(normalizeTtsCorrections(undefined), []);
  assert.deepEqual(normalizeTtsCorrections(null), []);
  assert.deepEqual(normalizeTtsCorrections('nope'), []);
});

test('normalize: a well-formed row passes through, trimmed', () => {
  assert.deepEqual(
    normalizeTtsCorrections([{ from: '  GHz  ', to: '  gigahertz  ' }]),
    [{ from: 'GHz', to: 'gigahertz' }],
  );
});

test('normalize: a row with a blank/missing `from` is dropped', () => {
  assert.deepEqual(normalizeTtsCorrections([{ from: '', to: 'x' }]), []);
  assert.deepEqual(normalizeTtsCorrections([{ to: 'x' }]), []);
  assert.deepEqual(normalizeTtsCorrections([{ from: '   ', to: 'x' }]), []);
});

test('normalize: non-string `to` becomes an empty string, not dropped', () => {
  assert.deepEqual(
    normalizeTtsCorrections([{ from: 'literally', to: 42 }]),
    [{ from: 'literally', to: '' }],
  );
});

test('normalize: malformed rows (non-object, null) are skipped, not thrown', () => {
  assert.deepEqual(
    normalizeTtsCorrections([null, 'x', 42, { from: 'ok', to: 'yes' }]),
    [{ from: 'ok', to: 'yes' }],
  );
});

test('normalize: `from` is truncated at 80 chars, `to` at 160', () => {
  const result = normalizeTtsCorrections([{ from: 'a'.repeat(90), to: 'b'.repeat(200) }]);
  assert.equal(result[0].from.length, 80);
  assert.equal(result[0].to.length, 160);
});

test('normalize: capped at the entry limit, the first rows survive', () => {
  const rows = Array.from(
    { length: TTS_CORRECTIONS_LIMIT + 20 },
    (_, i) => ({ from: `w${i}`, to: `x${i}` }),
  );
  const result = normalizeTtsCorrections(rows);
  assert.equal(result.length, TTS_CORRECTIONS_LIMIT);
  assert.equal(result[0].from, 'w0');
  assert.equal(result[TTS_CORRECTIONS_LIMIT - 1].from, `w${TTS_CORRECTIONS_LIMIT - 1}`);
});

// --- validateTtsCorrectionsStrict (strict update() path) -------------------

test('strict: accepts all 500 corrections, including rows beyond the old cap', () => {
  assert.equal(TTS_CORRECTIONS_LIMIT, 500);
  const rows = Array.from({ length: 500 }, (_, i) => ({ from: `w${i}`, to: `x${i}` }));
  assert.deepEqual(validateTtsCorrectionsStrict(rows), rows);
  assert.deepEqual(normalizeTtsCorrections(rows), rows);
  assert.throws(
    () => validateTtsCorrectionsStrict([...rows, { from: 'overflow', to: 'no' }]),
    /tts\.corrections must be at most 500 entries/,
  );
});

test('strict: throws on non-array', () => {
  assert.throws(() => validateTtsCorrectionsStrict('nope'), /must be an array/);
});

test('strict: throws over the entry cap', () => {
  const rows = Array.from(
    { length: TTS_CORRECTIONS_LIMIT + 1 },
    (_, i) => ({ from: `w${i}`, to: `x${i}` }),
  );
  assert.throws(() => validateTtsCorrectionsStrict(rows), /at most/);
});

test('strict: a well-formed row validates, trimmed', () => {
  assert.deepEqual(
    validateTtsCorrectionsStrict([{ from: '  GHz  ', to: '  gigahertz  ' }]),
    [{ from: 'GHz', to: 'gigahertz' }],
  );
});

test('strict: throws when `from` is empty or exceeds the cap', () => {
  assert.throws(() => validateTtsCorrectionsStrict([{ from: '', to: 'x' }]), /from must be/);
  assert.throws(
    () => validateTtsCorrectionsStrict([{ from: 'a'.repeat(81), to: 'x' }]),
    /from must be/,
  );
});

test('strict: throws when `to` exceeds the cap', () => {
  assert.throws(
    () => validateTtsCorrectionsStrict([{ from: 'x', to: 'b'.repeat(161) }]),
    /to must be at most/,
  );
});

test('strict: throws when a row is not an object', () => {
  assert.throws(() => validateTtsCorrectionsStrict([null]), /must be an object/);
  assert.throws(() => validateTtsCorrectionsStrict(['x']), /must be an object/);
});
