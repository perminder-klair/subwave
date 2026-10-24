import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalLanguage, resolveLanguageCode } from '../src/music/request-normalize.js';
import { detectLocalLanguage, languageFromLyricsTag, sampleLyrics } from '../src/music/language-tagger.js';

test('canonical language storage keeps regional languages distinct', () => {
  assert.equal(canonicalLanguage('Hindi'), 'hin');
  assert.equal(canonicalLanguage('Punjabi'), 'pan');
  assert.equal(canonicalLanguage('Haryanvi'), 'bgc');
  assert.equal(canonicalLanguage('bho'), 'bho');
  assert.equal(canonicalLanguage('Maithili'), 'mai');
  assert.equal(canonicalLanguage('Konkani'), 'kok');
  assert.equal(canonicalLanguage('sco'), 'sco');
  assert.equal(canonicalLanguage('Scots'), 'sco');
  assert.equal(canonicalLanguage('Zulu'), 'zul');
  assert.equal(canonicalLanguage('not-a-language'), undefined);
  assert.equal(resolveLanguageCode('Scots'), 'sco');
});

test('script evidence detects Punjabi without using artist or genre metadata', () => {
  const result = detectLocalLanguage('ਇੱਕ ਪਿਆਰ ਦੀ ਗੱਲ ਹੈ ਇਹ ਦਿਲ ਦੀ ਆਵਾਜ਼ ਹੈ ਤੂੰ ਮੇਰੇ ਨਾਲ ਰਹੀਂ ਹਰ ਪਲ ਮੇਰੇ ਕੋਲ ਰਹੀਂ ਸੱਜਣਾ')!;
  assert.equal(result.primaryLanguage, 'pan');
  assert.equal(result.mode, 'single');
  assert.equal(result.confidence, 'review', 'script hints never become an automatic global language decision');
  assert.equal(detectLocalLanguage(`${'मैं तेरे साथ हूँ '.repeat(8)}${'and I am here with you '.repeat(2)}`)?.confidence, 'review');
});

test('short or ambiguous excerpts remain unresolved for AI review', () => {
  assert.equal(detectLocalLanguage('love you'), null);
  assert.equal(sampleLyrics('  a   b\n c  '), 'a b c');
  assert.equal(languageFromLyricsTag('zxx')?.mode, 'instrumental');
});
