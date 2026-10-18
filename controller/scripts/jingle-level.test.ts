// A created jingle is levelled like an uploaded one, so a quiet TTS render does
// not vanish between two normalised tracks. Run: npm test -- jingle-level

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const stateDir = mkdtempSync(path.join(tmpdir(), 'jingle-level-'));
process.env.STATE_DIR = stateDir;
writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({
  tts: { defaultEngine: 'remote', remote: { url: 'https://remote.test' } },
}));

const settings = await import('../src/settings.js');
await settings.load();
const remoteTts = await import('../src/audio/remoteTts.js');
const jingles = await import('../src/broadcast/jingles.js');

let rendered: Buffer = Buffer.from('not audio');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (String(input).endsWith('/health')) return Response.json({ ok: true });
  return new Response(rendered, { status: 200, headers: { 'content-type': 'audio/wav' } });
}) as typeof fetch;
await remoteTts.refresh();

test.after(() => {
  globalThis.fetch = realFetch;
  rmSync(stateDir, { recursive: true, force: true });
});

// framelog=verbose, not quiet: ffmpeg 5.1 (the controller image's) has no
// `quiet` level, fails, and still prints a summary of zeros.
function integratedLufs(file: string): number {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-']);
  assert.equal(out.status, 0, `ffmpeg could not measure ${file}: ${String(out.stderr).slice(-300)}`);
  const m = /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(String(out.stderr).slice(String(out.stderr).lastIndexOf('Summary:')));
  assert.ok(m, 'no loudness summary');
  return Number(m[1]);
}

test('a quiet render is brought up to the level uploads get', { skip: ffmpeg ? false : 'ffmpeg not installed' }, async () => {
  const quiet = path.join(stateDir, 'quiet.wav');
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
    '-af', 'volume=-14dB', '-ar', '44100', '-ac', '1', '-y', quiet]);
  assert.equal(made.status, 0, String(made.stderr));
  rendered = readFileSync(quiet);
  const before = integratedLufs(quiet);
  const { outPath } = await jingles.create('Station ident.');
  const after = integratedLufs(outPath);
  assert.ok(before < -30, `fixture should be quiet, was ${before}`);
  assert.ok(Math.abs(after - -16) < 2, `expected about -16 LUFS, got ${after}`);
});

test('a render ffmpeg cannot read is kept as it is', async () => {
  rendered = Buffer.from('not audio');
  const { outPath } = await jingles.create('Station ident.');
  assert.equal(readFileSync(outPath, 'utf8'), 'not audio');
});
