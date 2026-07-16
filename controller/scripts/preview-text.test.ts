// Unit tests for the localized "Play sample" sentence lookup
// (audio/preview-text.ts). The persona `language` field is free operator
// text, so the pins cover the three key shapes — English name, native name
// (with diacritics), ISO code — plus the fallback contract: unknown or empty
// language returns null so the caller keeps the English default.
// Run: `npm test -- preview-text` (tsx scripts/preview-text.test.ts).

import assert from 'node:assert/strict';
import { localizedPreviewText } from '../src/audio/preview-text.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('match shapes:');
  await test('English language name matches', () => {
    assert.equal(localizedPreviewText('Turkish'), 'SUB/WAVE dinliyorsunuz. Bu bir ses önizlemesidir.');
  });
  await test('native name with diacritics matches (Türkçe → turkce)', () => {
    assert.equal(localizedPreviewText('Türkçe'), localizedPreviewText('Turkish'));
  });
  await test('ISO 639-1 code matches', () => {
    assert.equal(localizedPreviewText('tr'), localizedPreviewText('Turkish'));
  });
  await test('case and surrounding whitespace are ignored', () => {
    assert.equal(localizedPreviewText('  SPANISH '), localizedPreviewText('es'));
  });
  await test('non-Latin native names match (日本語, हिन्दी)', () => {
    assert.equal(localizedPreviewText('日本語'), localizedPreviewText('Japanese'));
    assert.equal(localizedPreviewText('हिन्दी'), localizedPreviewText('hi'));
  });

  console.log('fallback contract:');
  await test('empty / undefined → null (caller uses the English default)', () => {
    assert.equal(localizedPreviewText(''), null);
    assert.equal(localizedPreviewText(undefined), null);
  });
  await test('unrecognized language → null', () => {
    assert.equal(localizedPreviewText('Klingon'), null);
  });
  await test('explicit English still matches instead of reading as unknown', () => {
    assert.equal(localizedPreviewText('English'), "You're listening to SUB/WAVE. This is a voice preview.");
  });

  console.log('table invariants:');
  await test('every sample keeps the station name untranslated', () => {
    for (const lang of ['Spanish', 'French', 'German', 'Japanese', 'Chinese', 'Arabic', 'Hebrew', 'Hindi', 'Punjabi']) {
      const sample = localizedPreviewText(lang);
      assert.ok(sample && sample.includes('SUB/WAVE'), `${lang} sample must mention SUB/WAVE verbatim`);
    }
  });

  process.exit(failures ? 1 : 0);
}

main();
