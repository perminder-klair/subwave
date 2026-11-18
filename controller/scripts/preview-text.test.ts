// Unit tests for the localized "Play sample" sentence lookup
// (audio/preview-text.ts). The persona `language` field is free operator
// text, so the pins cover the three key shapes — English name, native name
// (with diacritics), ISO code — plus the fallback contract: unknown or empty
// language returns null so the caller keeps the English default.
// Run: `npm test -- preview-text`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { localizedPreviewText } from '../src/audio/preview-text.js';

test('English language name matches', () => {
  assert.equal(localizedPreviewText('Turkish'), 'SUB/WAVE dinliyorsunuz. Bu bir ses önizlemesidir.');
});
test('native name with diacritics matches (Türkçe → turkce)', () => {
  assert.equal(localizedPreviewText('Türkçe'), localizedPreviewText('Turkish'));
});
test('ISO 639-1 code matches', () => {
  assert.equal(localizedPreviewText('tr'), localizedPreviewText('Turkish'));
});
test('case and surrounding whitespace are ignored', () => {
  assert.equal(localizedPreviewText('  SPANISH '), localizedPreviewText('es'));
});
test('non-Latin native names match (日本語, हिन्दी)', () => {
  assert.equal(localizedPreviewText('日本語'), localizedPreviewText('Japanese'));
  assert.equal(localizedPreviewText('हिन्दी'), localizedPreviewText('hi'));
});

test('Slovak matches by name, native name and ISO code', () => {
  const sample = 'Počúvate SUB/WAVE. Toto je ukážka hlasu.';
  assert.equal(localizedPreviewText('Slovak'), sample);
  assert.equal(localizedPreviewText('slovenčina'), sample);
  assert.equal(localizedPreviewText('sk'), sample);
});
test('Slovak is not the English default and not the Czech sample', () => {
  assert.notEqual(localizedPreviewText('Slovak'), localizedPreviewText('English'));
  assert.notEqual(localizedPreviewText('Slovak'), localizedPreviewText('Czech'));
});

test('empty / undefined → null (caller uses the English default)', () => {
  assert.equal(localizedPreviewText(''), null);
  assert.equal(localizedPreviewText(undefined), null);
});
test('unrecognized language → null', () => {
  assert.equal(localizedPreviewText('Klingon'), null);
});
test('explicit English still matches instead of reading as unknown', () => {
  assert.equal(localizedPreviewText('English'), "You're listening to SUB/WAVE. This is a voice preview.");
});

test('every sample keeps the station name untranslated', () => {
  for (const lang of ['Spanish', 'French', 'German', 'Japanese', 'Chinese', 'Arabic', 'Hebrew', 'Hindi', 'Punjabi', 'Slovak']) {
    const sample = localizedPreviewText(lang);
    assert.ok(sample && sample.includes('SUB/WAVE'), `${lang} sample must mention SUB/WAVE verbatim`);
  }
});
