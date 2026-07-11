// @ts-nocheck -- Executed directly by Node with type stripping.
import assert from 'node:assert/strict';
import {
  FORMAT_OPTIONS, availabilityFor, resolveFormatPreference,
  fallbackForLoadRejection, shouldApplyHydratedPreference,
  resolveHydratedPreference,
  streamPreferenceKey, streamUrlFor, type StreamUrls,
} from '../src/lib/audioFormat.ts';
import { createApi } from '../src/lib/api.ts';
import {
  createFirstTuneReadiness,
  createLatestLoadCoordinator,
} from '../src/lib/audioFormatCoordinator.ts';

const enabled = { mp3: true, opus: true, aac: true, flac: true } as const;
const urls: StreamUrls = {
  mp3: 'https://radio.test/stream.mp3',
  opus: 'https://radio.test/stream.opus',
  aac: 'https://radio.test/stream.aac',
  flac: 'https://radio.test/stream.flac',
};
assert.deepEqual(FORMAT_OPTIONS.map((f) => f.id), ['mp3', 'opus', 'aac', 'flac']);
for (const platform of ['ios', 'android'] as const) {
  const a = availabilityFor(platform, enabled, new Set());
  assert.equal(a.mp3.available, true);
  assert.equal(a.aac.available, true);
  assert.deepEqual(a.opus, { available: false, reason: 'device' });
  assert.deepEqual(a.flac, { available: false, reason: 'device' });
}
assert.equal(availabilityFor('ios', { ...enabled, aac: false }, new Set()).aac.reason, 'station');
for (const platform of ['ios', 'android'] as const) {
  const disabled = { ...enabled, opus: false, flac: false };
  assert.equal(availabilityFor(platform, disabled, new Set()).opus.reason, 'device');
  assert.equal(availabilityFor(platform, disabled, new Set()).flac.reason, 'device');
}
assert.equal(availabilityFor('ios', enabled, new Set(['aac'])).aac.reason, 'failed');
assert.equal(resolveFormatPreference('aac', availabilityFor('ios', enabled, new Set())), 'aac');
assert.equal(resolveFormatPreference('opus', availabilityFor('ios', enabled, new Set())), 'mp3');
assert.equal(streamPreferenceKey('https://RADIO.test/'), 'subwave.audio-format.v1:https://radio.test');
const canonicalPreferenceKey = 'subwave.audio-format.v1:https://radio.test';
for (const base of [
  'radio.test',
  ' https://RADIO.test/ ',
  'https://radio.test/listen/path?source=app#player',
  'https://listener:secret@radio.test:443/private',
]) {
  assert.equal(streamPreferenceKey(base), canonicalPreferenceKey);
}
const credentialedKey = streamPreferenceKey('https://listener:secret@radio.test/private');
assert.equal(credentialedKey.includes('listener'), false);
assert.equal(credentialedKey.includes('secret'), false);
assert.equal(credentialedKey.includes('/private'), false);
assert.equal(streamUrlFor(urls, 'flac'), 'https://radio.test/stream.flac');
const api = createApi('https://user:pass@Radio.Test/');
assert.deepEqual(api.streamUrls(), {
  mp3: 'https://Radio.Test/stream.mp3',
  opus: 'https://Radio.Test/stream.opus',
  aac: 'https://Radio.Test/stream.aac',
  flac: 'https://Radio.Test/stream.flac',
});
assert.ok(api.streamHeaders()?.Authorization?.startsWith('Basic '));
assert.deepEqual(
  fallbackForLoadRejection('aac', 4, 4, 'https://a.test', 'https://a.test', true),
  { fallback: 'mp3', failed: 'aac' },
);
assert.equal(fallbackForLoadRejection('aac', 3, 4, 'https://a.test', 'https://a.test', true), null);
assert.equal(fallbackForLoadRejection('aac', 4, 4, 'https://a.test', 'https://b.test', true), null);
assert.equal(fallbackForLoadRejection('aac', 4, 4, 'https://a.test', 'https://a.test', false), null);
assert.equal(fallbackForLoadRejection('mp3', 4, 4, 'https://a.test', 'https://a.test', true), null);
assert.equal(shouldApplyHydratedPreference('https://a.test', 'https://a.test', 2, 2), true);
assert.equal(shouldApplyHydratedPreference('https://a.test', 'https://b.test', 2, 2), false);
assert.equal(shouldApplyHydratedPreference('https://a.test', 'https://a.test', 1, 2), false);
const iosAvailability = availabilityFor('ios', enabled, new Set());
assert.equal(resolveHydratedPreference('aac', iosAvailability, false, 2, 2), null);
assert.equal(resolveHydratedPreference('aac', iosAvailability, true, 2, 2), 'aac');
assert.equal(resolveHydratedPreference('aac', iosAvailability, true, 1, 2), null);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// First tune waits for both preference storage and the first authoritative
// stream-capability payload, so a valid stored AAC is the first native target.
{
  const readiness = createFirstTuneReadiness('https://a.test', 1000);
  readiness.resolveStorage('aac');
  let settled = false;
  const target = readiness.wait('ios').then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  readiness.resolveCapabilities(enabled);
  assert.equal(await target, 'aac');
}

// Legacy stations that never advertise `stream` cannot hold tune forever.
{
  const readiness = createFirstTuneReadiness('https://legacy.test', 5);
  readiness.resolveStorage('aac');
  assert.equal(await readiness.wait('ios'), 'mp3');
}

// An explicit choice made while readiness is pending owns the first tune.
{
  const readiness = createFirstTuneReadiness('https://a.test', 1000);
  readiness.resolveStorage('aac');
  const target = readiness.wait('ios');
  readiness.select('mp3');
  readiness.resolveCapabilities(enabled);
  assert.equal(await target, 'mp3');
}

// Station invalidation prevents an old readiness result from tuning the new station.
{
  const readiness = createFirstTuneReadiness('https://a.test', 1000);
  const target = readiness.wait('ios');
  readiness.invalidate();
  readiness.resolveStorage('aac');
  readiness.resolveCapabilities(enabled);
  assert.equal(await target, null);
}

// Native loads are serialized and pending requests coalesce to the latest.
{
  const first = deferred<void>();
  const second = deferred<void>();
  const started: string[] = [];
  const coordinator = createLatestLoadCoordinator(async (value: string) => {
    started.push(value);
    await (value === 'aac' ? first.promise : second.promise);
  });
  const aac = coordinator.request('aac');
  const mp3 = coordinator.request('mp3');
  const latest = coordinator.request('aac-latest');
  await Promise.resolve();
  assert.deepEqual(started, ['aac']);
  first.resolve();
  assert.equal((await aac).status, 'superseded');
  assert.equal((await mp3).status, 'superseded');
  await Promise.resolve();
  assert.deepEqual(started, ['aac', 'aac-latest']);
  second.resolve();
  assert.equal((await latest).status, 'applied');
}

// A stale rejection is owned by its request and cannot reject the latest load.
{
  const stale = deferred<void>();
  const current = deferred<void>();
  const coordinator = createLatestLoadCoordinator(async (value: string) => {
    await (value === 'old' ? stale.promise : current.promise);
  });
  const old = coordinator.request('old');
  const next = coordinator.request('next');
  stale.reject(new Error('old failed'));
  assert.equal((await old).status, 'superseded');
  current.resolve();
  assert.equal((await next).status, 'applied');
}

// Stop/base invalidation makes both an active success and queued work stale.
{
  const active = deferred<void>();
  const coordinator = createLatestLoadCoordinator(async () => { await active.promise; });
  const first = coordinator.request('aac');
  const queued = coordinator.request('mp3');
  coordinator.invalidate();
  active.resolve();
  assert.equal((await first).status, 'superseded');
  assert.equal((await queued).status, 'superseded');
}

// A watchdog reconnect uses the retained selected format, not an MP3 default.
{
  const started: string[] = [];
  const coordinator = createLatestLoadCoordinator(async (format: string) => {
    started.push(format);
  });
  let selected = 'aac';
  assert.equal((await coordinator.request(selected)).status, 'applied');
  assert.equal((await coordinator.request(selected)).status, 'applied');
  selected = 'mp3';
  assert.deepEqual(started, ['aac', 'aac']);
}
console.log('audio-format tests passed');
