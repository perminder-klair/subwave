// Speech-only date readings (#1669), quantity guards and correction precedence.
// Run: npm test -- speech-years
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeForDisplay, normalizeForSpeech, spokenWordScale } from '../src/audio/speech-text.js';

const years = [
  ['1967', 'nineteen sixty-seven'],
  ['1905', 'nineteen oh-five'],
  ['1900', 'nineteen hundred'],
  ['2000', 'two thousand'],
  ['2007', 'two thousand seven'],
  ['2010', 'twenty ten'],
  ['2026', 'twenty twenty-six'],
  ['1800', 'eighteen hundred'],
  ['1805', 'eighteen oh-five'],
  ['1899', 'eighteen ninety-nine'],
  ['1999', 'nineteen ninety-nine'],
  ['2001', 'two thousand one'],
  ['2009', 'two thousand nine'],
  ['2099', 'twenty ninety-nine'],
];
for (const [digits, words] of years) {
  test(`year ${digits} is spoken as ${words}`, () => {
    assert.equal(normalizeForSpeech(digits), words);
    assert.equal(normalizeForSpeech(`the ${digits} album`), `the ${words} album`);
    assert.equal(normalizeForSpeech(`Released in ${digits}.`), `Released in ${words}.`);
    assert.equal(normalizeForDisplay(digits), digits);
  });
}

const decades = [
  ['1960s', 'nineteen sixties'],
  ['1970s', 'nineteen seventies'],
  ['1900s', 'nineteen hundreds'],
  ['2000s', 'two thousands'],
  ['2010s', 'twenty tens'],
  ['1800s', 'eighteen hundreds'],
  ['2090s', 'twenty nineties'],
  ["the 1960's sound", 'the nineteen sixties sound'],
  ['the 1960’s sound', 'the nineteen sixties sound'],
  ["'60s", 'sixties'],
  ['’60s', 'sixties'],
  ["'60's", 'sixties'],
  ['the 60s', 'the sixties'],
  ['a 60s groove', 'a sixties groove'],
  ['60s music', 'sixties music'],
  ['60s-inspired soul', 'sixties-inspired soul'],
];
for (const [digits, words] of decades) {
  test(`decade ${digits} is spoken as ${words}`, () => {
    assert.equal(normalizeForSpeech(digits), words);
    assert.equal(normalizeForDisplay(digits), digits);
  });
}

const possessives = [
  ['It was 1990’s best-selling single.', "It was nineteen ninety's best-selling single."],
  ["It was 1990's best-selling single.", "It was nineteen ninety's best-selling single."],
  ["1967's biggest hit", "nineteen sixty-seven's biggest hit"],
  ["1960's", "nineteen sixty's"],
  ['1960’s', "nineteen sixty's"],
  ["the 1967's biggest hit", "the nineteen sixty-seven's biggest hit"],
];
for (const [text, words] of possessives) {
  test(`possessive year ${text} keeps its possessive`, () => {
    assert.equal(normalizeForSpeech(text), words);
    assert.equal(normalizeForDisplay(text), text);
  });
}
for (const context of ['early', 'mid', 'late', 'during', 'in the', 'of the', 'from the']) {
  test(`apostrophe decade after ${context} has decade context`, () => {
    assert.equal(normalizeForSpeech(`${context} 1960's`), `${context} nineteen sixties`);
    assert.equal(normalizeForSpeech(`${context} 1960’s`), `${context} nineteen sixties`);
  });
}

const singularMusicNouns = [
  ['the 1972 album', 'the nineteen seventy-two album'],
  ['his 1967 record', 'his nineteen sixty-seven record'],
  ['a 1975 session', 'a nineteen seventy-five session'],
  ['the 1972 studio album', 'the nineteen seventy-two studio album'],
  ['his 1967 vinyl record', 'his nineteen sixty-seven vinyl record'],
  ['a 1975 studio session', 'a nineteen seventy-five studio session'],
];
for (const [text, words] of singularMusicNouns) {
  test(`singular music noun in ${text} still permits a year reading`, () => {
    assert.equal(normalizeForSpeech(text), words);
  });
}

const ranges = [
  ['1967-1972', 'nineteen sixty-seven to nineteen seventy-two'],
  ['1967–1972', 'nineteen sixty-seven to nineteen seventy-two'],
  ['1967–72', 'nineteen sixty-seven to seventy-two'],
  ['1967-72', 'nineteen sixty-seven to seventy-two'],
  ['1967 to 1972', 'nineteen sixty-seven to nineteen seventy-two'],
  ['1999–2007', 'nineteen ninety-nine to two thousand seven'],
  ['1999–02', 'nineteen ninety-nine to two thousand two'],
  ['1901–05', 'nineteen oh-one to nineteen oh-five'],
  ['2001–05', 'two thousand one to two thousand five'],
  ['1999-02', 'nineteen ninety-nine to two thousand two'],
  ['1999 to 02', 'nineteen ninety-nine to two thousand two'],
  ['2001–10', 'two thousand one to ten'],
  ['1899–02', 'eighteen ninety-nine to nineteen oh-two'],
];
for (const [digits, words] of ranges) {
  test(`year range ${digits} is spoken naturally`, () => {
    assert.equal(normalizeForSpeech(digits), words);
    assert.equal(normalizeForDisplay(digits), digits);
  });
}

const quantities = [
  '1799', '2100', '1500 people', '2000 copies', '1967 people', '2000 RECORDS',
  '1967 seconds', '2000 dollars', '2000 million', '1967 Hz',
  '1,967', '1,1967', '1967,500', '1967.5', '.1967', '0.1967',
  '19:00', '1967:30', '10:1967', '1967/12', '12/1967', '1967-01-01',
  '1967-3000', '1967-19721', 'BLP1521', 'BLP1967', '1967A', '19671',
  '1700 to 1967', '1967 to 1972 to 1975',
  '1967-67', '1967-1967', '1972-1967', '2099-02',
  'We have 1984 vinyl records.', '1984 records', '1984 studio albums',
  '1984 recorded songs', '1984 young people',
  'Call 212 555 1967.', 'Call 1967 555 212.', 'Call 212 1967 555.',
  'Room 1967', 'catalogue number 1967', 'catalogue 1967', 'catalog 1967',
  'cat. 1967', 'no. 1967', 'number 1967', '#1967', 'Catalogue # 1967', 'serial 1967',
  'model 1967', 'flight 1967', 'route 1967', 'track number 1967',
  'extension 1967', 'ext 1967', 'ext. 1967',
  '11967', 'é1967', '1967é', 'release_1967', '1967s',
  '60s', '60s timeout', 'the 60s timeout', 'in 60s', 'wait 60s', '160s', 'BLP60s', '60seconds',
];
for (const text of quantities) {
  test(`quantity/identifier ${text} stays numeric`, () => {
    assert.equal(normalizeForSpeech(text), text);
  });
}

test('non-forward en-dash ranges retain numeric endpoints after punctuation cleanup', () => {
  assert.equal(normalizeForSpeech('1967–67'), '1967 to 67');
  assert.equal(normalizeForSpeech('1972–1967'), '1972 to 1967');
});

test('currency and units keep their existing expansions and numeric readings', () => {
  assert.equal(normalizeForSpeech('$1967'), '1967 dollars');
  assert.equal(normalizeForSpeech('$1967.50'), '1967.50 dollars');
  assert.equal(normalizeForSpeech('$2000 million'), '2000 million dollars');
  assert.equal(normalizeForSpeech('$2000k'), '2000 thousand dollars');
  assert.equal(normalizeForSpeech('£1967'), '£1967');
  assert.equal(normalizeForSpeech('1967%'), '1967 percent');
  assert.equal(normalizeForSpeech('1967°F'), '1967 degrees Fahrenheit');
  assert.equal(normalizeForSpeech('1967 mph'), '1967 miles per hour');
});

for (const unit of ['ms', 'g', 'm', 'W', 'mg', 'cm', 'ml', 'kW', 'kHz', 'rpm', 'bpm', 'dB', 'µs', 'milliseconds', 'grams', 'litres']) {
  test(`explicit ${unit} quantities never receive year readings`, () => {
    for (const year of ['1800', '1967', '2001', '2099']) {
      assert.equal(normalizeForSpeech(`${year} ${unit}`), `${year} ${unit}`);
    }
    assert.equal(normalizeForSpeech(`1967-1972 ${unit}`), `1967-1972 ${unit}`);
  });
}

for (const symbol of ['₹', '₩', '₽', '₦', '₺', '€', '£', '¥']) {
  test(`${symbol} currency quantities never receive year readings`, () => {
    assert.equal(normalizeForSpeech(`${symbol}1967`), `${symbol}1967`);
    assert.equal(normalizeForSpeech(`${symbol} 1967`), `${symbol} 1967`);
    assert.equal(normalizeForSpeech(`1967 ${symbol}`), `1967 ${symbol}`);
    assert.equal(normalizeForSpeech(`${symbol}1967-1972`), `${symbol}1967-1972`);
  });
}

for (const language of ['', 'English', 'English (UK)', 'en', 'en-GB', ' en_US ']) {
  test(`English language ${JSON.stringify(language)} permits date words`, () => {
    assert.equal(normalizeForSpeech('1967 and the 1960s', undefined, language),
      'nineteen sixty-seven and the nineteen sixties');
  });
}

for (const language of ['French', 'fr', 'Spanish', 'es', 'Turkish', 'German', 'Japanese', 'unknown']) {
  test(`${language} dates stay numeric and operator corrections still apply`, () => {
    const text = "1967, 1960s, '60s and 1967-1972";
    assert.equal(normalizeForSpeech(text, undefined, language), text);
    assert.equal(normalizeForSpeech('Sorti en **1967**.', [
      { from: '1967', to: 'mille neuf cent soixante-sept' },
    ], language), 'Sorti en mille neuf cent soixante-sept.');
    assert.equal(normalizeForDisplay('Sorti en 1967.'), 'Sorti en 1967.');
  });
}

test('punctuation cleanup does not turn multi-part dates into year ranges', () => {
  assert.equal(normalizeForSpeech('1967–01–01'), '1967 to 01 to 01');
});

test('operator years/decades override the built-in reading after markup cleanup', () => {
  const corrections = [
    { from: '1967', to: 'my chosen year reading' },
    { from: '1960s', to: 'my chosen decade reading' },
  ];
  assert.equal(normalizeForSpeech('the **1967** album and a 1960s groove', corrections),
    'the my chosen year reading album and a my chosen decade reading groove');
});

test('year expansion participates in the existing spoken-word budget', () => {
  const display = 'the 1967 album';
  assert.equal(spokenWordScale(display, normalizeForSpeech(display)), 3 / 4);
});

test('500 cached corrections work repeatedly, in order, with live edits', () => {
  const corrections = Array.from({ length: 500 }, (_, i) => ({ from: `name${i}`, to: `spoken${i}` }));
  for (let i = 0; i < 3; i++) {
    assert.equal(normalizeForSpeech('name0 NAME499 name0', corrections), 'spoken0 spoken499 spoken0');
  }
  corrections[499].from = 'changed';
  corrections[499].to = 'new pronunciation';
  assert.equal(normalizeForSpeech('name499 changed', corrections), 'name499 new pronunciation');
  corrections[499].to = '';
  assert.equal(normalizeForSpeech('changed name0', corrections), 'spoken0');
  assert.equal(normalizeForSpeech('name0', [
    { from: 'name0', to: 'name1' }, { from: 'name1', to: 'last rule wins' },
  ]), 'last rule wins');
});
