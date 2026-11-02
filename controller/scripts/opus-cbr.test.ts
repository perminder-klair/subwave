// The Opus mount is hard CBR (#2138). Icecast's <burst-size> is a byte count
// sized from the encoder's bitrate (docker/broadcast-entrypoint.sh, the AIO's
// render_icecast()), so the burst holds bufferSeconds of audio only when every
// second costs the same bytes. Under constrained VBR digital silence cost
// ~1.6 kbps, so after an idle pause a new Opus listener's burst reached back
// past the pause into the music before it, and they waited out the whole pause.
//
// radio.liq needs a parse-time literal per bitrate, so the rule is checked on
// every branch, and the branches are checked against the bitrates the settings
// allow: a value with no branch would fall through to another bitrate's encoder.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_OPUS_BITRATES } from '../src/schemas/settings.js';
import { NOT_CBR, RADIO, STILL_CBR } from './test-utils/opus-cbr-table.js';

// Both comment forms Liquidsoap has go first, whole: a vbr="none" left in a
// comment inside a multi-line %opus( would read as the encoder's own (#2164).
// Whichever form starts first wins, as in the lexer, so a #< inside a # comment
// opens nothing. A #< with no ># leaves a bare %opus, which reads as doubt: the
// lexer refuses such a file unless the #< sat in a string, and then what it cut
// is real code. A string's `#{…}` is cut too, which costs nothing: a %opus that
// shared its line would lose its bitrate and fail the branch check below.
// docker's liq_code() cuts the same way. Non-ASCII goes first, so \s means what
// the C-locale grep in opus_encoding() means: a no-break or em space is none, to
// either reader, though Liquidsoap takes both. A # comment runs to \n alone, as
// in the lexer, where . would stop at a bare \r.
function code(source: string) {
  return source
    .replace(/[\u0080-\uffff]/g, '?')
    .replace(/#<[\s\S]*?(>#|$)|#[^\n]*/g, (_, closer) => (closer === '' ? ' %opus ' : ' '));
}

// A bare %opus takes the encoder's defaults, which are constrained VBR (measured
// on 2.4.6), so it counts as an encoder with no parameters.
function opusEncoders(source: string) {
  return [...code(source).matchAll(/%opus\b(?:\s*\(([^)]*)\))?/g)].map(m => m[1] ?? '');
}

function assertHardCbr(source: string) {
  const encoders = opusEncoders(source);
  assert.ok(encoders.length > 0, 'radio.liq builds an Opus encoder');
  for (const params of encoders) {
    assert.match(params, /\bvbr\s*=\s*["']none["']/, `%opus(${params}) must be CBR`);
    // The last vbr wins, so one saying "none" proves nothing beside another.
    assert.doesNotMatch(params, /\bvbr\s*=[\s\S]*\bvbr\s*=/, `%opus(${params}) must set vbr once`);
    // A ( inside the call means the first ) need not close it, so a dtx or a
    // second vbr can sit past where this stopped reading.
    assert.doesNotMatch(params, /\(/, `%opus(${params}) must hold no parens`);
    // DTX would shrink silence to a byte or two again, CBR or not, and only a
    // literal false says it is off: dtx=(true) and dtx=d are as real.
    assert.doesNotMatch(params, /\bdtx\s*=(?!\s*false(?:[,\s]|$))/, `%opus(${params}) must not use DTX`);
  }
  // An %ffmpeg libopus encoder would escape the checks above.
  assert.ok(!code(source).includes('libopus'), 'build the Opus encoder with %opus');
}

function assertOneBranchPerBitrate(source: string) {
  const bitrates = opusEncoders(source).map(params => Number(/\bbitrate\s*=\s*(\d+)/.exec(params)?.[1]));
  assert.deepEqual([...bitrates].sort((a, b) => a - b), [...SETTINGS_OPUS_BITRATES].sort((a, b) => a - b));
}

test('every Opus encoder radio.liq builds is hard CBR', () => {
  assertHardCbr(RADIO);
});

test('there is one Opus branch per bitrate the settings allow', () => {
  assertOneBranchPerBitrate(RADIO);
});

// The rest edits the real file, so each row is checked as it would land.
for (const [name, source] of Object.entries(NOT_CBR)) {
  test(`fails on ${name}`, () => {
    // Built first: radioWith's own failure must not count as the check's.
    const edited = source();
    assert.throws(() => assertHardCbr(edited), assert.AssertionError);
  });
}

for (const [name, source] of Object.entries(STILL_CBR)) {
  test(`passes with ${name}`, () => {
    assertHardCbr(source());
    assertOneBranchPerBitrate(source());
  });
}
