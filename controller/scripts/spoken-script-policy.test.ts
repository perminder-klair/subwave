import assert from 'node:assert/strict';
import { cjkUnsafeForSpokenLanguage, scrubCjkForSpeech } from '../src/audio/spoken-script-policy.js';

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

console.log('spoken-script-policy.test.ts: all assertions passed');
