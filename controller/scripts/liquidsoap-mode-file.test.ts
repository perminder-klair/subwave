// The two handoff files spotify mode adds to the liquidsoap_*.txt family:
// liquidsoap_music_mode.txt ('files' | 'spotify', read by radio.liq once at
// startup) and liquidsoap_spotify.txt (KEY=value lines read by
// docker/spotify/librespot-run.sh). Both ride writeLiquidsoapSettings, so a
// save writes them and ensureLiquidsoapSettingsFile creates them at boot.
//
// Pinned: an absent/default settings file writes 'files' (byte-identical
// mixer), 'spotify' when selected, a source switch flags requiresRestart while
// an unrelated save does not, and the wrapper's file is well-formed even for a
// device name carrying the characters that would break its line format.
//
// Run: npm test -- liquidsoap-mode-file

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-liq-mode-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const liq = await import('../src/settings/liquidsoap.js');

const read = (p: string) => readFileSync(p, 'utf8');

async function coldLoad(body: Record<string, unknown>) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify(body));
  setCache(null);
  await settings.load();
}

test('a default station writes mode "files" and a sane librespot handoff', async () => {
  await coldLoad({ station: 'Night Signal' });
  await liq.writeLiquidsoapSettings(settings.get());
  assert.equal(read(liq.LIQ_MUSIC_MODE_PATH), 'files');
  assert.equal(read(liq.LIQ_SPOTIFY_PATH), 'device_name=SUB/WAVE\nbitrate=320\n', 'the receiver name is a CONSTANT, never the station name — a rename must not orphan a running receiver');
});

test('selecting spotify writes mode "spotify" and the configured receiver flags', async () => {
  await coldLoad({ music: { source: 'spotify' }, spotify: { deviceName: 'Booth = A\nB', bitrate: 160 } });
  await liq.writeLiquidsoapSettings(settings.get());
  assert.equal(read(liq.LIQ_MUSIC_MODE_PATH), 'spotify');
  const lines = read(liq.LIQ_SPOTIFY_PATH).trimEnd().split('\n');
  assert.deepEqual(lines, ['device_name=Booth A B', 'bitrate=160'], 'newlines and = are folded so the KEY=value grammar survives');
});

test('pure helpers agree with the files', () => {
  assert.equal(liq.musicModeFor(undefined), 'files');
  assert.equal(liq.musicModeFor({ music: { source: 'subsonic' } }), 'files');
  assert.equal(liq.musicModeFor({ music: { source: 'spotify' } }), 'spotify');
  assert.equal(liq.spotifyHandoffFor({ spotify: { bitrate: 999 }, station: 'X' }), 'device_name=SUB/WAVE\nbitrate=320\n', 'an invalid bitrate falls back; the station name is never used');
});

test('a source switch requires a mixer restart; an unrelated save does not', async () => {
  await coldLoad({});
  const same = await settings.update({ music: { source: 'subsonic' } });
  assert.equal(same.requiresRestart, false, 'no change, no restart');
  const sw = await settings.update({ music: { source: 'spotify' } });
  assert.equal(sw.requiresRestart, true);
  assert.equal(read(liq.LIQ_MUSIC_MODE_PATH), 'spotify', 'update() wrote the handoff');
  const other = await settings.update({ spotify: { mismatch: 'follow' } });
  assert.equal(other.requiresRestart, false, 'a catalog knob is not a launch flag');
  const dev = await settings.update({ spotify: { deviceName: 'Kitchen' } });
  assert.equal(dev.requiresRestart, true, 'the receiver name is a librespot launch flag');
  assert.match(read(liq.LIQ_SPOTIFY_PATH), /^device_name=Kitchen\n/);
});
