// Unit tests for the pure spoken-text normalizer (audio/speech-text.ts) —
// the defensive layer between generated radio copy and TTS (issue #963).
// Run: `npm test -- speech-text`.
//
// Two families of pins: display forms that MUST convert to spoken forms
// (weather units, %, $, mph, &, markdown emphasis), and real-world text that
// MUST survive untouched (artist names, Chatterbox [laugh] tags, decimals).
//
// Plus the display/speech split (#1186): normalizeForDisplay does the markup
// cleanup and NONE of the pronunciation layer, so a speech-only spelling can
// never reach the booth log, the session, or the player's feed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForDisplay, normalizeForSpeech, sanitizePerformanceCues, spokenWordScale, stripSpeakerLabel,
} from '../src/audio/speech-text.js';

const cast = ['Iris', 'Lucifer', 'Solène'];
test('a leading persona label is stripped, colon tight or spaced', () => {
  assert.equal(stripSpeakerLabel('Iris: Je sens une lumière lointaine.', cast), 'Je sens une lumière lointaine.');
  assert.equal(stripSpeakerLabel('Lucifer : blablabla', cast), 'blablabla');
});
test('any cast name counts, not just the line\'s own speaker', () => {
  // A model that prefixes a label picks any name on the call sheet, including
  // the one it is answering.
  assert.equal(stripSpeakerLabel('Solène: Oui, presque trop légère.', cast), 'Oui, presque trop légère.');
});
test('accents and case do not matter', () => {
  assert.equal(stripSpeakerLabel('Solene: bonsoir', cast), 'bonsoir');
  assert.equal(stripSpeakerLabel('IRIS : bonsoir', cast), 'bonsoir');
});
test('an opening quote before the label does not hide it', () => {
  assert.equal(stripSpeakerLabel('"Iris: bonsoir', cast), 'bonsoir');
});
test('paired quotes around the name do not hide a known label', () => {
  for (const label of ['"Iris"', "'Iris'", '«Iris»', '“Iris”']) {
    assert.equal(stripSpeakerLabel(`${label}: bonsoir`, cast), 'bonsoir');
  }
  assert.equal(stripSpeakerLabel('«Solene» : bonsoir', cast), 'bonsoir');
  assert.equal(stripSpeakerLabel('«Bob»: bonsoir', cast), '«Bob»: bonsoir');
  assert.equal(stripSpeakerLabel('«Iris»: ', cast), '«Iris»: ');
});
test('long and decomposed known names have no arbitrary prefix limit', () => {
  for (const name of ['The Midnight Frequency Presenter', 'A'.repeat(40), 'é'.repeat(40).normalize('NFD')]) {
    assert.equal(stripSpeakerLabel(`${name}: bonsoir`, [name]), 'bonsoir');
  }
  assert.equal(stripSpeakerLabel('A'.repeat(40) + ': bonsoir', cast), 'A'.repeat(40) + ': bonsoir');
});
test('deliberately unsupported markup and tight colon remain unchanged', () => {
  assert.equal(stripSpeakerLabel('Iris:bonsoir', cast), 'Iris:bonsoir');
  assert.equal(stripSpeakerLabel('**Iris:** bonsoir', cast), '**Iris:** bonsoir');
});
test('REAL SPEECH IS NEVER TOUCHED — this is the whole point', () => {
  // A blanket "drop any leading Word:" would eat the first word of these.
  assert.equal(stripSpeakerLabel('Attention : voici le morceau', cast), 'Attention : voici le morceau');
  assert.equal(stripSpeakerLabel('Bref : on continue', cast), 'Bref : on continue');
  assert.equal(stripSpeakerLabel('Prochain titre : Neon Void', cast), 'Prochain titre : Neon Void');
});
test('a name that is not in the cast stays put', () => {
  assert.equal(stripSpeakerLabel('Vespera: bonsoir', cast), 'Vespera: bonsoir');
  assert.equal(stripSpeakerLabel('Iris: bonsoir', []), 'Iris: bonsoir');
});
test('a name deeper in the line is speech, not routing', () => {
  assert.equal(stripSpeakerLabel('et puis Iris: ce moment-là', cast), 'et puis Iris: ce moment-là');
});
test('only one label is stripped', () => {
  assert.equal(stripSpeakerLabel('Iris: Lucifer : bonsoir', cast), 'Lucifer : bonsoir');
});
test('a label with nothing after it is left alone rather than emptying the line', () => {
  assert.equal(stripSpeakerLabel('Iris: ', cast), 'Iris: ');
});
test('empty and label-free input pass through', () => {
  assert.equal(stripSpeakerLabel('', cast), '');
  assert.equal(stripSpeakerLabel('bonsoir à tous', cast), 'bonsoir à tous');
});

test('°F expands, with and without a space', () => {
  assert.equal(normalizeForSpeech('Clear night, 76°F — the sky refuses to dim.'),
    'Clear night, 76 degrees Fahrenheit — the sky refuses to dim.');
  assert.equal(normalizeForSpeech('76 °F'), '76 degrees Fahrenheit');
});
test('°C expands, with and without a space', () => {
  assert.equal(normalizeForSpeech('18°C'), '18 degrees Celsius');
  assert.equal(normalizeForSpeech('18 °C'), '18 degrees Celsius');
});
test('bare ° after a number expands to degrees', () => {
  assert.equal(normalizeForSpeech('a 45° turn'), 'a 45 degrees turn');
});
test('° glued to a non-unit letter is left alone', () => {
  assert.equal(normalizeForSpeech('12°N of the equator'), '12°N of the equator');
});

test('% after a digit becomes percent', () => {
  assert.equal(normalizeForSpeech('40% chance of rain'), '40 percent chance of rain');
  assert.equal(normalizeForSpeech('100% Endurance'), '100 percent Endurance');
});
test('lone % is left alone', () => {
  assert.equal(normalizeForSpeech('the % key'), 'the % key');
});
test('$ before a number reads as dollars after it', () => {
  assert.equal(normalizeForSpeech('$12 at the door'), '12 dollars at the door');
  assert.equal(normalizeForSpeech('$1,200'), '1,200 dollars');
  assert.equal(normalizeForSpeech('sold for $5 million last year'), 'sold for 5 million dollars last year');
});
test('$ inside a name is untouched (Ke$ha)', () => {
  assert.equal(normalizeForSpeech('Ke$ha on deck'), 'Ke$ha on deck');
});
test('compact magnitude suffixes expand ($100k, $5M, $2bn)', () => {
  assert.equal(normalizeForSpeech('won $100k on the show'), 'won 100 thousand dollars on the show');
  assert.equal(normalizeForSpeech('sold for $5M last year'), 'sold for 5 million dollars last year');
  assert.equal(normalizeForSpeech('a $2bn valuation'), 'a 2 billion dollars valuation');
});
test('already-spoken "dollars" is not doubled', () => {
  assert.equal(normalizeForSpeech('sold for $5 million dollars'), 'sold for 5 million dollars');
  assert.equal(normalizeForSpeech('$5 dollars at the door'), '5 dollars at the door');
});
test('magnitude words match whole words only ($5 millionaire)', () => {
  assert.equal(normalizeForSpeech('a $5 millionaire lifestyle'), 'a 5 dollars millionaire lifestyle');
});
test('an unknown glued suffix leaves the amount alone ($100x)', () => {
  assert.equal(normalizeForSpeech('the $100x return'), 'the $100x return');
});
test('HTML entities decode before the & rule', () => {
  assert.equal(normalizeForSpeech('Florence &amp; the Machine'), 'Florence and the Machine');
  assert.equal(normalizeForSpeech('it&#39;s a classic'), "it's a classic");
  assert.equal(normalizeForSpeech('she said &quot;play it&quot;'), 'she said play it');
});
test('undecoded entity shapes are not mangled into "and"', () => {
  assert.equal(normalizeForSpeech('4 &lt; 5'), '4 &lt; 5');
  assert.equal(normalizeForSpeech('Tom & Jerry; a classic duo'), 'Tom and Jerry; a classic duo');
});
test('speed units expand after a number', () => {
  assert.equal(normalizeForSpeech('35 mph winds'), '35 miles per hour winds');
  assert.equal(normalizeForSpeech('gusts to 56 km/h'), 'gusts to 56 kilometers per hour');
});
test('& reads as and, including inside names', () => {
  assert.equal(normalizeForSpeech('A & B'), 'A and B');
  assert.equal(normalizeForSpeech('Florence & the Machine'), 'Florence and the Machine');
  assert.equal(normalizeForSpeech('classic R&B'), 'classic R and B');
});

test('emphasis marks drop, words stay', () => {
  assert.equal(normalizeForSpeech('**RadioMania**'), 'RadioMania');
  assert.equal(normalizeForSpeech('*quietly*'), 'quietly');
  assert.equal(normalizeForSpeech('__loud__ and _clear_'), 'loud and clear');
  assert.equal(normalizeForSpeech('the `stream.mp3` mount'), 'the stream.mp3 mount');
});
test('bold wrapping a unit still normalizes the unit', () => {
  assert.equal(normalizeForSpeech('**76°F**'), '76 degrees Fahrenheit');
});
test('markdown headings drop their hashes', () => {
  assert.equal(normalizeForSpeech('## Tonight'), 'Tonight');
});
test('stray asterisks vanish, snake_case survives', () => {
  assert.equal(normalizeForSpeech('a * b'), 'a b');
  assert.equal(normalizeForSpeech('track_01_final stays'), 'track_01_final stays');
});
test('keeps up to two performance cues with speech after each cue', () => {
  assert.equal(normalizeForSpeech('[laugh] good one [softly] let\'s move on'),
    '[laugh] good one [softly] let\'s move on');
});
test('drops trailing, closing and excess performance cues', () => {
  assert.equal(normalizeForSpeech('Good one. [sigh]'), 'Good one.');
  assert.equal(normalizeForSpeech('[warmly] Good one. [/warmly]'), '[warmly] Good one.');
  assert.equal(normalizeForSpeech('[softly] One. [laughing] Two. [dryly] Three.'),
    '[softly] One. [laughing] Two. Three.');
});
test('does not preserve stacked or cue-only bracket tags', () => {
  assert.equal(sanitizePerformanceCues('[softly] [warmly] Hello.'), '[warmly] Hello.');
  assert.equal(sanitizePerformanceCues('[softly]'), '');
});
test('drops production directions and malformed brackets, keeping spoken words', () => {
  assert.equal(normalizeForSpeech('[Square cue - fade out vocals] Let\'s begin.'), 'Let\'s begin.');
  assert.equal(normalizeForSpeech('[0s] This is on air.'), 'This is on air.');
  assert.equal(normalizeForSpeech('[pause] Keep talking.'), 'Keep talking.');
  assert.equal(normalizeForSpeech('[pausing briefly] Keep talking.'), 'Keep talking.');
  assert.equal(normalizeForSpeech('[-whispering] Test words.'), 'Test words.');
  assert.equal(normalizeForSpeech('Enough [sigh].'), 'Enough');
  assert.equal(normalizeForSpeech('[Junkie fades back in] Let\'s begin.'), 'Let\'s begin.');
  assert.equal(normalizeForSpeech('Hello [softly'), 'Hello softly');
});
test('keeps delivery cues while rejecting production wording', () => {
  assert.equal(normalizeForSpeech('[softly] A quiet word.'), '[softly] A quiet word.');
  assert.equal(normalizeForSpeech('[gentle fade] A quiet word.'), 'A quiet word.');
});
test('preserves bracketed title and edition qualifiers as spoken text', () => {
  assert.equal(normalizeForSpeech('That was Song Title [Live].'), 'That was Song Title Live.');
  assert.equal(normalizeForSpeech('Here is Album Cut [Deluxe].'), 'Here is Album Cut Deluxe.');
  assert.equal(normalizeForSpeech('Next, Song Title [Remastered 2011].'),
    'Next, Song Title Remastered twenty eleven.');
  assert.equal(normalizeForSpeech('[Live fade out] Keep talking.'), 'Keep talking.',
    'a title-like prefix must not override the production-direction blocklist');
});
test('cleans generated links, HTML and invisible controls for display', () => {
  assert.equal(normalizeForDisplay('[listen here](https://example.test) <em>now</em>\u200b'), 'listen here now');
});

test('SUB/WAVE reads as Subwave (existing rule preserved)', () => {
  assert.equal(normalizeForSpeech("You're listening to SUB/WAVE."), "You're listening to Subwave.");
  assert.equal(normalizeForSpeech('sub slash wave'), 'Subwave');
});
test('other slashes are untouched (AC/DC)', () => {
  assert.equal(normalizeForSpeech('AC/DC up next'), 'AC/DC up next');
});
test('normalizes punctuation known to upset cloud TTS without changing display', () => {
  const source = 'From 1991–1993 — \u201cquiet\u201d… and ready.';
  assert.equal(normalizeForSpeech(source), 'From nineteen ninety-one to nineteen ninety-three — quiet... and ready.');
  assert.equal(normalizeForDisplay(source), 'From 1991–1993 — “quiet”… and ready.');
  assert.equal(normalizeForSpeech('A\u00a0soft\u00adhyphen\u200b stays tidy.'), 'A softhyphen stays tidy.');
});
test('whitespace collapses, empty passes through', () => {
  assert.equal(normalizeForSpeech('two   spaces'), 'two spaces');
  assert.equal(normalizeForSpeech(''), '');
});

test('basic replace, case-insensitive', () => {
  const rules = [{ from: 'Hozier', to: 'Ho-zeer' }];
  assert.equal(normalizeForSpeech('that was Hozier with Take Me to Church', rules),
    'that was Ho-zeer with Take Me to Church');
  assert.equal(normalizeForSpeech('HOZIER again', rules), 'Ho-zeer again');
});
test('word-bounded: never fires inside a longer word', () => {
  const rules = [{ from: 'live', to: 'lyve' }];
  assert.equal(normalizeForSpeech('live at the delivery depot', rules),
    'lyve at the delivery depot');
});
test('symbol-edged rules match without a word boundary (Ke$ha)', () => {
  const rules = [{ from: 'Ke$ha', to: 'Kesha' }];
  assert.equal(normalizeForSpeech('Ke$ha on deck', rules), 'Kesha on deck');
});
test('regex specials in `from` are literal, $ in `to` is literal', () => {
  const rules = [{ from: 'A+ (deluxe)', to: 'A-plus $pecial' }];
  assert.equal(normalizeForSpeech('the A+ (deluxe) cut', rules), 'the A-plus $pecial cut');
});
test('runs before symbol rules, so a rule can pre-empt an expansion', () => {
  const rules = [{ from: '$5', to: 'five bucks' }];
  assert.equal(normalizeForSpeech('$5 at the door', rules), 'five bucks at the door');
});
test('matches through markdown emphasis (applied after de-markup)', () => {
  const rules = [{ from: 'Hozier', to: 'Ho-zeer' }];
  assert.equal(normalizeForSpeech('**Hozier** up next', rules), 'Ho-zeer up next');
});
test('empty `to` drops the phrase, whitespace collapses', () => {
  const rules = [{ from: 'literally', to: '' }];
  assert.equal(normalizeForSpeech('it was literally the best set', rules),
    'it was the best set');
});
test('blank/malformed rules are skipped, no rules is a no-op', () => {
  const rules = [{ from: '   ', to: 'x' }, { from: 'GHz', to: 'gigahertz' }];
  assert.equal(normalizeForSpeech('a 3 GHz chip', rules), 'a 3 gigahertz chip');
  assert.equal(normalizeForSpeech('unchanged text', []), 'unchanged text');
  assert.equal(normalizeForSpeech('unchanged text'), 'unchanged text');
});
test('multi-word phrases replace as a unit', () => {
  const rules = [{ from: 'drum and bass', to: 'drum n bass' }];
  assert.equal(normalizeForSpeech('classic drum and bass hour', rules),
    'classic drum n bass hour');
});

// --- the display pass (#1186) -------------------------------------------

test('operator corrections never touch the display form', () => {
  // The two rules from the report: a name spelled for the engine's benefit
  // ("Ye" → "Yay") and a number that needs grouping ("Twenty88").
  assert.equal(normalizeForDisplay('Ye closing us out'), 'Ye closing us out');
  assert.equal(normalizeForDisplay('that Twenty88 cut'), 'that Twenty88 cut');
});
test('unit/symbol expansion is speech-only', () => {
  assert.equal(normalizeForDisplay('76°F and $5 at the door'), '76°F and $5 at the door');
  assert.equal(normalizeForSpeech('76°F and $5 at the door'),
    '76 degrees Fahrenheit and 5 dollars at the door');
});
test('station branding keeps its slash on the page', () => {
  assert.equal(normalizeForDisplay('you are on SUB/WAVE'), 'you are on SUB/WAVE');
  assert.equal(normalizeForSpeech('you are on SUB/WAVE'), 'you are on Subwave');
});
test('markup and entities ARE cleaned up — readable, not respelled', () => {
  assert.equal(normalizeForDisplay('**Hozier**  up  next'), 'Hozier up next');
  assert.equal(normalizeForDisplay('Simon &amp; Garfunkel'), 'Simon & Garfunkel');
  assert.equal(normalizeForDisplay('## Late shift\n_finally_'), 'Late shift finally');
});
test('valid cues remain visible, while trailing cues are removed', () => {
  assert.equal(normalizeForDisplay('[laugh] anyway'), '[laugh] anyway');
  assert.equal(normalizeForDisplay('That was lovely. [softly]'), 'That was lovely.');
  assert.equal(normalizeForDisplay(''), '');
});

// --- the intro-budget bridge --------------------------------------------

test('1 when the two forms have the same word count', () => {
  assert.equal(spokenWordScale('one two three', 'one two three'), 1);
  // A same-length substitution ("Ye" → "Yay") leaves the budget untouched.
  assert.equal(spokenWordScale('Ye closing us out', 'Yay closing us out'), 1);
});
test('a correction that EXPANDS shrinks the display budget', () => {
  // 3 display words → 5 spoken: the display ceiling has to be 3/5ths.
  assert.equal(spokenWordScale('that Twenty88 cut', 'that twenty eighty eight cut'), 3 / 5);
});
test('a correction that DROPS words widens it', () => {
  assert.equal(spokenWordScale('it was literally the best', 'it was the best'), 5 / 4);
});
test('clamped to [0.25, 4], and 1 on either side empty', () => {
  assert.equal(spokenWordScale('a b c d e f g h i j', 'x'), 4);
  assert.equal(spokenWordScale('x', 'a b c d e f g h i j'), 0.25);
  assert.equal(spokenWordScale('', 'anything'), 1);
  assert.equal(spokenWordScale('anything', '   '), 1);
});
