import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';
import { overlayOffer, overlayFits, overlayMixerStatus, type OverlayOffer } from '../src/broadcast/jingle-overlay.js';
import { jinglePlacement, jingleRotateOwner, mixerJingleRatioFile, rotateJingleDue } from '../src/broadcast/jingle-rotate.js';
import { jinglePlacementSchema } from '../src/schemas/settings.js';

const STATE = createTempDir(join(tmpdir(), 'subwave-jingle-overlay-'));
process.env.STATE_DIR = STATE;
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
process.env.LIQUIDSOAP_PORT = '1'; // no live mixer; this suite owns only HTTP fixtures
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { validateSettingsPatch } = await import('../src/settings/patch-registry.js');
const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
const { airVoice, voiceBusy, jingleWindow, interposedSince } = await import('../src/broadcast/queue/voice-io.js');

const offer: OverlayOffer = {
  placement: 'over', ratio: 3, tracksSinceOverlay: 3,
  elapsedMs: 11_000, crossfadeMs: 10_000, headWindowMs: 3000,
  trackVoice: false, voiceBusy: false, pendingTalk: false, pendingJingle: false,
};

test('between is the default and never offers an overlay; malformed load values preserve it', () => {
  for (const bad of [undefined, null, '', 'Over', false, 42, {}, []]) {
    assert.equal(jinglePlacement({ jinglePlacement: bad }), 'between');
  }
  assert.equal(overlayOffer({ ...offer, placement: 'between' }), 'skip');
  assert.equal(jinglePlacementSchema.safeParse('Over').success, false);
  assert.ok(validateSettingsPatch({ jinglePlacement: 'Over' }));
  assert.equal(validateSettingsPatch({ jinglePlacement: 'over' }), null);
});

test('DJ links, solo voices, a busy voice chain and pending speech/jingles each skip the song', () => {
  for (const key of ['trackVoice', 'voiceBusy', 'pendingTalk', 'pendingJingle'] as const) {
    assert.equal(overlayOffer({ ...offer, [key]: true }), 'skip', key);
  }
});

test('frequency 0 is off; every Nth song gets one offer after its crossfade, never mid-song', () => {
  assert.equal(overlayOffer({ ...offer, ratio: 0 }), 'skip');
  assert.equal(overlayOffer({ ...offer, tracksSinceOverlay: 2 }), 'skip');
  assert.equal(overlayOffer({ ...offer, elapsedMs: 9000 }), 'wait');
  assert.equal(overlayOffer(offer), 'draw');
  assert.equal(overlayOffer({ ...offer, elapsedMs: 14_000 }), 'skip');
});

test('a short/capped song or an ID past the measured vocal onset has no room', () => {
  const room = { elapsedMs: 11_000, windowMs: 9000, remainingMs: 100_000, exitCrossfadeMs: 10_000, runwayMs: null };
  assert.equal(overlayFits(room), true);
  assert.equal(overlayFits({ ...room, remainingMs: null }), false);
  assert.equal(overlayFits({ ...room, remainingMs: 19_000 }), false);
  assert.equal(overlayFits({ ...room, windowMs: 0 }), false);
  assert.equal(overlayFits({ ...room, runwayMs: 19_000 }), false);
  assert.equal(overlayFits({ ...room, runwayMs: 20_000 }), true);
  assert.equal(overlayFits({ ...room, runwayMs: Infinity }), true);
  // No long-segment exception: this optional 30s ID must still fit.
  assert.equal(overlayFits({ ...room, windowMs: 30_000, runwayMs: 20_000 }), false);
});

test('over disables every between-song draw; both shares controller ownership and repeat memory', () => {
  for (const placement of ['over', 'both'] as const) {
    const s = { jingleRatio: 3, jingleRotate: 'mixer', jinglePlacement: placement };
    assert.equal(jingleRotateOwner(s), 'controller');
    assert.equal(mixerJingleRatioFile(s), '0');
    assert.equal(rotateJingleDue({ owner: jingleRotateOwner(s), placement, ratio: 3, tracksSinceJingle: 3 }), placement === 'both');
  }
  assert.equal(mixerJingleRatioFile({ jingleRatio: 30 }), '30');
});

test('cold-load round trips and restart receipts cover every placement without overwriting the preferred owner', async () => {
  setCache(null);
  assert.equal((await settings.load()).jinglePlacement, 'between');
  for (const placement of ['over', 'both', 'between']) {
    assert.equal((await settings.update({ jinglePlacement: placement })).requiresRestart, true);
    setCache(null);
    const loaded = await settings.load();
    assert.equal(loaded.jinglePlacement, placement);
    assert.equal(loaded.jingleRotate, 'mixer');
    assert.equal(readFileSync(join(STATE, 'liquidsoap_jingle_ratio.txt'), 'utf8'), placement === 'between' ? '30' : '0');
    assert.equal((await settings.update({ jinglePlacement: placement })).requiresRestart, false);
  }
  const path = join(STATE, 'settings.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), jinglePlacement: 'typo' }));
  setCache(null);
  assert.equal((await settings.load()).jinglePlacement, 'between');
});

test('entering overlay mode starts a clean N-track cycle even when the controller already owned between-song rotation', async () => {
  await settings.update({ jingleRotate: 'controller', jinglePlacement: 'between' });
  queue._tracksSinceOverlay = 200;
  await settings.update({ jinglePlacement: 'over' });
  assert.equal(queue._tracksSinceOverlay, 0);
  queue._tracksSinceOverlay = 2;
  await settings.update({ stationDescription: 'An unrelated settings save' });
  assert.equal(queue._tracksSinceOverlay, 2);
  await settings.update({ jingleRotate: 'mixer', jinglePlacement: 'between' });
});

test('mixer proof fails closed for busy/old/unrestarted mixers and unknown duration', () => {
  const safe = { safe: true, mixerRatio: 0, remainingSeconds: 100, crossfadeSeconds: 10 };
  assert.deepEqual(overlayMixerStatus(JSON.stringify(safe)), { remainingMs: 100_000, crossfadeMs: 10_000 });
  for (const bad of ['unknown command', '{}', 'null', JSON.stringify({ ...safe, safe: false }),
    JSON.stringify({ ...safe, mixerRatio: 3 }), JSON.stringify({ ...safe, remainingSeconds: -1 }),
    JSON.stringify({ ...safe, crossfadeSeconds: null })]) {
    assert.equal(overlayMixerStatus(bad), null);
  }
});

test('the actual settings HTTP surface publishes each saved placement and its restart receipt', async () => {
  const { default: express } = await import('express');
  const { router } = await import('../src/routes/settings/core.js');
  const app = express(); app.use(express.json()); app.use(router);
  const fixture = await listen(app);
  const base = fixture.url;
  try {
    for (const placement of ['over', 'both', 'between']) {
      const post = await fetch(`${base}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jinglePlacement: placement }) });
      assert.equal(post.status, 200);
      assert.equal((await post.json() as { requiresRestart: boolean }).requiresRestart, true);
      const read = await fetch(`${base}/settings`);
      assert.equal(read.status, 200);
      assert.equal((await read.json() as { values: { jinglePlacement: string } }).values.jinglePlacement, placement);
    }
  } finally {
    await fixture.close();
  }
});

// The real queue boundary + the real jingle store; no backend or mixer needed.
const jingleDir = join(STATE, 'jingles');
mkdirSync(jingleDir, { recursive: true });
function wav(path: string, seconds = 0.01) {
  const len = Math.round(seconds * 8000 * 2);
  const b = Buffer.alloc(44 + len);
  b.write('RIFF'); b.writeUInt32LE(36 + len, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(len, 40);
  writeFileSync(path, b);
}
for (const f of ['a.wav', 'b.wav']) wav(join(jingleDir, f));
writeFileSync(join(STATE, 'jingles.json'), JSON.stringify({ items: {
  'a.wav': { text: 'Station A' }, 'b.wav': { text: 'Station B' },
} }));
const realAirVoice = queue._airVoice;
const realAirIntro = queue.airIntro;
const realPending = queue.airPendingVoice;
const realMixerStatus = queue._overlayMixerStatus;
queue.autoPick = false;
queue.pickerBusy = true; // keep the test boundary out of picker/coast side effects
queue.airIntro = async () => {};
queue.airPendingVoice = async () => {};
let handed: string[] = [];
queue._airVoice = (async (_file, path, _text, _gain, opts) => {
  if (opts?.beforeWrite && !opts.beforeWrite()) return null;
  assert.equal(_file, config.liquidsoap.introFile);
  assert.equal(opts?.skipIfBusy, true);
  assert.equal(opts?.jingleOverlay, true);
  assert.ok(opts?.jingleOverlayTrackAt);
  handed.push(path);
  return { voiceId: 'test', clipMs: 10, aired: Promise.resolve(Date.now()) };
}) as typeof airVoice;
queue._overlayMixerStatus = async () => ({ remainingMs: 100_000, crossfadeMs: 10_000 });
let sequence = 0;
function startSong(introKind?: string) {
  const id = `song-${++sequence}`;
  queue.upcoming = [{ track: { id, title: id, artist: 'Artist', duration: 180 }, sent: true,
    ...(introKind ? { introKind, introScript: 'Already aired', introAired: true } : {}) }];
  queue.onTrackStarted({ subsonic_id: id, title: id, artist: 'Artist', timestamp: Date.now() / 1000 - 10.1 });
}
function reset() {
  handed = [];
  setCache({ ...settings.getDefaults(), jinglePlacement: 'over', jingleRatio: 1 });
  queue._tracksSinceOverlay = 0;
  queue._pendingJingles.clear();
}
after(async () => {
  queue._airVoice = realAirVoice;
  queue.airIntro = realAirIntro;
  queue.airPendingVoice = realPending;
  queue._overlayMixerStatus = realMixerStatus;
  const db = await import('../src/music/library-db.js'); db.close();
});

test('a consumed DJ link or solo intro protects the entire song', async () => {
  reset();
  for (const kind of ['link', 'dj-speak']) {
    startSong(kind);
    assert.equal(existsSync(config.liquidsoap.introFile), false);
    await queue.maybeAirJingleOverlay();
  }
  assert.equal(handed.length, 0);
});

test('speech queued after the boundary still protects the song after its file disappears', async () => {
  reset(); startSong();
  queue.onQueued({ voiceId: 'other', clipMs: 100, estimatedAirInMs: 1000 }, { kind: 'weather', channel: 'say', text: 'Forecast' });
  await queue.maybeAirJingleOverlay();
  assert.equal(handed.length, 0);
});

test('the queue honours N tracks, uses the same pool without immediate repeats, and never retries an offer', async () => {
  reset(); setCache({ ...settings.get(), jingleRatio: 2 });
  for (let n = 1; n <= 4; n++) {
    startSong(); await queue.maybeAirJingleOverlay(); await queue.maybeAirJingleOverlay();
    assert.equal(handed.length, Math.floor(n / 2));
  }
  assert.notEqual(handed[0], handed[1]);
});

test('a manual press or unsafe mixer skips the due offer, and a later voice cancels before publication', async () => {
  reset(); startSong();
  queue._pendingJingles.set('manual.wav', { at: Date.now(), rotate: false });
  await queue.maybeAirJingleOverlay();
  assert.equal(handed.length, 0);
  reset(); startSong();
  queue._overlayMixerStatus = async () => null;
  await queue.maybeAirJingleOverlay();
  assert.equal(handed.length, 0);
  reset(); startSong();
  queue._overlayMixerStatus = async () => {
    queue.onQueued({ voiceId: 'race', clipMs: 10, estimatedAirInMs: 0 }, { kind: 'hourly', channel: 'say', text: 'Time' });
    return { remainingMs: 100_000, crossfadeMs: 10_000 };
  };
  await queue.maybeAirJingleOverlay();
  assert.equal(handed.length, 0);
  queue._overlayMixerStatus = async () => ({ remainingMs: 100_000, crossfadeMs: 10_000 });
});

test('the real shared voice lock remains busy after consumption and rejects an overlay without queueing', async () => {
  const path = join(jingleDir, 'a.wav');
  await airVoice(config.liquidsoap.sayFile, path, 'Speech');
  rmSync(config.liquidsoap.sayFile);
  assert.equal(voiceBusy(), true);
  assert.equal(await airVoice(config.liquidsoap.introFile, path, 'ID', 0, { skipIfBusy: true }), null);
  assert.equal(existsSync(config.liquidsoap.introFile), false);
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(voiceBusy(), false);
  assert.equal(await airVoice(config.liquidsoap.introFile, path, 'ID', 0, { skipIfBusy: true, beforeWrite: () => false }), null);
  assert.equal(existsSync(config.liquidsoap.introFile), false);
});

test('an overlay marker holds speech for its actual clip and never labels the music seam', () => {
  const now = Date.now();
  writeFileSync(config.liquidsoap.jinglePlayingFile, JSON.stringify({ filename: join(jingleDir, 'a.wav'),
    placement: 'over', startedAt: now / 1000, durationSec: 6 }));
  assert.equal(jingleWindow().windowMs, 7000);
  assert.equal(interposedSince(now - 20_000, now + 1), null);
});
