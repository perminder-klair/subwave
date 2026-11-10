import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir } from './test-utils/temp-dir.js';
import { listen } from './test-utils/http.js';
import {
  bothOverlayCount, overlayDue, overlayOffer, overlayOpening, overlayFits, overlayMixerStatus, type OverlayOffer,
} from '../src/broadcast/jingle-overlay.js';
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
const { renderSettingsSnapshot } = await import('../src/doctor/review.js');

const offer: OverlayOffer = {
  due: true, elapsedMs: 11_000, crossfadeMs: 10_000, headWindowMs: 3000,
  trackVoice: false, voiceBusy: false, pendingTalk: false, pendingJingle: false,
};
const counts = { ratio: 3, tracksSinceOverlay: 3, tracksSinceJingle: 0 };

test('between is the default and never offers an overlay; malformed load values preserve it', () => {
  for (const bad of [undefined, null, '', 'Over', false, 42, {}, []]) {
    assert.equal(jinglePlacement({ jinglePlacement: bad }), 'between');
  }
  for (let n = 0; n <= 6; n++) {
    assert.equal(overlayDue({ placement: 'between', ratio: 3, tracksSinceOverlay: n, tracksSinceJingle: n }), false);
  }
  assert.equal(overlayOffer({ ...offer, due: false }), 'skip');
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
  assert.equal(overlayDue({ placement: 'over', ...counts, ratio: 0 }), false);
  assert.equal(overlayDue({ placement: 'over', ...counts, tracksSinceOverlay: 2 }), false);
  assert.equal(overlayDue({ placement: 'over', ...counts }), true);
  assert.equal(overlayOffer({ ...offer, elapsedMs: 9000 }), 'wait');
  assert.equal(overlayOffer(offer), 'draw');
  assert.equal(overlayOffer({ ...offer, elapsedMs: 14_000 }), 'skip');
});

test('the opening window is one rule: shut inside the crossfade, open for the head window, then shut for good', () => {
  const at = (elapsedMs: number) => overlayOpening({ elapsedMs, crossfadeMs: 10_000, headWindowMs: 3000 });
  assert.equal(at(9999), 'early');
  assert.equal(at(10_000), 'open');
  assert.equal(at(13_000), 'open');
  assert.equal(at(13_001), 'closed');
});

test('in both, the overlay and the between-songs rotate never come due on the same song', () => {
  for (let ratio = 1; ratio <= 40; ratio++) {
    // The talk planner may hold a due rotate for a few songs before it draws.
    for (const delay of [0, 1, 3]) {
      let sinceJingle = 0;
      let overlaysThisCycle = 0;
      let waited = 0;
      let cycles = 0;
      for (let song = 0; cycles < 5; song++) {
        sinceJingle++; // onTrackStarted
        const rotate = rotateJingleDue({ owner: 'controller', placement: 'both', ratio, tracksSinceJingle: sinceJingle });
        const overlay = overlayDue({ placement: 'both', ratio, tracksSinceOverlay: song, tracksSinceJingle: sinceJingle });
        assert.ok(!(rotate && overlay), `ratio ${ratio}, delay ${delay}, song ${song}`);
        if (overlay) overlaysThisCycle++;
        if (rotate && waited++ >= delay) {
          // One overlay per between-songs ID, as the frequency promises; ratio 1 has no room.
          assert.equal(overlaysThisCycle, ratio >= 2 ? 1 : 0, `ratio ${ratio}, delay ${delay}, cycle ${cycles}`);
          overlaysThisCycle = 0; waited = 0; cycles++;
          sinceJingle = 0; // playRotateJingle
        }
      }
    }
  }
  // Halfway between two between-songs IDs, and never on the rotate's own song.
  assert.equal(bothOverlayCount(1), null);
  assert.equal(bothOverlayCount(2), 1);
  assert.equal(bothOverlayCount(30), 16);
  // `over` keeps its own count and ignores the rotate's.
  assert.equal(overlayDue({ placement: 'over', ratio: 4, tracksSinceOverlay: 4, tracksSinceJingle: 4 }), true);
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

test('doctor reports the effective jingle owner for each placement', () => {
  const previous = settings.get();
  try {
    for (const [placement, owner] of [['between', 'mixer'], ['over', 'controller'], ['both', 'controller']] as const) {
      setCache({ ...previous, jingleRotate: 'mixer', jinglePlacement: placement });
      assert.ok(renderSettingsSnapshot().includes(`jingle 1/${previous.jingleRatio} (${owner})`));
    }
  } finally {
    setCache(previous);
  }
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
const { pollVoiceMarker, resetVoiceMarkers } = await import('../src/broadcast/queue/voice-marker.js');
let sequence = 0;
function startSong(introKind?: string, elapsedMs = 10_100) {
  const id = `song-${++sequence}`;
  queue.upcoming = [{ track: { id, title: id, artist: 'Artist', duration: 180 }, sent: true,
    ...(introKind ? { introKind, introScript: 'Already aired', introAired: true } : {}) }];
  queue.onTrackStarted({ subsonic_id: id, title: id, artist: 'Artist', timestamp: (Date.now() - elapsedMs) / 1000 });
}
function reset() {
  handed = [];
  setCache({ ...settings.getDefaults(), jinglePlacement: 'over', jingleRatio: 1 });
  queue._tracksSinceOverlay = 0;
  queue._tracksSinceJingle = 0;
  queue._talkInFlight = 0;
  queue._pendingJingles.clear();
}
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

test('fit uses the current song exit stamp, independently of its incoming crossfade', async () => {
  const status = queue._overlayMixerStatus;
  try {
    for (const [incoming, stamp, remainingMs, expected] of [
      [0, 6, 7000, 0], [10, 0, 7000, 1], [10, undefined, 7000, 0], [10, undefined, 13000, 1],
    ] as const) {
      reset(); startSong(undefined, incoming * 1000 + 100);
      // A zero station setting can still have a positive adaptive exit stamp.
      setCache({ ...settings.get(), crossfadeDuration: 0 });
      queue.history[0].track.crossSec = incoming;
      queue.current!.track.crossSec = stamp;
      queue._overlayMixerStatus = async () => ({ remainingMs, crossfadeMs: incoming * 1000 });
      await queue.maybeAirJingleOverlay();
      assert.equal(handed.length, expected, `exit stamp ${stamp}, remaining ${remainingMs}`);
    }
  } finally { queue._overlayMixerStatus = status; }
});

test('in both, the queue offers its ID halfway to the rotate and never on the song the rotate is due', async () => {
  reset(); setCache({ ...settings.get(), jinglePlacement: 'both', jingleRatio: 4 });
  const offeredAt: number[] = [];
  for (let n = 1; n <= 8; n++) {
    const before = handed.length;
    startSong(); await queue.maybeAirJingleOverlay();
    const since = queue.rotateJingleTracksSince();
    const rotateDue = rotateJingleDue({ owner: 'controller', placement: 'both', ratio: 4, tracksSinceJingle: since });
    if (handed.length > before) offeredAt.push(since);
    assert.ok(!(rotateDue && handed.length > before), `song ${n}`);
    if (rotateDue) queue._tracksSinceJingle = 0; // the talk planner's draw (playRotateJingle)
  }
  assert.deepEqual(offeredAt, [3, 3]);
});

test('speech still being written or rendered keeps the song opening from an ID', async () => {
  // A scheduled fire, from the talk tick's wrapper, before it reaches announce().
  reset(); startSong();
  let finish!: () => void;
  const fire = queue.whileTalkInFlight(() => new Promise<void>(resolve => { finish = resolve; }));
  await queue.maybeAirJingleOverlay();
  assert.equal(handed.length, 0);
  finish(); await fire;
  assert.equal(queue._talkInFlight, 0);
  // A manual /dj/say outside the talk tick: announce() counts its own render.
  reset(); startSong();
  const speak = queue._speak;
  const air = queue._airVoice;
  let rendered!: (path: string) => void;
  queue._speak = (() => new Promise<string>(resolve => { rendered = resolve; })) as unknown as typeof queue._speak;
  queue._airVoice = (async () => ({ voiceId: 'dj', clipMs: 10, aired: Promise.resolve(null) })) as unknown as typeof airVoice;
  try {
    const said = queue.announce('Hello there', 'dj-speak');
    assert.equal(queue._talkInFlight, 1);
    await queue.maybeAirJingleOverlay();
    assert.equal(handed.length, 0);
    rendered(join(jingleDir, 'a.wav'));
    const outcome = await said;
    assert.equal(outcome.accepted, true);
    assert.equal(queue._talkInFlight, 0);
    await outcome.completed;
    await tick(50); // let its voice.end timer fire before the next test's hook exists
  } finally {
    queue._speak = speak;
    queue._airVoice = air;
  }
});

test('an overlay ID publishes no voice or DJ webhook, like a manual or rotate jingle', async () => {
  const received: { event: string; voiceId?: string; text?: string }[] = [];
  const hook = await listen((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        received.push({ event: body.event, voiceId: body.data?.voiceId ?? body.voiceId, text: body.data?.text ?? body.text });
      } catch { /* not ours */ }
      res.writeHead(200).end('ok');
    });
  });
  const fromOverlay = () => received.filter(r => r.voiceId === 'test' || /Station [AB]/.test(r.text ?? ''));
  try {
    reset();
    setCache({ ...settings.get(), webhooks: [{ id: 'overlay_hook', url: `${hook.url}/hook`,
      events: ['dj.say', 'dj.link', 'voice.queued', 'voice.start', 'voice.end'], enabled: true, authHeader: '' }] });
    startSong(); await queue.maybeAirJingleOverlay();
    assert.equal(handed.length, 1);
    assert.equal(queue.djLog[0]?.kind, 'jingle', 'the ID still gets its booth line');
    await tick(700);
    assert.equal(fromOverlay().length, 0, JSON.stringify(fromOverlay()));
    // The fixture does deliver: ordinary speech through the same bookkeeping arrives.
    await queue.onSpoken({ voiceId: 'control', clipMs: 10, aired: Promise.resolve(Date.now()) },
      { kind: 'link', channel: 'intro', text: 'Control line' });
    const control = () => received.filter(r => r.voiceId === 'control').map(r => r.event);
    for (let i = 0; i < 150 && !control().includes('dj.link'); i++) await tick(20);
    assert.ok(control().includes('voice.start') && control().includes('dj.link'), JSON.stringify(received));
  } finally {
    hook.server.closeAllConnections();
    await hook.close();
  }
});

test('a mixer that refuses an overlay frees the voice lock once the start is overdue, not after the clip', async () => {
  const long = join(jingleDir, 'long.wav');
  wav(long, 6);
  rmSync(config.liquidsoap.jinglePlayingFile, { force: true });
  rmSync(config.liquidsoap.introFile, { force: true });
  resetVoiceMarkers();
  const t0 = Date.now();
  const handoff = await airVoice(config.liquidsoap.introFile, long, 'ID', 0,
    { skipIfBusy: true, jingleOverlay: true, jingleOverlayTrackAt: t0 });
  assert.ok(handoff);
  rmSync(config.liquidsoap.introFile); // poll_intro consumed the file and dropped the ID
  assert.equal(voiceBusy(), true);
  while (voiceBusy() && Date.now() - t0 < 8000) await tick(50);
  const releasedAfter = Date.now() - t0;
  // The old hold was the whole clip plus lead-in and tail: 7.5s here.
  assert.ok(releasedAfter >= 3000 && releasedAfter < 4500, `released after ${releasedAfter}ms`);
  resetVoiceMarkers();
});

test('an accepted overlay holds the voice lock for its clip from the measured start', async () => {
  const clip = join(jingleDir, 'clip.wav');
  wav(clip, 4.5);
  rmSync(config.liquidsoap.jinglePlayingFile, { force: true });
  rmSync(config.liquidsoap.introFile, { force: true });
  resetVoiceMarkers();
  const t0 = Date.now();
  const handoff = await airVoice(config.liquidsoap.introFile, clip, 'ID', 0,
    { skipIfBusy: true, jingleOverlay: true, jingleOverlayTrackAt: t0 });
  const voiceId = readFileSync(config.liquidsoap.introFile, 'utf8').match(/subwave_voice="([^"\n]+)"/)?.[1];
  rmSync(config.liquidsoap.introFile);
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId, startedAt: Date.now() / 1000, channel: 'intro' }));
  pollVoiceMarker();
  assert.ok(await handoff!.aired);
  await tick(4200 - (Date.now() - t0));
  assert.equal(voiceBusy(), true, 'still inside the clip, past the start grace');
  while (voiceBusy() && Date.now() - t0 < 8000) await tick(50);
  const releasedAfter = Date.now() - t0;
  assert.ok(releasedAfter >= 5000 && releasedAfter < 6000, `released after ${releasedAfter}ms`);
  resetVoiceMarkers();
});

test('the first overlay waits for its first voice marker and earns post-air bookkeeping', async () => {
  reset(); startSong();
  resetVoiceMarkers();
  rmSync(config.liquidsoap.voicePlayingFile, { force: true });
  rmSync(config.liquidsoap.jinglePlayingFile, { force: true });
  const stub = queue._airVoice;
  const spoken = queue.onSpoken;
  let booked = 0;
  queue._airVoice = realAirVoice;
  queue.onSpoken = async (...args) => { booked++; return spoken.apply(queue, args); };
  const startedAt = Date.now() / 1000;
  // Simulate the mixer's first actual start AFTER consuming the handoff.
  const mixer = setInterval(() => {
    if (!existsSync(config.liquidsoap.introFile)) return;
    const uri = readFileSync(config.liquidsoap.introFile, 'utf8');
    const voiceId = uri.match(/subwave_voice="([^"\n]+)"/)?.[1];
    if (!voiceId) return;
    rmSync(config.liquidsoap.introFile);
    writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({ voiceId, startedAt, channel: 'intro' }));
    pollVoiceMarker();
    clearInterval(mixer);
  }, 40);
  try {
    await queue.maybeAirJingleOverlay();
    assert.equal(booked, 1, 'the first ID must be recorded after its measured start');
    assert.equal(queue.djLog[0]?.kind, 'jingle');
  } finally {
    clearInterval(mixer);
    queue._airVoice = stub;
    queue.onSpoken = spoken;
    resetVoiceMarkers();
    rmSync(config.liquidsoap.introFile, { force: true });
    await new Promise(resolve => setTimeout(resolve, 1600));
  }
});
