import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-ogg-metadata-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { writeLiquidsoapSettings } = await import('../src/settings/liquidsoap.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');
const HANDOFF_PATH = path.join(stateRoot, 'liquidsoap_ogg_icy_metadata.txt');
const RADIO_PATH = new URL('../../liquidsoap/radio.liq', import.meta.url);

async function coldLoad(oggIcyMetadata: unknown, present = true) {
  const stream = present ? { oggIcyMetadata } : {};
  writeFileSync(SETTINGS_PATH, JSON.stringify({ stream }));
  setCache(null);
  await settings.load();
  return settings.get();
}

function outputBlock(source: string, id: string) {
  const start = source.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `${id} output must exist`);
  const end = source.indexOf('mount="/stream.', start);
  assert.notEqual(end, -1, `${id} output must declare its mount`);
  return source.slice(start, end);
}

test('the legacy setting still cold-loads and writes true, false, and the default unchanged', async () => {
  for (const [stored, expected, present] of [
    [true, true, true],
    [false, false, true],
    [undefined, DEFAULTS.stream.oggIcyMetadata, false],
    ['stale', DEFAULTS.stream.oggIcyMetadata, true],
  ] as const) {
    const loaded = await coldLoad(stored, present);
    assert.equal(loaded.stream.oggIcyMetadata, expected);
    await writeLiquidsoapSettings(loaded);
    assert.equal(readFileSync(HANDOFF_PATH, 'utf8'), expected ? 'true' : 'false');
  }
});

test('updating the legacy setting round-trips without migration', async () => {
  await coldLoad(undefined, false);
  await settings.update({ stream: { oggIcyMetadata: false } });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().stream.oggIcyMetadata, false);

  await settings.update({ stream: { oggIcyMetadata: true } });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().stream.oggIcyMetadata, true);
});

test('FLAC always uses native Ogg metadata while the legacy toggle remains Opus-only', () => {
  const source = readFileSync(RADIO_PATH, 'utf8');
  const opus = outputBlock(source, 'stream_opus');
  const flac = outputBlock(source, 'stream_flac');
  const mp3 = outputBlock(source, 'stream_mp3');
  const aac = outputBlock(source, 'stream_aac');

  assert.match(opus, /send_icy_metadata=ogg_icy_metadata\(\)/);
  assert.match(flac, /send_icy_metadata=false/);
  assert.doesNotMatch(flac, /send_icy_metadata=ogg_icy_metadata\(\)/);
  assert.doesNotMatch(mp3, /send_icy_metadata=/);
  assert.doesNotMatch(aac, /send_icy_metadata=/);

  // A saved or stale startup-file true can still control Opus, but cannot reach
  // the literal FLAC policy above.
  assert.match(source, /ogg_icy_metadata := \(raw != "false"\)/);
});
