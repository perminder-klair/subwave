// Unit tests for the pure spoken-text normalizer (audio/speech-text.ts) —
// the defensive layer between generated radio copy and TTS (issue #963).
// Run: `npm test -- speech-text` (tsx scripts/speech-text.test.ts).
//
// Two families of pins: display forms that MUST convert to spoken forms
// (weather units, %, $, mph, &, markdown emphasis), and real-world text that
// MUST survive untouched (artist names, Chatterbox [laugh] tags, decimals).
//
// Plus the display/speech split (#1186): normalizeForDisplay does the markup
// cleanup and NONE of the pronunciation layer, so a speech-only spelling can
// never reach the booth log, the session, or the player's feed.

import assert from 'node:assert/strict';
import {
  normalizeForDisplay, normalizeForSpeech, spokenWordScale, sanitizeSpeechCorrections,
} from '../src/audio/speech-text.js';

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

  console.log('operator corrections (settings.tts.corrections):');
  await test('basic replace, case-insensitive', () => {
    const rules = [{ from: 'Hozier', to: 'Ho-zeer' }];
    assert.equal(normalizeForSpeech('that was Hozier with Take Me to Church', rules),
      'that was Ho-zeer with Take Me to Church');
    assert.equal(normalizeForSpeech('HOZIER again', rules), 'Ho-zeer again');
  });
  await test('word-bounded: never fires inside a longer word', () => {
    const rules = [{ from: 'live', to: 'lyve' }];
    assert.equal(normalizeForSpeech('live at the delivery depot', rules),
      'lyve at the delivery depot');
  });
  await test('symbol-edged rules match without a word boundary (Ke$ha)', () => {
    const rules = [{ from: 'Ke$ha', to: 'Kesha' }];
    assert.equal(normalizeForSpeech('Ke$ha on deck', rules), 'Kesha on deck');
  });
  await test('regex specials in `from` are literal, $ in `to` is literal', () => {
    const rules = [{ from: 'A+ (deluxe)', to: 'A-plus $pecial' }];
    assert.equal(normalizeForSpeech('the A+ (deluxe) cut', rules), 'the A-plus $pecial cut');
  });
  await test('runs before symbol rules, so a rule can pre-empt an expansion', () => {
    const rules = [{ from: '$5', to: 'five bucks' }];
    assert.equal(normalizeForSpeech('$5 at the door', rules), 'five bucks at the door');
  });
  await test('matches through markdown emphasis (applied after de-markup)', () => {
    const rules = [{ from: 'Hozier', to: 'Ho-zeer' }];
    assert.equal(normalizeForSpeech('**Hozier** up next', rules), 'Ho-zeer up next');
  });
  await test('empty `to` drops the phrase, whitespace collapses', () => {
    const rules = [{ from: 'literally', to: '' }];
    assert.equal(normalizeForSpeech('it was literally the best set', rules),
      'it was the best set');
  });
  await test('blank/malformed rules are skipped, no rules is a no-op', () => {
    const rules = [{ from: '   ', to: 'x' }, { from: 'GHz', to: 'gigahertz' }];
    assert.equal(normalizeForSpeech('a 3 GHz chip', rules), 'a 3 gigahertz chip');
    assert.equal(normalizeForSpeech('unchanged text', []), 'unchanged text');
    assert.equal(normalizeForSpeech('unchanged text'), 'unchanged text');
  });
  await test('multi-word phrases replace as a unit', () => {
    const rules = [{ from: 'drum and bass', to: 'drum n bass' }];
    assert.equal(normalizeForSpeech('classic drum and bass hour', rules),
      'classic drum n bass hour');
  });

  console.log('sanitizeSpeechCorrections (preview override):');
  await test('non-array input returns an empty list', () => {
    assert.deepEqual(sanitizeSpeechCorrections(undefined), []);
    assert.deepEqual(sanitizeSpeechCorrections(null), []);
    assert.deepEqual(sanitizeSpeechCorrections('nope'), []);
    assert.deepEqual(sanitizeSpeechCorrections({}), []);
  });
  await test('valid rows pass through unchanged', () => {
    assert.deepEqual(
      sanitizeSpeechCorrections([{ from: 'GHz', to: 'gigahertz' }]),
      [{ from: 'GHz', to: 'gigahertz' }],
    );
  });
  await test('rows with a blank/missing `from` are dropped', () => {
    assert.deepEqual(sanitizeSpeechCorrections([{ from: '', to: 'x' }]), []);
    assert.deepEqual(sanitizeSpeechCorrections([{ to: 'x' }]), []);
    assert.deepEqual(sanitizeSpeechCorrections([{ from: '   ', to: 'x' }]), []);
  });
  await test('non-string `to` becomes an empty string, not dropped', () => {
    assert.deepEqual(
      sanitizeSpeechCorrections([{ from: 'literally', to: 42 }]),
      [{ from: 'literally', to: '' }],
    );
  });
  await test('malformed rows (non-object, null) are skipped, not thrown', () => {
    assert.deepEqual(
      sanitizeSpeechCorrections([null, 'x', 42, { from: 'ok', to: 'yes' }]),
      [{ from: 'ok', to: 'yes' }],
    );
  });
  await test('`from` is truncated at 80 chars, `to` at 160', () => {
    const longFrom = 'a'.repeat(90);
    const longTo = 'b'.repeat(200);
    const result = sanitizeSpeechCorrections([{ from: longFrom, to: longTo }]);
    assert.equal(result[0].from.length, 80);
    assert.equal(result[0].to.length, 160);
  });
  await test('capped at 100 rows, extras dropped', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ from: `w${i}`, to: `x${i}` }));
    assert.equal(sanitizeSpeechCorrections(rows).length, 100);
    // the FIRST 100 survive, not an arbitrary subset
    assert.equal(sanitizeSpeechCorrections(rows)[0].from, 'w0');
    assert.equal(sanitizeSpeechCorrections(rows)[99].from, 'w99');
  });

  // --- the display pass (#1186) -------------------------------------------
  console.log('\nnormalizeForDisplay — reader\'s form, no pronunciation layer');

  await test('operator corrections never touch the display form', () => {
    // The two rules from the report: a name spelled for the engine's benefit
    // ("Ye" → "Yay") and a number that needs grouping ("Twenty88").
    assert.equal(normalizeForDisplay('Ye closing us out'), 'Ye closing us out');
    assert.equal(normalizeForDisplay('that Twenty88 cut'), 'that Twenty88 cut');
  });
  await test('unit/symbol expansion is speech-only', () => {
    assert.equal(normalizeForDisplay('76°F and $5 at the door'), '76°F and $5 at the door');
    assert.equal(normalizeForSpeech('76°F and $5 at the door'),
      '76 degrees Fahrenheit and 5 dollars at the door');
  });
  await test('station branding keeps its slash on the page', () => {
    assert.equal(normalizeForDisplay('you are on SUB/WAVE'), 'you are on SUB/WAVE');
    assert.equal(normalizeForSpeech('you are on SUB/WAVE'), 'you are on Subwave');
  });
  await test('markup and entities ARE cleaned up — readable, not respelled', () => {
    assert.equal(normalizeForDisplay('**Hozier**  up  next'), 'Hozier up next');
    assert.equal(normalizeForDisplay('Simon &amp; Garfunkel'), 'Simon & Garfunkel');
    assert.equal(normalizeForDisplay('## Late shift\n_finally_'), 'Late shift finally');
  });
  await test('[laugh] tags and empty input behave as in the speech pass', () => {
    assert.equal(normalizeForDisplay('[laugh] anyway'), '[laugh] anyway');
    assert.equal(normalizeForDisplay(''), '');
  });

  // --- the intro-budget bridge --------------------------------------------
  console.log('\nspokenWordScale — spoken-word ceiling → display-word ceiling');

  await test('1 when the two forms have the same word count', () => {
    assert.equal(spokenWordScale('one two three', 'one two three'), 1);
    // A same-length substitution ("Ye" → "Yay") leaves the budget untouched.
    assert.equal(spokenWordScale('Ye closing us out', 'Yay closing us out'), 1);
  });
  await test('a correction that EXPANDS shrinks the display budget', () => {
    // 3 display words → 5 spoken: the display ceiling has to be 3/5ths.
    assert.equal(spokenWordScale('that Twenty88 cut', 'that twenty eighty eight cut'), 3 / 5);
  });
  await test('a correction that DROPS words widens it', () => {
    assert.equal(spokenWordScale('it was literally the best', 'it was the best'), 5 / 4);
  });
  await test('clamped to [0.25, 4], and 1 on either side empty', () => {
    assert.equal(spokenWordScale('a b c d e f g h i j', 'x'), 4);
    assert.equal(spokenWordScale('x', 'a b c d e f g h i j'), 0.25);
    assert.equal(spokenWordScale('', 'anything'), 1);
    assert.equal(spokenWordScale('anything', '   '), 1);
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
}

main();
