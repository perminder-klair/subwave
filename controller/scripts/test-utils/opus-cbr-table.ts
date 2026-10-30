// One table of edits to the real radio.liq, each saying whether the Opus mount
// it leaves behind is hard CBR. opus-cbr.test.ts holds its own check to these
// rows, and stream-mounts.test.ts holds opus_encoding() in both scripts to them,
// so the test and the marker cannot disagree about a file again (#2164).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const RADIO = readFileSync(new URL('../../../liquidsoap/radio.liq', import.meta.url), 'utf8');

const BRANCH_96 = '%opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="none")';
const MP3_64 = '%mp3(bitrate=64, samplerate=44100, stereo=true)';
const PARAMS_96 = 'bitrate=96, samplerate=48000, channels=2, application="audio",';

function radioWith(from: string, to: string) {
  assert.ok(RADIO.includes(from), `radio.liq no longer has ${from}: this table needs updating`);
  return RADIO.replaceAll(from, to);
}

export const NOT_CBR: Record<string, () => string> = {
  'constrained VBR, as before #2157': () => radioWith('vbr="none"', 'vbr="constrained"'),
  'vbr="none" only in a trailing comment above the real value': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96} # vbr="none"\n  vbr="constrained"\n)`),
  'vbr="none" only in a full-line comment': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96}\n  # vbr="none"\n  vbr="constrained"\n)`),
  'vbr="none" only in a block comment': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96}\n  #<\n  vbr="none"\n  >#\n  vbr="constrained"\n)`),
  'vbr="none" only in a one-line block comment': () =>
    radioWith(BRANCH_96, `%opus(${PARAMS_96} #< vbr="none" ># vbr="constrained")`),
  'vbr="none" in a comment after an encoder with no vbr at all': () =>
    radioWith(BRANCH_96, `%opus(bitrate=96, samplerate=48000, channels=2, application="audio") # vbr="none"`),
  'vbr="none" only on the end of a longer name': () => radioWith(BRANCH_96, BRANCH_96.replace('vbr=', 'xvbr=')),
  // Liquidsoap takes the last one: on 2.4.6 this encodes silence to the same
  // bytes as vbr="constrained" alone.
  'vbr given twice': () => radioWith(BRANCH_96, BRANCH_96.replace('vbr="none"', 'vbr="none", vbr="constrained"')),
  'a VBR encoder between line comments naming both block markers': () =>
    radioWith(BRANCH_96, `# a line comment naming #<\n  ${BRANCH_96.replace('none', 'constrained')}\n  # and one naming >#`),
  'a VBR encoder after a closed block comment': () =>
    radioWith(BRANCH_96, `#< closed ># ${BRANCH_96.replace('none', 'constrained')}`),
  // Boots on 2.4.6: the #< sits in a string, so nothing closes it, and what follows is code.
  'a VBR encoder after a #< in a string': () =>
    `${RADIO.trimEnd()}\nignore("#<")\nignore(%opus(bitrate=96, vbr="constrained"))\n`,
  'a bare %opus': () => radioWith(BRANCH_96, '%opus'),
  'a bare %opus ending the file with no newline': () => `${RADIO.trimEnd()}\n%opus`,
  'a bare %opus with a comment between it and the next name': () => radioWith(BRANCH_96, '%opus#< x >#samplerate'),
  'a spaced %opus (…) that is VBR': () => radioWith(BRANCH_96, BRANCH_96.replace('%opus', '%opus ').replace('none', 'constrained')),
  'DTX': () => radioWith(BRANCH_96, BRANCH_96.replace(')', ', dtx = true)')),
  'DTX across lines': () => radioWith(BRANCH_96, BRANCH_96.replace(')', ',\n  dtx\n  =\n  true\n)')),
  // Hard CBR on 2.4.6, which takes both as whitespace, but neither reader does.
  'vbr = "none" spaced with no-break spaces': () => radioWith(BRANCH_96, BRANCH_96.replace('vbr="none"', 'vbr\u00a0=\u00a0"none"')),
  'vbr = "none" spaced with em spaces': () => radioWith(BRANCH_96, BRANCH_96.replace('vbr="none"', 'vbr\u2003=\u2003"none"')),
  // These four boot on 2.4.6, and each encodes silence as DTX or VBR.
  'DTX past a ) inside the call': () =>
    radioWith(BRANCH_96, '%opus(vbr="none", bitrate=(96), samplerate=48000, channels=2, application="audio", dtx=true)'),
  'a second vbr past a ) inside the call': () =>
    radioWith(BRANCH_96, BRANCH_96.replace('vbr="none")', 'vbr="none", bitrate=(96), vbr="constrained")')),
  'DTX in parens': () => radioWith(BRANCH_96, BRANCH_96.replace(')', ', dtx=(true))')),
  'DTX from an expression': () => radioWith(BRANCH_96, BRANCH_96.replace(')', ', dtx=not false)')),
  'an %ffmpeg libopus encoder': () => radioWith(MP3_64, '%ffmpeg(format="ogg", %audio(codec="libopus"))'),
  'libopus named inside a %opus(': () => radioWith(BRANCH_96, BRANCH_96.replace('"audio"', '"libopus"')),
};

// All valid Liquidsoap 2.4.6, none of which changes the encoder.
export const STILL_CBR: Record<string, () => string> = {
  'a trailing comment naming %opus on another encoder': () => radioWith(MP3_64, `${MP3_64} # not %opus`),
  'a trailing comment naming libopus on another encoder': () => radioWith(MP3_64, `${MP3_64} # not libopus`),
  "vbr='none'": () => radioWith('vbr="none"', "vbr='none'"),
  '%opus (…) with a space': () => radioWith('%opus(', '%opus ('),
  'spaced key = value': () => radioWith('vbr="none"', 'vbr = "none"'),
  'vbr = "none" across lines and tabs': () => radioWith(BRANCH_96, BRANCH_96.replace('vbr="none"', 'vbr\n  =\t"none"')),
  'dtx=false': () => radioWith(BRANCH_96, BRANCH_96.replace(')', ', dtx=false)')),
  'a comment left in a multi-line %opus(': () =>
    radioWith(BRANCH_96, `%opus(\n  ${PARAMS_96} # was vbr="constrained"\n  vbr="none" # hard CBR, #2138\n)`),
  'a VBR encoder left in a block comment': () =>
    radioWith(MP3_64, `#<\n  %opus(bitrate=128, vbr="constrained")\n  >#\n  ${MP3_64}`),
  'a block comment left in a %opus(': () =>
    radioWith(BRANCH_96, `%opus(${PARAMS_96} #< was vbr="constrained" ># vbr="none")`),
  'a VBR encoder behind a bare CR in a line comment': () =>
    radioWith(MP3_64, `${MP3_64} # was\r%opus(bitrate=128, vbr="constrained")`),
  'a line comment naming #< with no block to close': () => radioWith(MP3_64, `${MP3_64} # not a #< block`),
  'a name that only starts with %opus, in a string': () =>
    radioWith('opus_shutdown =', 'ignore("%opus_not_an_encoder")\n  opus_shutdown ='),
};
