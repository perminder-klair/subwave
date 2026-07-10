// Pins the pure rule checks behind llm-bench (scripts/llm-bench/rules.ts).
// Runs in the standard suite via run-tests.ts auto-discovery.

import assert from 'node:assert';
import { checkSpokenLine, checkAck, countSentences, firstWords } from './llm-bench/rules.js';

// --- clean lines pass --------------------------------------------------------

assert.deepStrictEqual(
  checkSpokenLine("Sky's finally breaking over Punjab — keep it steady out there."),
  [],
  'clean line should pass',
);

// --- empties -----------------------------------------------------------------

assert.deepStrictEqual(checkSpokenLine(''), ['empty']);
assert.deepStrictEqual(checkSpokenLine('   '), ['empty']);
assert.deepStrictEqual(checkSpokenLine(null), ['empty']);

// --- banned tells --------------------------------------------------------------

assert.ok(checkSpokenLine('And now, a word from the rain.').includes('banned-phrase:and-now'));
assert.ok(checkSpokenLine('Next up we have a classic.').includes('banned-phrase:next-up'));
assert.ok(checkSpokenLine('Coming up next: more music.').includes('banned-phrase:coming-up-next'));

// --- markup the TTS would read aloud ------------------------------------------

assert.ok(checkSpokenLine('*chuckles* what a track').includes('stage-direction:asterisks'));
assert.ok(checkSpokenLine('[sighs] long day on the dial').includes('stage-direction:brackets'));
assert.ok(checkSpokenLine('"The whole line is quoted."').includes('wrapping-quotes'));
assert.ok(checkSpokenLine('Great track 🔥').includes('emoji'));
// an apostrophe or an internal quote is NOT a wrap
assert.deepStrictEqual(checkSpokenLine("It's the hour of the slow lane."), []);

// --- digits / clock ------------------------------------------------------------

assert.ok(checkSpokenLine('It is 4 in the afternoon.', { noDigits: true }).includes('digits-in-spoken-time'));
assert.deepStrictEqual(checkSpokenLine('Just gone four in the afternoon.', { noDigits: true }), []);
assert.ok(checkSpokenLine('At 16:30 the road empties.', { noClock: true }).includes('clock-leak'));
assert.deepStrictEqual(checkSpokenLine('The road empties about now.', { noClock: true }), []);

// --- sentence budget ------------------------------------------------------------

assert.strictEqual(countSentences('One. Two. Three.'), 3);
assert.strictEqual(countSentences('No terminal punctuation'), 1);
assert.strictEqual(countSentences('Trailing thought…'), 1);
const six = 'A. B. C. D. E. F.';
assert.ok(checkSpokenLine(six).includes('over-length:5-sentences'));
assert.deepStrictEqual(checkSpokenLine(six, { maxSentences: 6 }), []);

// --- opener anti-repeat ----------------------------------------------------------

const openers = ["Sky's finally breaking over Punjab, thirty-three degrees"];
assert.ok(
  checkSpokenLine("Sky's finally breaking over the city tonight.", { recentOpeners: openers })
    .includes('opener-repeat'),
);
assert.deepStrictEqual(
  checkSpokenLine('Rain again over Punjab tonight.', { recentOpeners: openers }),
  [],
);
assert.strictEqual(firstWords("Sky's finally breaking over Punjab", 4), "sky's finally breaking over");

// --- ack length -------------------------------------------------------------------

assert.deepStrictEqual(checkAck('On it — that one is coming right up for you.'), []);
const ramble = Array(30).fill('word').join(' ');
assert.ok(checkAck(ramble).includes('ack-over-20-words'));

console.log('llm-bench rules: all assertions passed');
