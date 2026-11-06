// A hosted plan's stream bitrate ceiling (SUBWAVE_MAX_BITRATE, setup/hosted.ts)
// at the places it reaches past a save:
//   - settings/liquidsoap.ts writes the CAPPED values into the liquidsoap_*
//     files the mixer, broadcast-entrypoint.sh and the AIO supervisor read, so
//     a value saved before the plan changed can't exceed it; the owner's stored
//     settings stay as they were, and the archive recording isn't capped;
//   - BOOT (settings.ensureLiquidsoapSettingsFile, which server.ts calls)
//     rewrites those mount files when the plan changed with no save: a
//     downgrade or an upgrade is an env change, and files already on disk
//     otherwise kept the old plan until some unrelated save. The jingle ratio
//     keeps its only-if-missing rule;
//   - /listen.pls, /listen.m3u, /now-playing's *Enabled flags and the admin
//     Connect catalog (one advertisedMounts) never offer a mount the ceiling
//     switched off.
// Self-hosted (SUBWAVE_HOSTED unset) is untouched by any of them.
//
// Run: `npm test -- hosted-bitrate`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { listen as listenHttp } from './test-utils/http.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-hosted-bitrate-'));
process.env.STATE_DIR = stateDir;
delete process.env.SITE_URL;
delete process.env.SUBWAVE_HOSTED;
delete process.env.SUBWAVE_MAX_BITRATE;
// requireAdmin is a no-op with these unset, so the Connect router mounts bare.
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { writeLiquidsoapSettings } = await import('../src/settings/liquidsoap.js');
const { router } = await import('../src/routes/public.js');
const { router: connect } = await import('../src/routes/connect.js');
await settings.load();
// Everything a 192 kbps plan must not air, saved before the ceiling existed.
await settings.update({
  stream: { bitrate: 320, opusEnabled: true, opusBitrate: 320, aacEnabled: true, aacBitrate: 256, flacEnabled: true },
  archive: { enabled: true, bitrate: 320 },
});

const app = express();
app.use(router);
app.use(connect);
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

// The files a boot reconciles, as liq() reads them, and the stored values the
// station saved before any ceiling existed.
const mountFiles = () => ['stream_bitrate', 'opus_bitrate', 'aac_bitrate', 'aac_enabled', 'flac_enabled', 'opus_enabled'].map(liq);
const storedStream = () => JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8')).stream;

test('boot brings the mount files to a plan downgrade and back on an upgrade, without a save', async () => {
  // Where a station stands before the plan changes: files written by its last
  // save, at 320 and FLAC on, and a jingle ratio the running mixer read.
  await settings.update({ stream: { bitrate: 320 } });
  assert.deepEqual(mountFiles(), ['320', '320', '256', 'true', 'true', 'true']);
  const ratioPath = join(stateDir, 'liquidsoap_jingle_ratio.txt');
  writeFileSync(ratioPath, '7');
  const before = storedStream();

  // Downgrade: the box agent restarts the controller with a 192 ceiling.
  const down = await withCeiling('192', () => settings.ensureLiquidsoapSettingsFile());
  assert.deepEqual(mountFiles(), ['192', '192', '192', 'true', 'false', 'true']);
  assert.deepEqual(down.rewroteMountFiles.sort(), [
    'liquidsoap_aac_bitrate.txt', 'liquidsoap_flac_enabled.txt', 'liquidsoap_opus_bitrate.txt', 'liquidsoap_stream_bitrate.txt',
  ]);
  // A second boot on the same plan has nothing to rewrite.
  assert.deepEqual((await withCeiling('192', () => settings.ensureLiquidsoapSettingsFile())).rewroteMountFiles, []);

  // Down to 96: AAC's lowest is 128, so its mount goes off (its bitrate file
  // keeps the saved value, which nothing reads while the mount is off).
  await withCeiling('96', () => settings.ensureLiquidsoapSettingsFile());
  assert.deepEqual(mountFiles(), ['96', '96', '256', 'false', 'false', 'true']);

  // Upgrade to a 320 plan: the saved values fit again; FLAC stays off under any ceiling.
  await withCeiling('320', () => settings.ensureLiquidsoapSettingsFile());
  assert.deepEqual(mountFiles(), ['320', '320', '256', 'true', 'false', 'true']);

  // A plan with no ceiling (and self-hosted alike): everything saved, FLAC back on.
  const up = await withCeiling(null, () => settings.ensureLiquidsoapSettingsFile());
  assert.deepEqual(mountFiles(), ['320', '320', '256', 'true', 'true', 'true']);
  assert.deepEqual(up.rewroteMountFiles, ['liquidsoap_flac_enabled.txt']);

  // Neither direction saved anything, nor touched the jingle ratio.
  assert.deepEqual(storedStream(), before);
  assert.equal(readFileSync(ratioPath, 'utf8'), '7');
});

test('server.ts runs that boot path', () => {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(src, /await settings\.ensureLiquidsoapSettingsFile\(\)/);
});

test('the admin Connect catalog lists only the mounts the ceiling leaves on', async () => {
  const flac = async () => ((await (await fetch(`${base}/connect/catalog`)).json()) as any).streamMounts
    .find((m: any) => m.mount === '/stream.flac').enabled;
  assert.equal(await withCeiling('192', flac), false);
  assert.equal(await flac(), true);
});
