// settings.stream.bufferSeconds — the Icecast burst depth, in seconds.
//
// load()'s stream block composes explicitly rather than spreading DEFAULTS, and
// bufferSeconds was never listed (the "three edits" trap that also cost
// llm.repeatPenalty, #1327). update() wrote it to settings.json and it worked in
// memory for that process; the next cold load read `undefined`, and three things
// went wrong at once:
//
//   - writeLiquidsoapSettings put the STRING "undefined" in the mixer handoff
//     file, so the entrypoint's read_state_num fell back to 22 and the burst was
//     sized for the default rather than the operator's value;
//   - /now-playing advertised `?? 22`, so every player applied the wrong
//     listener-time offset (#1114's whole point is that the two agree);
//   - update()'s change gate compared against `undefined`, so a stream patch
//     restarted the mixer unconditionally.
//
// Hence a COLD-LOAD round trip, not just a clamp check — an in-process assertion
// passes on the broken code. Verified to fail on all four cases with the
// load() line removed.

import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-repeat-penalty.test.ts).
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-buffer-seconds-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { writeLiquidsoapSettings } = await import('../src/settings/liquidsoap.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { STREAM_BUFFER_SECONDS_BOUNDS } = await import('../src/schemas/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');
const HANDOFF_PATH = path.join(stateRoot, 'liquidsoap_stream_buffer_seconds.txt');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(stream: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ stream }));
  setCache(null);
  await settings.load();
  return settings.get().stream;
}

test('a configured buffer depth survives a controller restart', async () => {
  const stream = await coldLoad({ bufferSeconds: 40 });
  assert.equal(stream.bufferSeconds, 40);
});

test('the mixer handoff file carries the number, never "undefined"', async () => {
  const s = await coldLoad({ bufferSeconds: 40 });
  await writeLiquidsoapSettings(settings.get());
  const written = readFileSync(HANDOFF_PATH, 'utf8');
  assert.equal(written, '40');
  // The entrypoint's read_state_num rejects anything non-numeric and falls back
  // to 22, so a non-numeric write is silently the default — assert the shape it
  // actually parses, not just "not undefined".
  assert.match(written, /^[0-9]+$/);
  assert.equal(s.bufferSeconds, 40);
});

test('0 is a real value (burst-on-connect off), not a falsy miss', async () => {
  const stream = await coldLoad({ bufferSeconds: 0 });
  assert.equal(stream.bufferSeconds, 0);
  await writeLiquidsoapSettings(settings.get());
  assert.equal(readFileSync(HANDOFF_PATH, 'utf8'), '0');
});

test('an absent value falls back to the shipped default', async () => {
  const stream = await coldLoad({});
  assert.equal(stream.bufferSeconds, DEFAULTS.stream.bufferSeconds);
});

test('load bounds a hand-edited value against the same figures update() checks', async () => {
  // load() is the lenient path: it repairs rather than throwing, so a
  // settings.json edited by hand can never wedge boot.
  for (const bad of [
    STREAM_BUFFER_SECONDS_BOUNDS.max + 1,
    STREAM_BUFFER_SECONDS_BOUNDS.min - 1,
    'forty',
    null,
    NaN,
    {},
  ]) {
    const stream = await coldLoad({ bufferSeconds: bad });
    assert.equal(
      stream.bufferSeconds,
      DEFAULTS.stream.bufferSeconds,
      `bufferSeconds: ${JSON.stringify(bad)} should fall back to the default`,
    );
  }
  // In-band values are kept, and a fraction rounds the way the save path rounds.
  assert.equal((await coldLoad({ bufferSeconds: STREAM_BUFFER_SECONDS_BOUNDS.max })).bufferSeconds,
    STREAM_BUFFER_SECONDS_BOUNDS.max);
  assert.equal((await coldLoad({ bufferSeconds: 30.4 })).bufferSeconds, 30);
});

test('update() then a cold load agree — the save path stores what load accepts', async () => {
  await coldLoad({});
  await settings.update({ stream: { bufferSeconds: 45 } });
  assert.equal(settings.get().stream.bufferSeconds, 45);
  // Re-read from disk exactly as a restart would.
  setCache(null);
  await settings.load();
  assert.equal(settings.get().stream.bufferSeconds, 45);
});
