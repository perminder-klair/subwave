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

const RADIO_PATH = new URL('../../liquidsoap/radio.liq', import.meta.url);

function opusEncoders() {
  const code = readFileSync(RADIO_PATH, 'utf8')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');
  return [...code.matchAll(/%opus\(([^)]*)\)/g)].map(m => m[1]!);
}

test('every Opus encoder radio.liq builds is hard CBR', () => {
  const encoders = opusEncoders();
  assert.ok(encoders.length > 0, 'radio.liq builds an Opus encoder');
  for (const params of encoders) {
    assert.match(params, /\bvbr="none"/, `%opus(${params}) must be CBR`);
    // DTX would shrink silence to a byte or two again, CBR or not.
    assert.doesNotMatch(params, /\bdtx=true/, `%opus(${params}) must not use DTX`);
  }
});

test('there is one Opus branch per bitrate the settings allow', () => {
  const bitrates = opusEncoders().map(params => Number(/\bbitrate=(\d+)/.exec(params)?.[1]));
  assert.deepEqual([...bitrates].sort((a, b) => a - b), [...SETTINGS_OPUS_BITRATES].sort((a, b) => a - b));
});
