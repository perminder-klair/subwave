// A TTS worker whose interpreter is missing must REJECT, never take the
// controller down with it.
//
// The three heavy engines each hold a long-lived Python child. `start()` wired
// up 'stdout', 'stderr' and 'exit' — but a spawn that never starts emits
// **'error'**, and an unhandled 'error' event on a ChildProcess is thrown out
// of the event loop, killing the whole process. Every one of these
// interpreters is absent by default: chatterbox and pocket-tts are opt-in
// (--build-arg WITH_CHATTERBOX=1 / WITH_POCKETTTS=1) and kokoro's model/venv is
// pulled at build time and can fail. The dispatcher skips an unusable engine
// via engineUsable(), but POST /settings/tts/preview deliberately does NOT —
// it synthesizes in an EXPLICIT engine so the operator can test one, and
// answers 422 with the reason. So an admin pressing "Play sample" on an
// engine this build lacks crashed the controller: total dead air, from a
// button whose entire purpose is to report a failure.
//
// Observed live: the preview route killed the controller with
//   Error: spawn /opt/kokoro/venv/bin/python ENOENT
//   Emitted 'error' event on ChildProcess instance
// It now answers 422 and the station stays on air.
//
// piper has always attached an 'error' handler (audio/piper.ts) — these three
// are brought in line with it.
//
// NOTE ON THE ASSERTION: without the fix this file does not "fail", it takes
// the whole test RUNNER down with an unhandled 'error' — which is the point.
// Reaching the assertion at all is most of what is being proved.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-spawn-'));
process.env.STATE_DIR = root;

// Point every engine at an interpreter that cannot exist, BEFORE config loads.
const MISSING = join(root, 'no-such-interpreter');
process.env.KOKORO_PYTHON = MISSING;
process.env.CHATTERBOX_PYTHON = MISSING;
process.env.POCKET_TTS_PYTHON = MISSING;
// chatterbox / pocket-tts route over HTTP when a sidecar URL is set; clear it
// so this exercises the local-spawn path the test is about.
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
        // The rejection must carry the reason — the preview route puts this
        // string in its 422 body, and "something failed" sends the operator
        // hunting. ENOENT is what a missing interpreter produces.
        assert.match(err.message, /ENOENT|spawn|not available|unavailable/i, err.message);
        return true;
      },
      `${name} must reject, not emit an unhandled 'error'`,
    );

    // Still here, so the unhandled 'error' event did not fire. That is the
    // whole regression: the process is alive to run the next case.
    assert.equal(typeof process.pid, 'number');
  });
}

test('a second attempt still rejects cleanly rather than wedging', async () => {
  // failReady() reaps the child and the module lazily restarts on the next
  // speak(), so the failure has to be repeatable — an operator pressing
  // "Play sample" twice is the ordinary case.
  await assert.rejects(() => kokoro.speak('again'));
  await assert.rejects(() => kokoro.speak('and again'));
});
