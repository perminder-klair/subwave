// settings.stream.hlsEnabled — the switch, its persistence and its handoff to
// the mixer.
// Run: npm test -- hls-settings
//
// Three things are pinned, each for a reason the obvious test would miss:
//
//  1. A COLD-LOAD round trip. load()'s stream block composes explicitly rather
//     than spreading DEFAULTS, so a key update() happily writes to settings.json
//     can still vanish on the next restart (#1317, #1327). An in-process
//     assertion passes on that bug.
//  2. OFF is the default, and an install that never saved the key writes the
//     same mixer handoff as one that explicitly turned it off — upgrading must
//     not start four new encoders.
//  3. The stream password WINS: a locked station hands the mixer "false" even
//     with the switch on, because HLS is static files Icecast's URL auth never
//     sees (broadcast/hls-policy.ts).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-hls-settings-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { hlsActive, hlsBlockedReason } = await import('../src/broadcast/hls-policy.js');
const { writeLiquidsoapSettings, LIQ_HLS_ENABLED_PATH } = await import('../src/settings/liquidsoap.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(stored: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(stored));
  setCache(null);
  await settings.load();
  return settings.get();
}

async function handoff(): Promise<string> {
  await writeLiquidsoapSettings(settings.get());
  return readFileSync(LIQ_HLS_ENABLED_PATH, 'utf8');
}

test('absent means off, and the mixer is told off', async () => {
  const s = await coldLoad({});
  assert.equal(s.stream.hlsEnabled, false);
  assert.equal(hlsActive(s), false);
  assert.equal(await handoff(), 'false');
});

test('a malformed value reads as absent', async () => {
  const s = await coldLoad({ stream: { hlsEnabled: 'yes please' } });
  assert.equal(s.stream.hlsEnabled, false);
});

test('switched on survives a controller restart and reaches the mixer', async () => {
  await coldLoad({});
  const r = await settings.update({ stream: { hlsEnabled: true } });
  assert.equal(r.saved.stream.hlsEnabled, true);
  assert.equal(r.requiresRestart, true, 'the mixer reads the handoff once, at startup');

  const s = await coldLoad(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')));
  assert.equal(s.stream.hlsEnabled, true, 'dropped by load() — the #1327 class of bug');
  assert.equal(hlsActive(s), true);
  assert.equal(await handoff(), 'true');
});

test('saving the same value again is not a restart', async () => {
  await coldLoad({ stream: { hlsEnabled: true } });
  const r = await settings.update({ stream: { hlsEnabled: true } });
  assert.equal(r.requiresRestart, false);
});

test('the other stream mounts are untouched by the switch', async () => {
  await coldLoad({ stream: { aacEnabled: true, aacBitrate: 256, opusEnabled: true } });
  const r = await settings.update({ stream: { hlsEnabled: true } });
  assert.equal(r.saved.stream.aacEnabled, true);
  assert.equal(r.saved.stream.aacBitrate, 256);
  assert.equal(r.saved.stream.opusEnabled, true);
});

test('the stream password holds HLS back, with the reason stated', async () => {
  const s = await coldLoad({
    stream: { hlsEnabled: true },
    privacy: { listenerAuth: true, password: 'hunter22' },
  });
  assert.equal(s.stream.hlsEnabled, true, 'the operator\'s choice is kept');
  assert.equal(hlsActive(s), false, 'but not acted on');
  assert.match(hlsBlockedReason(s) ?? '', /stream password/);
  assert.equal(await handoff(), 'false', 'a locked station must not publish HLS');
});

test('boot writes the HLS handoff when a state dir predates it', async () => {
  // Every older handoff is present, this one is not, and settings.json already
  // says on (a state dir from before HLS with the key added by hand or by a
  // file-level restore). Without the sentinel the mixer would stay off while
  // the controller reports HLS active.
  const { existsSync, unlinkSync } = await import('node:fs');
  await coldLoad({ stream: { hlsEnabled: true } });
  await writeLiquidsoapSettings(settings.get());
  unlinkSync(LIQ_HLS_ENABLED_PATH);
  assert.equal(existsSync(LIQ_HLS_ENABLED_PATH), false);
  await settings.ensureLiquidsoapSettingsFile();
  assert.equal(readFileSync(LIQ_HLS_ENABLED_PATH, 'utf8'), 'true');
});

test('the policy is pure and total', () => {
  assert.equal(hlsActive(null), false);
  assert.equal(hlsActive(undefined), false);
  assert.equal(hlsActive({}), false);
  assert.equal(hlsActive({ stream: { hlsEnabled: 'true' } }), false, 'only a real boolean enables');
  assert.equal(hlsActive({ stream: { hlsEnabled: true } }), true);
  assert.equal(hlsActive({ stream: { hlsEnabled: true }, privacy: { listenerAuth: false } }), true);
  assert.equal(hlsBlockedReason({ stream: { hlsEnabled: false }, privacy: { listenerAuth: true } }), null,
    'nothing is held back when HLS was never asked for');
});

test.after(() => {
  setCache(null);
  rmSync(stateRoot, { recursive: true, force: true });
});
