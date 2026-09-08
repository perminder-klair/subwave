// A TTS worker whose interpreter is missing must REJECT, never take the
// controller down. A spawn that never starts emits 'error', and an unhandled
// 'error' on a ChildProcess is thrown out of the event loop. POST
// /settings/tts/preview synthesizes in an EXPLICIT engine (so it cannot skip
// an unusable one), which is how a missing interpreter reached this path.
//
// Without the fix this file does not fail, it takes the test runner down with
// that unhandled 'error' — so reaching the assertions is most of the proof.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-spawn-'));
process.env.STATE_DIR = root;

// Point every engine at an interpreter that cannot exist, before config loads.
const MISSING = join(root, 'no-such-interpreter');
process.env.KOKORO_PYTHON = MISSING;
process.env.CHATTERBOX_PYTHON = MISSING;
process.env.POCKET_TTS_PYTHON = MISSING;
// chatterbox / pocket-tts route over HTTP when a sidecar URL is set; clear it
// to exercise the local-spawn path.
delete process.env.TTS_HEAVY_URL;

const kokoro = await import('../src/audio/kokoro.js');
const chatterbox = await import('../src/audio/chatterbox.js');
const pocketTts = await import('../src/audio/pocketTts.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

const ENGINES: Array<[string, { speak: (t: string, o?: never) => Promise<string> }]> = [
  ['kokoro', kokoro as never],
  ['chatterbox', chatterbox as never],
  ['pocket-tts', pocketTts as never],
];

for (const [name, mod] of ENGINES) {
  test(`${name}: a missing interpreter rejects instead of killing the process`, async () => {
    await assert.rejects(
      () => mod.speak('a line the operator asked to preview'),
      (err: Error) => {
        // The preview route puts this string in its 422 body.
        assert.match(err.message, /ENOENT|spawn|not available|unavailable/i, err.message);
        return true;
      },
      `${name} must reject, not emit an unhandled 'error'`,
    );

    // Still here, so the unhandled 'error' event did not fire.
    assert.equal(typeof process.pid, 'number');
  });
}

test('a second attempt still rejects cleanly rather than wedging', async () => {
  // failReady() reaps the child and the module restarts lazily on the next
  // speak(), so the failure has to be repeatable.
  await assert.rejects(() => kokoro.speak('again'));
  await assert.rejects(() => kokoro.speak('and again'));
});
