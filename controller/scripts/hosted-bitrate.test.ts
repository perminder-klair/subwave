// A hosted plan's stream bitrate ceiling (SUBWAVE_MAX_BITRATE, setup/hosted.ts)
// at the two places it reaches past a save:
//   - settings/liquidsoap.ts writes the CAPPED values into the liquidsoap_*
//     files the mixer, broadcast-entrypoint.sh and the AIO supervisor read, so
//     a value saved before the plan changed can't exceed it; the owner's stored
//     settings stay as they were, and the archive recording isn't capped;
//   - /listen.pls and /listen.m3u (and /now-playing's *Enabled flags, through
//     the same advertisedMounts) never offer a mount the ceiling switched off.
// Self-hosted (SUBWAVE_HOSTED unset) is untouched by either.
//
// Run: `npm test -- hosted-bitrate`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { listen as listenHttp } from './test-utils/http.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-hosted-bitrate-'));
process.env.STATE_DIR = stateDir;
delete process.env.SITE_URL;
delete process.env.SUBWAVE_HOSTED;
delete process.env.SUBWAVE_MAX_BITRATE;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { writeLiquidsoapSettings } = await import('../src/settings/liquidsoap.js');
const { router } = await import('../src/routes/public.js');
await settings.load();
// Everything a 192 kbps plan must not air, saved before the ceiling existed.
await settings.update({
  stream: { bitrate: 320, opusEnabled: true, opusBitrate: 320, aacEnabled: true, aacBitrate: 256, flacEnabled: true },
  archive: { enabled: true, bitrate: 320 },
});

const app = express();
app.use(router);
const { server, url: base } = await listenHttp(app);
after(() => server.close());

const liq = (name: string) => readFileSync(join(stateDir, `liquidsoap_${name}.txt`), 'utf8').trim();

function withCeiling<T>(kbps: string | null, fn: () => Promise<T>): Promise<T> {
  process.env.SUBWAVE_HOSTED = '1';
  if (kbps === null) delete process.env.SUBWAVE_MAX_BITRATE;
  else process.env.SUBWAVE_MAX_BITRATE = kbps;
  return fn().finally(() => {
    delete process.env.SUBWAVE_HOSTED;
    delete process.env.SUBWAVE_MAX_BITRATE;
  });
}

test('the mixer files are capped under a hosted ceiling; the stored settings and the archive are not', async () => {
  await withCeiling('192', () => writeLiquidsoapSettings(settings.get()));
  assert.equal(liq('stream_bitrate'), '192');
  assert.equal(liq('opus_bitrate'), '192');
  assert.equal(liq('aac_bitrate'), '192');
  assert.equal(liq('flac_enabled'), 'false');
  assert.equal(liq('aac_enabled'), 'true');
  assert.equal(liq('archive_bitrate'), '320');
  const s = settings.get().stream;
  assert.deepEqual([s.bitrate, s.opusBitrate, s.aacBitrate, s.flacEnabled], [320, 320, 256, true]);
});

test('below AAC\'s floor the AAC mount is switched off', async () => {
  await withCeiling('96', () => writeLiquidsoapSettings(settings.get()));
  assert.equal(liq('aac_enabled'), 'false');
  assert.equal(liq('stream_bitrate'), '96');
});

test('self-hosted, or hosted with no ceiling: the saved values reach the mixer', async () => {
  for (const run of [() => writeLiquidsoapSettings(settings.get()), () => withCeiling(null, () => writeLiquidsoapSettings(settings.get()))]) {
    await run();
    assert.equal(liq('stream_bitrate'), '320');
    assert.equal(liq('opus_bitrate'), '320');
    assert.equal(liq('flac_enabled'), 'true');
  }
});

for (const file of ['/listen.pls', '/listen.m3u']) {
  test(`${file}: no FLAC under a ceiling, nor AAC below its floor; all mounts self-hosted`, async () => {
    const get = async () => (await fetch(`${base}${file}`)).text();
    const capped = await withCeiling('192', get);
    assert.match(capped, /\/stream\.mp3/);
    assert.match(capped, /\/stream\.opus/);
    assert.match(capped, /\/stream\.aac/);
    assert.doesNotMatch(capped, /\/stream\.flac/);
    assert.doesNotMatch(await withCeiling('96', get), /\/stream\.aac/);
    const own = await get();
    assert.match(own, /\/stream\.flac/);
    assert.match(own, /\/stream\.aac/);
  });
}
