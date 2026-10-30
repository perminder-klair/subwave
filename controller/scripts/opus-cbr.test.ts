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
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SETTINGS_OPUS_BITRATES } from '../src/schemas/settings.js';

const RADIO = readFileSync(new URL('../../liquidsoap/radio.liq', import.meta.url), 'utf8');

// Both comment forms Liquidsoap has go first, whole: a vbr="none" left in a
// comment inside a multi-line %opus( would read as the encoder's own (#2164).
// A string's `#{…}` is cut too, which costs nothing: a %opus that shared its
// line would lose its bitrate and fail the branch check below.
function code(source: string) {
  return source.replace(/#<[\s\S]*?>#/g, '').replace(/#.*/g, '');
}

// A bare %opus takes the encoder's defaults, which are VBR, so it counts as an
// encoder with no parameters.
function opusEncoders(source: string) {
  return [...code(source).matchAll(/%opus\b(?:\s*\(([^)]*)\))?/g)].map(m => m[1] ?? '');
}

function assertHardCbr(source: string) {
  const encoders = opusEncoders(source);
  assert.ok(encoders.length > 0, 'radio.liq builds an Opus encoder');
  for (const params of encoders) {
    assert.match(params, /\bvbr\s*=\s*["']none["']/, `%opus(${params}) must be CBR`);
    // DTX would shrink silence to a byte or two again, CBR or not.
    assert.doesNotMatch(params, /\bdtx\s*=\s*true/, `%opus(${params}) must not use DTX`);
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
const BRANCH_96 = '%opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="none")';
const MP3_64 = '%mp3(bitrate=64, samplerate=44100, stereo=true)';

function radioWith(from: string, to: string) {
  assert.ok(RADIO.includes(from), `radio.liq no longer has ${from}: this table needs updating`);
  return RADIO.replaceAll(from, to);
}

const PARAMS_96 = 'bitrate=96, samplerate=48000, channels=2, application="audio",';

const NOT_CBR: Record<string, () => string> = {
  'constrained VBR, as before #2157': () => radioWith('vbr="none"', 'vbr="constrained"'),
  'vbr="none" only in a trailing comment above the real value': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96} # vbr="none"\n  vbr="constrained"\n)`),
  'vbr="none" only in a full-line comment': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96}\n  # vbr="none"\n  vbr="constrained"\n)`),
  'vbr="none" only in a block comment': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96}\n  #<\n  vbr="none"\n  >#\n  vbr="constrained"\n)`),
  'vbr="none" in a comment after an encoder with no vbr at all': () =>
    radioWith(BRANCH_96, `%opus(bitrate=96, samplerate=48000, channels=2, application="audio") # vbr="none"`),
  'a bare %opus': () => radioWith(BRANCH_96, '%opus'),
  'a spaced %opus (…) that is VBR': () => radioWith(BRANCH_96, BRANCH_96.replace('%opus', '%opus ').replace('none', 'constrained')),
  'DTX': () => radioWith(BRANCH_96, BRANCH_96.replace(')', ', dtx = true)')),
  'an %ffmpeg libopus encoder': () => radioWith(MP3_64, '%ffmpeg(format="ogg", %audio(codec="libopus"))'),
};

for (const [name, source] of Object.entries(NOT_CBR)) {
  test(`fails on ${name}`, () => {
    // Built first: radioWith's own failure must not count as the check's.
    const edited = source();
    assert.throws(() => assertHardCbr(edited), assert.AssertionError);
  });
}

// All valid Liquidsoap 2.4.6, none of which changes the encoder.
const STILL_CBR: Record<string, () => string> = {
  'a trailing comment naming %opus on another encoder': () => radioWith(MP3_64, `${MP3_64} # not %opus`),
  'a trailing comment naming libopus on another encoder': () => radioWith(MP3_64, `${MP3_64} # not libopus`),
  "vbr='none'": () => radioWith('vbr="none"', "vbr='none'"),
  '%opus (…) with a space': () => radioWith('%opus(', '%opus ('),
  'spaced key = value': () => radioWith('vbr="none"', 'vbr = "none"'),
  'a comment left in a multi-line %opus(': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96} # was vbr="constrained"\n  vbr="none" # hard CBR, #2138\n)`),
};

for (const [name, source] of Object.entries(STILL_CBR)) {
  test(`passes with ${name}`, () => {
    assertHardCbr(source());
    assertOneBranchPerBitrate(source());
  });
}
