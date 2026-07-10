// Unit tests for the pure spoken-text normalizer (audio/speech-text.ts) —
// the defensive layer between generated radio copy and TTS (issue #963).
// Run: `npm test -- speech-text` (tsx scripts/speech-text.test.ts).
//
// Two families of pins: display forms that MUST convert to spoken forms
// (weather units, %, $, mph, &, markdown emphasis), and real-world text that
// MUST survive untouched (artist names, Chatterbox [laugh] tags, decimals).

import assert from 'node:assert/strict';
import { normalizeForSpeech } from '../src/audio/speech-text.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('temperature units:');
  await test('°F expands, with and without a space', () => {
    assert.equal(normalizeForSpeech('Clear night, 76°F — the sky refuses to dim.'),
      'Clear night, 76 degrees Fahrenheit — the sky refuses to dim.');
    assert.equal(normalizeForSpeech('76 °F'), '76 degrees Fahrenheit');
  });
  await test('°C expands, with and without a space', () => {
    assert.equal(normalizeForSpeech('18°C'), '18 degrees Celsius');
    assert.equal(normalizeForSpeech('18 °C'), '18 degrees Celsius');
  });
  await test('bare ° after a number expands to degrees', () => {
    assert.equal(normalizeForSpeech('a 45° turn'), 'a 45 degrees turn');
  });
  await test('° glued to a non-unit letter is left alone', () => {
    assert.equal(normalizeForSpeech('12°N of the equator'), '12°N of the equator');
  });

  console.log('symbols and units:');
  await test('% after a digit becomes percent', () => {
    assert.equal(normalizeForSpeech('40% chance of rain'), '40 percent chance of rain');
    assert.equal(normalizeForSpeech('100% Endurance'), '100 percent Endurance');
  });
  await test('lone % is left alone', () => {
    assert.equal(normalizeForSpeech('the % key'), 'the % key');
  });
  await test('$ before a number reads as dollars after it', () => {
    assert.equal(normalizeForSpeech('$12 at the door'), '12 dollars at the door');
    assert.equal(normalizeForSpeech('$1,200'), '1,200 dollars');
    assert.equal(normalizeForSpeech('sold for $5 million last year'), 'sold for 5 million dollars last year');
  });
  await test('$ inside a name is untouched (Ke$ha)', () => {
    assert.equal(normalizeForSpeech('Ke$ha on deck'), 'Ke$ha on deck');
  });
  await test('compact magnitude suffixes expand ($100k, $5M, $2bn)', () => {
    assert.equal(normalizeForSpeech('won $100k on the show'), 'won 100 thousand dollars on the show');
    assert.equal(normalizeForSpeech('sold for $5M last year'), 'sold for 5 million dollars last year');
    assert.equal(normalizeForSpeech('a $2bn valuation'), 'a 2 billion dollars valuation');
  });
  await test('already-spoken "dollars" is not doubled', () => {
    assert.equal(normalizeForSpeech('sold for $5 million dollars'), 'sold for 5 million dollars');
    assert.equal(normalizeForSpeech('$5 dollars at the door'), '5 dollars at the door');
  });
  await test('magnitude words match whole words only ($5 millionaire)', () => {
    assert.equal(normalizeForSpeech('a $5 millionaire lifestyle'), 'a 5 dollars millionaire lifestyle');
  });
  await test('an unknown glued suffix leaves the amount alone ($100x)', () => {
    assert.equal(normalizeForSpeech('the $100x return'), 'the $100x return');
  });
  await test('HTML entities decode before the & rule', () => {
    assert.equal(normalizeForSpeech('Florence &amp; the Machine'), 'Florence and the Machine');
    assert.equal(normalizeForSpeech('it&#39;s a classic'), "it's a classic");
    assert.equal(normalizeForSpeech('she said &quot;play it&quot;'), 'she said "play it"');
  });
  await test('undecoded entity shapes are not mangled into "and"', () => {
    assert.equal(normalizeForSpeech('4 &lt; 5'), '4 &lt; 5');
    assert.equal(normalizeForSpeech('Tom & Jerry; a classic duo'), 'Tom and Jerry; a classic duo');
  });
  await test('speed units expand after a number', () => {
    assert.equal(normalizeForSpeech('35 mph winds'), '35 miles per hour winds');
    assert.equal(normalizeForSpeech('gusts to 56 km/h'), 'gusts to 56 kilometers per hour');
  });
  await test('& reads as and, including inside names', () => {
    assert.equal(normalizeForSpeech('A & B'), 'A and B');
    assert.equal(normalizeForSpeech('Florence & the Machine'), 'Florence and the Machine');
    assert.equal(normalizeForSpeech('classic R&B'), 'classic R and B');
  });

  console.log('markdown / display markup:');
  await test('emphasis marks drop, words stay', () => {
    assert.equal(normalizeForSpeech('**RadioMania**'), 'RadioMania');
    assert.equal(normalizeForSpeech('*quietly*'), 'quietly');
    assert.equal(normalizeForSpeech('__loud__ and _clear_'), 'loud and clear');
    assert.equal(normalizeForSpeech('the `stream.mp3` mount'), 'the stream.mp3 mount');
  });
  await test('bold wrapping a unit still normalizes the unit', () => {
    assert.equal(normalizeForSpeech('**76°F**'), '76 degrees Fahrenheit');
  });
  await test('markdown headings drop their hashes', () => {
    assert.equal(normalizeForSpeech('## Tonight'), 'Tonight');
  });
  await test('stray asterisks vanish, snake_case survives', () => {
    assert.equal(normalizeForSpeech('a * b'), 'a b');
    assert.equal(normalizeForSpeech('track_01_final stays'), 'track_01_final stays');
  });
  await test('Chatterbox paralinguistic tags keep their brackets', () => {
    assert.equal(normalizeForSpeech('[laugh] good one [sigh]'), '[laugh] good one [sigh]');
  });

  console.log('station branding + shape:');
  await test('SUB/WAVE reads as Subwave (existing rule preserved)', () => {
    assert.equal(normalizeForSpeech("You're listening to SUB/WAVE."), "You're listening to Subwave.");
    assert.equal(normalizeForSpeech('sub slash wave'), 'Subwave');
  });
  await test('other slashes are untouched (AC/DC)', () => {
    assert.equal(normalizeForSpeech('AC/DC up next'), 'AC/DC up next');
  });
  await test('whitespace collapses, empty passes through', () => {
    assert.equal(normalizeForSpeech('two   spaces'), 'two spaces');
    assert.equal(normalizeForSpeech(''), '');
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
}

main();
