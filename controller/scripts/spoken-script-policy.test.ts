import assert from 'node:assert/strict';
import { cjkUnsafeForSpokenLanguage, cjkWrittenLanguage, scrubCjkForSpeech } from '../src/audio/spoken-script-policy.js';

assert.equal(cjkUnsafeForSpokenLanguage(''), true, 'unset persona language follows the English default');
assert.equal(cjkUnsafeForSpokenLanguage('English'), true, 'English is protected');
assert.equal(cjkUnsafeForSpokenLanguage('English (UK)'), true, 'an English locale label is protected');
assert.equal(cjkUnsafeForSpokenLanguage('Japanese'), false, 'a Japanese persona keeps its native script');
assert.equal(cjkUnsafeForSpokenLanguage('Mandarin Chinese'), false, 'a Chinese persona keeps its native script');

assert.equal(
  scrubCjkForSpeech('Ulfuls bring the daylight with ガッツだぜ!!', 'English'),
  'Ulfuls bring the daylight!',
  'a residual Japanese title cannot reach English TTS',
);
assert.equal(
  scrubCjkForSpeech('Hikaru Utada with Hana束 wo Kimi ni.', ''),
  'Hikaru Utada with Hana wo Kimi ni.',
  'one leaked kanji is removed without discarding the model romanization',
);
assert.equal(
  scrubCjkForSpeech('稻香 by Jay Chou — still holding.', 'English'),
  'by Jay Chou — still holding.',
  'a native title is dropped while the canonical artist name survives',
);
assert.equal(
  scrubCjkForSpeech('宇多田ヒカルの「花束を君に」です。', 'Japanese'),
  '宇多田ヒカルの「花束を君に」です。',
  'native-language speech remains byte-identical',
);
assert.equal(
  scrubCjkForSpeech('Björk and Rosalía — unchanged.', 'English'),
  'Björk and Rosalía — unchanged.',
  'Latin-script names and accents remain untouched',
);
assert.equal(cjkUnsafeForSpokenLanguage('', ['English (UK)']), true, 'an all-English mix is still protected');
assert.equal(
  scrubCjkForSpeech('Next up, ウルフルズ — やばい tune, ね。', 'English', ['Japanese']),
  'Next up, ウルフルズ — やばい tune, ね。',
  'a multilingual persona keeps the script it mixes in',
);

// The scrub stands down only for a mix language written in CJK script.
assert.equal(cjkUnsafeForSpokenLanguage('English', ['Spanish']), true, 'English + Spanish keeps the CJK net');
assert.equal(
  scrubCjkForSpeech('Next up, ウルフルズ — vamos.', 'English', ['Spanish']),
  'Next up, — vamos.',
  'English + Spanish on an English voice still loses leaked kana',
);
assert.equal(cjkUnsafeForSpokenLanguage('English', ['Spanish', 'Korean']), false, 'one CJK language in the mix stands it down');
assert.equal(cjkUnsafeForSpokenLanguage('English', ['日本語']), false, 'a native-script language name counts');
assert.equal(cjkUnsafeForSpokenLanguage('English', ['Chinese (Traditional)']), false, 'a labelled Chinese counts');
assert.equal(cjkUnsafeForSpokenLanguage('French', ['Spanish']), false, 'a non-English primary stays untouched, mix or not');

// A CJK language named anywhere as a whole word, or a whole-entry code.
for (const lang of [
  'Japanese', 'Korean', 'Cantonese', 'Chinese (Traditional)', '日本語', 'Japanese_JP', 'korean-seoul',
  'Traditional Chinese', 'Simplified Chinese', 'Mandarin Chinese', 'Taiwanese Mandarin',
  'zh', 'ja', 'ko', 'ZH', 'zh-CN', 'zh-TW', 'zh-Hant', 'zh_Hans_CN', 'ja-JP', 'ko-KR',
]) {
  assert.equal(cjkWrittenLanguage(lang), true, `${lang} is CJK-written`);
  assert.equal(cjkUnsafeForSpokenLanguage('English', [lang]), false, `English + ${lang} keeps its script`);
}
for (const lang of [
  'Vietnamese', 'Hindi', 'Thai', 'Spanish', 'Klingon', 'Japanes', 'Koreanish',
  'jazz', 'kongo', 'zhuang', 'Japan-ish', 'en', 'es-ES', 'vi', 'th', 'hi',
]) {
  assert.equal(cjkWrittenLanguage(lang), false, `${lang} is not CJK-written`);
  assert.equal(cjkUnsafeForSpokenLanguage('English', [lang]), true, `English + ${lang} keeps the scrub`);
}

console.log('spoken-script-policy.test.ts: all assertions passed');
