// Pins controller/src/audio/voice-library.ts — the single owner of the shared
// voice-clone folder (state/voices/ + the legacy state/chatterbox-voices/).
//
// Three properties are load-bearing and easy to regress:
//
//  - `resolve()` NEVER builds a path from caller input. It basenames, then
//    looks the name up in the real scan. Both the delete and the audition
//    route pass an operator-supplied :file straight into it, so a traversal
//    here is a filesystem read primitive behind the admin gate.
//  - Canonical dir wins over legacy on a filename clash, and a clash is a
//    refused import — silently clobbering a voice would swap it out from
//    under every persona pointing at that filename.
//  - The duration memo invalidates on size AND mtime. A stale duration on a
//    replaced file would show the wrong advisory forever.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// config.ts derives its voice dirs there — hence the dynamic import. Same
// style as scripts/voice-policy.test.ts.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-voicelib-'));
process.env.STATE_DIR = root;
// These would move the canonical dir out from under the test.
delete process.env.TTS_VOICE_DIR;
delete process.env.CHATTERBOX_VOICE_DIR;
// chatterbox.ts starts a 30s /health probe loop at module load when this is
// set — that would hold the test process open forever.
delete process.env.TTS_HEAVY_URL;

const VOICES = join(root, 'voices');
const LEGACY = join(root, 'chatterbox-voices');
mkdirSync(VOICES, { recursive: true });
mkdirSync(LEGACY, { recursive: true });

const lib = await import('../src/audio/voice-library.js');

// --- voiceWarning: the advisory band, pure ---------------------------------
await test('voiceWarning flags a clip under the floor', () => {
  assert.equal(lib.voiceWarning(2), 'short');
  assert.equal(lib.voiceWarning(lib.ADVISORY_MIN_SEC - 0.1), 'short');
});
await test('voiceWarning flags a clip over the ceiling', () => {
  assert.equal(lib.voiceWarning(45), 'long');
  assert.equal(lib.voiceWarning(lib.ADVISORY_MAX_SEC + 0.1), 'long');
});
await test('voiceWarning is silent inside the band and at its edges', () => {
  assert.equal(lib.voiceWarning(10), null);
  assert.equal(lib.voiceWarning(lib.ADVISORY_MIN_SEC), null);
  assert.equal(lib.voiceWarning(lib.ADVISORY_MAX_SEC), null);
});
await test('voiceWarning treats an unknown duration as no advice, not as bad', () => {
  // No ffprobe on a bare-host dev box — unknown must not render a warning.
  assert.equal(lib.voiceWarning(null), null);
  assert.equal(lib.voiceWarning(undefined), null);
  assert.equal(lib.voiceWarning(NaN), null);
});

// --- voiceFileName: slug + forced .wav -------------------------------------
await test('voiceFileName slugifies and forces .wav', () => {
  assert.equal(lib.voiceFileName('Morgan Freeman'), 'morgan-freeman.wav');
  assert.equal(lib.voiceFileName('  Late Night DJ  '), 'late-night-dj.wav');
});
await test('voiceFileName strips an audio extension the operator typed', () => {
  // The import modal defaults the name from the filename stem, but an operator
  // typing "morgan.wav" must not get "morgan-wav.wav".
  assert.equal(lib.voiceFileName('morgan.wav'), 'morgan.wav');
  assert.equal(lib.voiceFileName('Morgan.MP3'), 'morgan.wav');
});
await test('voiceFileName rejects a name with no slug left', () => {
  assert.throws(() => lib.voiceFileName('   '), /name is required/i);
  assert.throws(() => lib.voiceFileName('!!!'), /name is required/i);
});

// --- scan: merge, dedupe, filter, sort -------------------------------------
writeFileSync(join(VOICES, 'alpha.wav'), 'a');
writeFileSync(join(VOICES, 'shared.wav'), 'canonical');
writeFileSync(join(LEGACY, 'shared.wav'), 'legacy-loses');
writeFileSync(join(LEGACY, 'zulu.wav'), 'z');
writeFileSync(join(VOICES, 'notes.txt'), 'not audio');

await test('scan lists .wav from both dirs, sorted, non-wav excluded', async () => {
  const files = (await lib.scan()).map(e => e.file);
  assert.deepEqual(files, ['alpha.wav', 'shared.wav', 'zulu.wav']);
});
await test('scan dedupes a clash with the canonical dir winning', async () => {
  const shared = (await lib.scan()).find(e => e.file === 'shared.wav');
  assert.equal(shared?.legacy, false);
  assert.equal(shared?.dir, VOICES);
});
await test('scan flags a legacy-only file as legacy', async () => {
  const zulu = (await lib.scan()).find(e => e.file === 'zulu.wav');
  assert.equal(zulu?.legacy, true);
  assert.equal(zulu?.path, join(LEGACY, 'zulu.wav'));
});

// --- resolve: the traversal gate -------------------------------------------
await test('resolve returns the entry for a listed file', async () => {
  const e = await lib.resolve('alpha.wav');
  assert.equal(e?.path, join(VOICES, 'alpha.wav'));
});
await test('resolve refuses traversal and absolute paths', async () => {
  for (const bad of ['../alpha.wav', '../../etc/passwd', '/etc/passwd', 'sub/alpha.wav', '..']) {
    assert.equal(await lib.resolve(bad), null, `resolve(${bad}) must be null`);
  }
});
await test('resolve refuses an unlisted or non-wav name', async () => {
  assert.equal(await lib.resolve('nope.wav'), null);
  assert.equal(await lib.resolve('notes.txt'), null);
  assert.equal(await lib.resolve(''), null);
});

// --- duration memo key: invalidates on size AND mtime ----------------------
await test('durationMemoKey changes when size or mtime changes', () => {
  const base = { file: 'a.wav', dir: VOICES, path: join(VOICES, 'a.wav'), legacy: false, size: 10, mtimeMs: 100 };
  const same = lib.durationMemoKey({ ...base });
  assert.equal(lib.durationMemoKey(base), same, 'identical entry must reuse the memo');
  assert.notEqual(lib.durationMemoKey({ ...base, size: 11 }), same, 'a resized file must re-probe');
  assert.notEqual(lib.durationMemoKey({ ...base, mtimeMs: 101 }), same, 'a rewritten file must re-probe');
});

// --- importVoice: the guards that run before any ffmpeg work ---------------
await test('importVoice refuses a name that already exists in either dir', async () => {
  await assert.rejects(
    lib.importVoice(Buffer.from('x'), { name: 'alpha', originalName: 'alpha.wav' }),
    /already exists/i,
  );
  // zulu.wav lives only in the legacy dir — still a clash.
  await assert.rejects(
    lib.importVoice(Buffer.from('x'), { name: 'zulu', originalName: 'zulu.wav' }),
    /already exists/i,
  );
});
await test('importVoice refuses a non-audio upload', async () => {
  await assert.rejects(
    lib.importVoice(Buffer.from('x'), { name: 'notes', originalName: 'notes.txt' }),
    /unsupported audio type/i,
  );
});
await test('importVoice refuses an empty buffer', async () => {
  await assert.rejects(
    lib.importVoice(Buffer.alloc(0), { name: 'empty', originalName: 'empty.wav' }),
    /empty/i,
  );
});

// --- removeVoice -----------------------------------------------------------
await test('removeVoice deletes a legacy-dir file too', async () => {
  await lib.removeVoice('zulu.wav');
  assert.equal(await lib.resolve('zulu.wav'), null);
});
await test('removeVoice refuses an unknown name', async () => {
  await assert.rejects(lib.removeVoice('ghost.wav'), /unknown voice/i);
});

// --- chatterbox.listReferenceVoices delegates to the one scanner -----------
// Signature is load-bearing: routes/settings/core.ts publishes the result as
// both tts.chatterboxVoices and tts.pocketTtsCustomVoices on every 3s poll.
const chatterbox = await import('../src/audio/chatterbox.js');

await test('listReferenceVoices returns the same filenames scan() found', async () => {
  const scanned = (await lib.scan()).map(e => e.file);
  const listed = await chatterbox.listReferenceVoices();
  assert.deepEqual(listed, scanned);
});
await test('listReferenceVoices returns a plain string[] of .wav names', async () => {
  const listed = await chatterbox.listReferenceVoices();
  assert.ok(Array.isArray(listed));
  for (const v of listed) {
    assert.equal(typeof v, 'string', 'must be filenames, not objects');
    assert.match(v, /\.wav$/i);
  }
});
await test('a newly imported voice shows up without a restart', async () => {
  // No ffmpeg needed: a .wav upload is stored through untouched.
  writeFileSync(join(VOICES, 'seed-check.wav'), 'seed');
  assert.ok((await chatterbox.listReferenceVoices()).includes('seed-check.wav'));
});
await test('listReferenceVoices never offers a directory named *.wav', async () => {
  // The discriminating case for the delegation: the pre-refactor scanner
  // filtered on the extension alone and would hand a DIRECTORY to the picker,
  // where selecting it fails at render time with a confusing worker error.
  // scan() stats every entry, so only real files survive.
  mkdirSync(join(VOICES, 'bogus.wav'), { recursive: true });
  assert.ok(!(await chatterbox.listReferenceVoices()).includes('bogus.wav'));
  assert.ok(!(await lib.scan()).some(e => e.file === 'bogus.wav'));
});

after(() => rmSync(root, { recursive: true, force: true }));
