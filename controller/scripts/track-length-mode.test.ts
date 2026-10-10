import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-ceiling-mode-'));
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { validateSettingsPatch } = await import('../src/settings/patch-registry.js');

test('mode resolves once with legacy defaults and unchanged show precedence', () => {
  for (const mode of [undefined, 'invalid', 'cut']) {
    assert.deepEqual(settings.effectiveTrackLengthLimits(null, { maxTrackSeconds: 1200, maxTrackLengthMode: mode }), { selectionMaxSec: null, playbackMaxSec: 1200 });
  }
  const s = { maxTrackSeconds: 1200, maxTrackLengthMode: 'exclude' };
  assert.deepEqual(settings.effectiveTrackLengthLimits({ maxTrackSeconds: null }, s), { selectionMaxSec: 1200, playbackMaxSec: null });
  assert.deepEqual(settings.effectiveTrackLengthLimits({ maxTrackSeconds: 900 }, s), { selectionMaxSec: 900, playbackMaxSec: null });
  assert.deepEqual(settings.effectiveTrackLengthLimits({ maxTrackSeconds: 0 }, s), { selectionMaxSec: null, playbackMaxSec: null });
});

test('mode saves, cold loads, repairs malformed storage and rejects invalid patches', async () => {
  writeFileSync(join(process.env.STATE_DIR!, 'settings.json'), JSON.stringify({ maxTrackLengthMode: 'garbage' }));
  setCache(null);
  await settings.load();
  assert.equal(settings.get().maxTrackLengthMode, 'cut');
  await settings.update({ maxTrackLengthMode: 'exclude' });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().maxTrackLengthMode, 'exclude');
  await assert.rejects(settings.update({ maxTrackLengthMode: 'garbage' }));
  assert.ok(validateSettingsPatch({ maxTrackLengthMode: 'garbage' })?.fieldErrors.maxTrackLengthMode);
});

const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { buildShowCandidateDiagnostic } = await import('../src/music/show-candidates.js');
const { showNoRepeatGuard } = await import('../src/music/show-recency.js');
const tracks = [1199, 1200, 1201, 2700].map((duration, i) => ({ id: `t${i}`, title: `Track ${i}`, artist: `Artist ${i}`, duration }));

test('discovery, diagnostics and strict rotation share the eligible universe', () => {
  const scope = pickerScope({ maxTrackSec: 1200 });
  assert.deepEqual(buildPickerContext(scope).collect(tracks).map((t: any) => t.id).sort(), ['t0', 't1']);
  assert.equal(buildPickerContext(pickerScope()).collect(tracks).length, 4, 'request scope is unconstrained');
  const diagnostic = buildShowCandidateDiagnostic({ show: null, libraryRows: tracks, playlistRows: null, excludedIds: null, locks: { genres: [], eras: [], moods: [], energies: [], vocals: null }, maxTrackSec: 1200 });
  assert.equal(diagnostic.library.effective, 2);
  assert.equal(showNoRepeatGuard(10, 4, { show: { playlistStrict: true, playlistExhaust: true }, playlistTracks: tracks, excludedIds: null, maxTrackSec: 1200 }).window, 0);
});

const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
const { readFileSync, existsSync, mkdirSync } = await import('node:fs');
const { dirname } = await import('node:path');

test('queue refuses automatic long tracks, revalidates unsent items and preserves requests', async () => {
  await settings.update({ maxTrackSeconds: 1200, maxTrackLengthMode: 'exclude', loudness: { source: 'measured' } });
  queue.upcoming = [];
  assert.equal(await queue.push({ track: tracks[2] }), -1);
  queue.upcoming = [{ track: tracks[3], requestedBy: null, sent: false, introScript: 'Must not air' } as any];
  await queue.drainToLiquidsoap(true);
  assert.equal(queue.upcoming.length, 0);
  assert.equal(existsSync(config.liquidsoap.queueFile), false);
  mkdirSync(dirname(config.liquidsoap.queueFile), { recursive: true });
  queue.upcoming = [{ track: tracks[3], requestedBy: 'studio', sent: false } as any];
  await queue.drainToLiquidsoap(true);
  assert.equal(queue.upcoming[0].sent, true);
  assert.ok(!readFileSync(config.liquidsoap.queueFile, 'utf8').includes('liq_cue_out'));
});

test('backup pool rejects over-limit entries before bounded intake and never-starve rescue', async () => {
  const { createPoolBuilder } = await import('../src/broadcast/auto-pool.js');
  const builder = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 1, maxPerArtist: 3, selectionMaxSec: 1200 });
  builder.take('random', [tracks[3], tracks[1]], 1, { neverStarve: true });
  assert.deepEqual(builder.pool.map(t => t.id), ['t1']);
  const empty = createPoolBuilder({ recentIds: new Set(['t3']), recentKeys: new Set(), targetPool: 1, maxPerArtist: 3, selectionMaxSec: 1200 });
  empty.take('random', [tracks[3]], 1, { neverStarve: true });
  assert.deepEqual(empty.pool, []);
});

test('live exclusion during intro render drops the track and its linked WAV, but sent items remain', async () => {
  const { writeSilentWav } = await import('../src/audio/wav-silence.js');
  const { rmSync } = await import('node:fs');
  rmSync(config.liquidsoap.queueFile, { force: true });
  await settings.update({ maxTrackLengthMode: 'cut', tts: { enabled: true }, loudness: { source: 'measured' } });
  const sent = { track: tracks[3], sent: true } as any;
  const pending = { track: tracks[2], sent: false, introScript: 'Optional link', introLabelChecked: true } as any;
  queue.upcoming = [sent, pending];
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const wav = join(process.env.STATE_DIR!, 'pending-link.wav');
  const speak = queue._speak;
  queue._speak = async () => {
    started();
    await blocked;
    await writeSilentWav(wav, 100);
    return wav;
  };
  try {
    const drain = queue.drainToLiquidsoap(true);
    await entered;
    await settings.update({ maxTrackLengthMode: 'exclude' });
    release();
    await drain;
    assert.deepEqual(queue.upcoming, [sent]);
    assert.equal(existsSync(wav), false);
    assert.equal(existsSync(config.liquidsoap.queueFile), false);
  } finally {
    queue._speak = speak;
  }
});

test('slim aliases and available library duration do not masquerade as unknown', async () => {
  const db = await import('../src/music/library-db.js');
  const { knownTrackLengthSeconds, aboveKnownTrackCeiling } = await import('../src/music/track-duration.js');
  const library = await import('../src/music/library.js');
  await library.load();
  db.upsertTrackMeta('measured-long', { title: 'Measured', artist: 'Artist', duration: 2700 });
  assert.equal(knownTrackLengthSeconds({ duration: 0, duration_sec: 1201 }), 1201);
  assert.equal(aboveKnownTrackCeiling({ id: 'measured-long', duration: -1 }, 1200), true);
});

test('exclude removes cap-derived washout without changing intentional cut mode', async () => {
  const personas = settings.get().personas.map((p: any, i: number) => i === 0 ? { ...p, djMode: true } : p);
  await settings.update({ maxTrackSeconds: 1200, maxTrackLengthMode: 'cut', personas });
  const capped = { track: { id: 'cap-exit', title: 'Cap exit', artist: 'Artist', duration: 2700, bpm: 120 }, sent: false } as any;
  queue.current = { track: { id: 'on-air', title: 'On air', artist: 'Other', duration: 300 } } as any;
  queue.upcoming = [capped];
  queue.applyMixTransition(capped);
  assert.equal(capped.track.washoutAuto, true);
  await settings.update({ maxTrackLengthMode: 'exclude' });
  const uncapped = { track: { id: 'exclude-exit', title: 'Uncapped', artist: 'Artist', duration: 2700, bpm: 120 }, sent: false } as any;
  queue.upcoming = [uncapped];
  queue.applyMixTransition(uncapped);
  assert.equal(uncapped.track.washoutAuto, undefined);
});
